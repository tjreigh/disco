import type {
  MultiplayerClientMessage,
  MultiplayerConnectionState,
} from '../shared/multiplayer-contracts.js';
import {
  MULTIPLAYER_PROTOCOL_VERSION,
  sameMultiplayerModeIdentity,
} from '../shared/multiplayer-contracts.js';
import { parseMultiplayerServerMessage } from '../shared/multiplayer-messages.js';
import type {
  MultiplayerSessionTransport,
} from '../app/multiplayer-session-controller.js';
import type { MultiplayerAdmission } from './multiplayer-api-client.js';

const RECONNECT_DELAYS_MS = [250, 500, 1_000, 2_000, 5_000] as const;

export type MultiplayerTransportError =
  | 'invalid-message'
  | 'protocol-mismatch'
  | 'mode-mismatch'
  | 'room-not-found'
  | 'room-full'
  | 'invalid-credential'
  | 'stale-connection'
  | 'invalid-state'
  | 'match-mismatch'
  | 'stale-progress'
  | 'conflicting-progress'
  | 'non-monotonic-progress';

interface TransportErrorMessage {
  readonly type: 'room-transport-error';
  readonly error: MultiplayerTransportError;
}

/**
 * Browser connection for one admitted room player.
 *
 * Protocol messages queue until the first-frame credential exchange succeeds.
 * Unexpected disconnects reconnect with a bounded delay; explicit server errors
 * are terminal and surface separately from protocol compatibility errors.
 */
export class WebSocketMultiplayerTransport implements MultiplayerSessionTransport {
  private readonly url: string;
  private readonly admission: MultiplayerAdmission;
  private readonly messageListeners = new Set<(message: unknown) => void>();
  private readonly connectionListeners = new Set<
    (state: MultiplayerConnectionState) => void
  >();
  private readonly errorListeners = new Set<
    (error: MultiplayerTransportError) => void
  >();
  // Only 'set-ready' is retained while unauthenticated/reconnecting, and
  // coalesced to its latest value — every other message type (gameplay,
  // pause, forfeit, Score Race progress/resume) is dropped outright rather
  // than queued, since a stale copy replayed later can never be valid.
  // Controllers already re-emit what they need once `connected` fires.
  private queuedReadiness: MultiplayerClientMessage | null = null;
  private socket: WebSocket | null = null;
  private state: MultiplayerConnectionState = 'reconnecting';
  private authenticated = false;
  private reconnectAttempt = 0;
  private reconnectTimer: number | null = null;
  private terminal = false;

  constructor(apiBaseUrl: string, admission: MultiplayerAdmission) {
    this.url = websocketUrl(apiBaseUrl);
    this.admission = admission;
    this.connect();
  }

  send(message: MultiplayerClientMessage): void {
    if (this.terminal) return;
    if (this.socket?.readyState === WebSocket.OPEN && this.authenticated) {
      this.socket.send(JSON.stringify(message));
      return;
    }
    if (message.type !== 'set-ready') return;
    this.queuedReadiness = message;
  }

  subscribe(listener: (message: unknown) => void): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  subscribeConnection(
    listener: (state: MultiplayerConnectionState) => void,
  ): () => void {
    this.connectionListeners.add(listener);
    listener(this.state);
    return () => this.connectionListeners.delete(listener);
  }

  subscribeError(listener: (error: MultiplayerTransportError) => void): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  destroy(): void {
    this.terminal = true;
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.socket?.close(1000, 'Client closed');
    this.socket = null;
    this.messageListeners.clear();
    this.connectionListeners.clear();
    this.errorListeners.clear();
    this.queuedReadiness = null;
  }

  private connect(): void {
    if (this.terminal) return;
    this.authenticated = false;
    this.setState('reconnecting');
    console.log('[shared-duel] transport connecting');
    const socket = new WebSocket(this.url);
    this.socket = socket;

    socket.addEventListener('open', () => {
      if (this.socket !== socket || this.terminal) return;
      console.log('[shared-duel] transport socket open, sending credentials');
      socket.send(JSON.stringify({
        type: 'authenticate-room',
        protocolVersion: MULTIPLAYER_PROTOCOL_VERSION,
        roomId: this.admission.roomId,
        playerId: this.admission.playerId,
        reconnectCredential: this.admission.reconnectCredential,
      }));
      this.reconnectAttempt = 0;
      // Socket open only means the network connection exists — state stays
      // 'reconnecting' until the server's first matching snapshot proves the
      // credential was actually accepted (see the 'message' listener below).
    });

    socket.addEventListener('message', event => {
      if (this.socket !== socket || this.terminal) return;
      const raw = parseJson(event.data);
      if (isTransportError(raw)) {
        this.terminal = true;
        for (const listener of this.errorListeners) listener(raw.error);
        socket.close(1008, raw.error);
        return;
      }

      if (!this.authenticated) {
        const parsed = parseMultiplayerServerMessage(raw);
        if (!parsed.ok) {
          this.failAuthentication(socket, parsed.error);
          return;
        }
        if (parsed.message.roomId !== this.admission.roomId) {
          this.failAuthentication(socket, 'room-not-found');
          return;
        }
        if (!sameMultiplayerModeIdentity(parsed.message.mode, this.admission.mode)) {
          this.failAuthentication(socket, 'mode-mismatch');
          return;
        }
        // Entire sequence runs synchronously in this one message event, so
        // no user input or queued send can interleave with it.
        this.authenticated = true;
        this.setState('connected');
        console.log('[shared-duel] transport authenticated');
        for (const listener of this.messageListeners) listener(raw);
        this.flushReadiness(socket);
        return;
      }

      for (const listener of this.messageListeners) listener(raw);
    });

    socket.addEventListener('close', event => {
      if (this.socket !== socket) return;
      // The code/reason distinguish a clean client-initiated close (1000),
      // an explicit server rejection (1008, 4001 "Connection replaced"),
      // and an abrupt drop with no code — that last case is what a
      // server-side heartbeat terminate() or a genuine network failure
      // both look like from here.
      console.warn(
        `[shared-duel] transport socket closed (code=${event.code} reason="${event.reason}" wasClean=${event.wasClean})`,
      );
      this.socket = null;
      this.authenticated = false;
      if (this.terminal || event.code === 1000) {
        this.setState('disconnected');
        return;
      }
      this.setState('disconnected');
      this.scheduleReconnect();
    });
  }

  private failAuthentication(socket: WebSocket, error: MultiplayerTransportError): void {
    console.error(`[shared-duel] transport authentication failed: ${error}`);
    this.terminal = true;
    for (const listener of this.errorListeners) listener(error);
    socket.close(1008, error);
  }

  private flushReadiness(socket: WebSocket): void {
    if (!this.queuedReadiness) return;
    const message = this.queuedReadiness;
    this.queuedReadiness = null;
    socket.send(JSON.stringify(message));
  }

  private scheduleReconnect(): void {
    if (this.terminal || this.reconnectTimer !== null) return;
    const delay = RECONNECT_DELAYS_MS[
      Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)
    ] ?? RECONNECT_DELAYS_MS[RECONNECT_DELAYS_MS.length - 1];
    this.reconnectAttempt++;
    console.log(`[shared-duel] transport reconnecting in ${delay}ms (attempt ${this.reconnectAttempt})`);
    this.setState('reconnecting');
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private setState(state: MultiplayerConnectionState): void {
    if (state === this.state) return;
    console.log(`[shared-duel] transport connection state: ${this.state} -> ${state}`);
    this.state = state;
    for (const listener of this.connectionListeners) listener(state);
  }
}

function websocketUrl(apiBaseUrl: string): string {
  const url = new URL('/multiplayer/socket', apiBaseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function isTransportError(value: unknown): value is TransportErrorMessage {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 2
    && record.type === 'room-transport-error'
    && isMultiplayerTransportError(record.error);
}

function isMultiplayerTransportError(value: unknown): value is MultiplayerTransportError {
  switch (value) {
    case 'invalid-message':
    case 'protocol-mismatch':
    case 'mode-mismatch':
    case 'room-not-found':
    case 'room-full':
    case 'invalid-credential':
    case 'stale-connection':
    case 'invalid-state':
    case 'match-mismatch':
    case 'stale-progress':
    case 'conflicting-progress':
    case 'non-monotonic-progress':
      return true;
    default:
      return false;
  }
}
