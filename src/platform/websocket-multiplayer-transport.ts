import type {
  MultiplayerClientMessage,
  MultiplayerConnectionState,
} from '../shared/multiplayer-contracts.js';
import { MULTIPLAYER_PROTOCOL_VERSION } from '../shared/multiplayer-contracts.js';
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
  private readonly queuedMessages: MultiplayerClientMessage[] = [];
  private socket: WebSocket | null = null;
  private state: MultiplayerConnectionState = 'reconnecting';
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
    if (this.socket?.readyState === WebSocket.OPEN && this.state === 'connected') {
      this.socket.send(JSON.stringify(message));
      return;
    }
    this.queuedMessages.push(message);
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
    this.queuedMessages.length = 0;
  }

  private connect(): void {
    if (this.terminal) return;
    this.setState('reconnecting');
    const socket = new WebSocket(this.url);
    this.socket = socket;

    socket.addEventListener('open', () => {
      if (this.socket !== socket || this.terminal) return;
      socket.send(JSON.stringify({
        type: 'authenticate-room',
        protocolVersion: MULTIPLAYER_PROTOCOL_VERSION,
        roomId: this.admission.roomId,
        playerId: this.admission.playerId,
        reconnectCredential: this.admission.reconnectCredential,
      }));
      this.reconnectAttempt = 0;
      this.setState('connected');
      for (const message of this.queuedMessages.splice(0)) {
        socket.send(JSON.stringify(message));
      }
    });

    socket.addEventListener('message', event => {
      if (this.socket !== socket || this.terminal) return;
      const message = parseJson(event.data);
      if (isTransportError(message)) {
        this.terminal = true;
        for (const listener of this.errorListeners) listener(message.error);
        socket.close(1008, message.error);
        return;
      }
      for (const listener of this.messageListeners) listener(message);
    });

    socket.addEventListener('close', event => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (this.terminal || event.code === 1000) {
        this.setState('disconnected');
        return;
      }
      this.setState('disconnected');
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.terminal || this.reconnectTimer !== null) return;
    const delay = RECONNECT_DELAYS_MS[
      Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)
    ] ?? RECONNECT_DELAYS_MS[RECONNECT_DELAYS_MS.length - 1];
    this.reconnectAttempt++;
    this.setState('reconnecting');
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private setState(state: MultiplayerConnectionState): void {
    if (state === this.state) return;
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
