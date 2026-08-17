import type {
  MultiplayerClientMessage,
  MultiplayerConnectionState,
  MultiplayerTransportErrorCode,
} from '../shared/multiplayer-contracts.js';
import {
  isMultiplayerTransportErrorCode,
  MULTIPLAYER_PROTOCOL_VERSION,
  sameMultiplayerModeIdentity,
} from '../shared/multiplayer-contracts.js';
import {
  encodeMultiplayerClientMessage,
  parseMultiplayerServerWireMessage,
} from '../shared/multiplayer-messages.js';
import type {
  MultiplayerSessionTransport,
} from '../app/multiplayer-session-controller.js';
import type { MultiplayerAdmission } from './multiplayer-api-client.js';

const RECONNECT_DELAYS_MS = [250, 500, 1_000, 2_000, 5_000] as const;

// Application-level ping cadence and its answer deadline. The browser
// WebSocket API cannot send or observe the protocol-level ping/pong frames
// the server heartbeat uses, so latency is measured with these messages
// instead. An unanswered ping is how a silently-dead connection (one the
// server hasn't terminated yet) becomes visible client-side.
const DIAGNOSTIC_PING_INTERVAL_MS = 5_000;
const DIAGNOSTIC_PING_TIMEOUT_MS = 10_000;

export type MultiplayerTransportError = MultiplayerTransportErrorCode;

/** Lightweight, UI-ready snapshot of the connection's live health. */
export interface MultiplayerConnectionDiagnostics {
  /** Latest measured round-trip latency, or null until the first pong. */
  readonly rttMs: number | null;
  /** Total unexpected disconnects this session (excludes clean client closes). */
  readonly reconnects: number;
  /** Client clock reading when the last server message arrived, or null. */
  readonly lastMessageAt: number | null;
  /** Client clock reading when the connection last authenticated, or null. */
  readonly connectedAt: number | null;
  /** True when a ping has gone unanswered past its deadline (a drop in progress). */
  readonly stale: boolean;
}

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
  // This transport serves both modes, so diagnostics use the admitted mode id.
  private readonly logTag: string;
  private readonly messageListeners = new Set<(message: unknown) => void>();
  private readonly connectionListeners = new Set<
    (state: MultiplayerConnectionState) => void
  >();
  private readonly errorListeners = new Set<
    (error: MultiplayerTransportError) => void
  >();
  private readonly diagnosticsListeners = new Set<
    (diagnostics: MultiplayerConnectionDiagnostics) => void
  >();
  // Only 'set-ready' is retained while unauthenticated/reconnecting, and
  // coalesced to its latest value — every other message type (gameplay,
  // pause, forfeit, Score Race progress/resume, and chat) is dropped outright
  // rather than queued, since a stale copy replayed later can never be valid.
  // Controllers already re-emit what they need once `connected` fires. Chat
  // is intentionally ephemeral, so losing a message sent mid-reconnect is the
  // expected behavior, not a gap.
  private queuedReadiness: MultiplayerClientMessage | null = null;
  private socket: WebSocket | null = null;
  private state: MultiplayerConnectionState = 'reconnecting';
  private authenticated = false;
  private reconnectAttempt = 0;
  private reconnectTimer: number | null = null;
  private terminal = false;
  // Connection-health diagnostics, updated as traffic and the ping loop
  // produce observations. Subscribers get the latest snapshot immediately.
  private pingTimer: number | null = null;
  private nextPingNonce = 0;
  private pingPending: { readonly nonce: number; readonly sentAt: number } | null = null;
  private rttMs: number | null = null;
  private reconnects = 0;
  private lastMessageAt: number | null = null;
  private connectedAt: number | null = null;
  private stale = false;

  constructor(apiBaseUrl: string, admission: MultiplayerAdmission) {
    this.url = websocketUrl(apiBaseUrl);
    this.admission = admission;
    this.logTag = `[${admission.mode.id}]`;
    this.connect();
  }

  send(message: MultiplayerClientMessage): void {
    if (this.terminal) return;
    if (this.socket?.readyState === WebSocket.OPEN && this.authenticated) {
      this.socket.send(JSON.stringify(encodeMultiplayerClientMessage(message)));
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

  get diagnostics(): MultiplayerConnectionDiagnostics {
    return {
      rttMs: this.rttMs,
      reconnects: this.reconnects,
      lastMessageAt: this.lastMessageAt,
      connectedAt: this.connectedAt,
      stale: this.stale,
    };
  }

  subscribeDiagnostics(
    listener: (diagnostics: MultiplayerConnectionDiagnostics) => void,
  ): () => void {
    this.diagnosticsListeners.add(listener);
    listener(this.diagnostics);
    return () => this.diagnosticsListeners.delete(listener);
  }

  destroy(): void {
    this.terminal = true;
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.stopPingLoop();
    this.socket?.close(1000, 'Client closed');
    this.socket = null;
    this.messageListeners.clear();
    this.connectionListeners.clear();
    this.errorListeners.clear();
    this.diagnosticsListeners.clear();
    this.queuedReadiness = null;
  }

  private connect(): void {
    if (this.terminal) return;
    this.authenticated = false;
    this.setState('reconnecting');
    console.log(`${this.logTag} transport connecting`);
    const socket = new WebSocket(this.url);
    this.socket = socket;

    socket.addEventListener('open', () => {
      if (this.socket !== socket || this.terminal) return;
      console.log(`${this.logTag} transport socket open, sending credentials`);
      socket.send(JSON.stringify({
        protocolVersion: MULTIPLAYER_PROTOCOL_VERSION,
        authenticate: {
          roomId: this.admission.roomId,
          playerId: this.admission.playerId,
          reconnectCredential: this.admission.reconnectCredential,
        },
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

      const parsed = parseMultiplayerServerWireMessage(raw);
      if (!parsed.ok) {
        if (!this.authenticated) {
          this.failAuthentication(socket, parsed.error);
        } else {
          // Controllers own the user-facing compatibility state. Forward the
          // malformed value so they can retain the offending payload in their
          // diagnostics just as they did before the wire envelope was added.
          for (const listener of this.messageListeners) listener(raw);
        }
        return;
      }

      if (!this.authenticated) {
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
        this.lastMessageAt = Date.now();
        this.connectedAt = this.lastMessageAt;
        this.setState('connected');
        this.startPingLoop();
        console.log(`${this.logTag} transport authenticated`);
        for (const listener of this.messageListeners) listener(parsed.message);
        this.flushReadiness(socket);
        this.emitDiagnostics();
        return;
      }

      this.lastMessageAt = Date.now();
      // pong is transport machinery, not gameplay — resolve the round-trip
      // here and never forward it to the controllers (which would otherwise
      // treat the unfamiliar event as a compatibility failure).
      if (parsed.message.type === 'pong') {
        this.handlePong(parsed.message.nonce);
        return;
      }

      for (const listener of this.messageListeners) listener(parsed.message);
      this.emitDiagnostics();
    });

    socket.addEventListener('close', event => {
      if (this.socket !== socket) return;
      // The code/reason distinguish a clean client-initiated close (1000),
      // an explicit server rejection (1008, 4001 "Connection replaced"),
      // and an abrupt drop with no code — that last case is what a
      // server-side heartbeat terminate() or a genuine network failure
      // both look like from here.
      console.warn(
        `${this.logTag} transport socket closed (code=${event.code} reason="${event.reason}" wasClean=${event.wasClean})`,
      );
      this.socket = null;
      this.authenticated = false;
      this.stopPingLoop();
      this.rttMs = null;
      this.lastMessageAt = null;
      this.connectedAt = null;
      this.stale = false;
      if (this.terminal || event.code === 1000) {
        this.setState('disconnected');
        this.emitDiagnostics();
        return;
      }
      this.reconnects++;
      this.setState('disconnected');
      this.emitDiagnostics();
      this.scheduleReconnect();
    });
  }

  private failAuthentication(socket: WebSocket, error: MultiplayerTransportError): void {
    console.error(`${this.logTag} transport authentication failed: ${error}`);
    this.terminal = true;
    for (const listener of this.errorListeners) listener(error);
    socket.close(1008, error);
  }

  private flushReadiness(socket: WebSocket): void {
    if (!this.queuedReadiness) return;
    const message = this.queuedReadiness;
    this.queuedReadiness = null;
    socket.send(JSON.stringify(encodeMultiplayerClientMessage(message)));
  }

  private scheduleReconnect(): void {
    if (this.terminal || this.reconnectTimer !== null) return;
    const delay = RECONNECT_DELAYS_MS[
      Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)
    ] ?? RECONNECT_DELAYS_MS[RECONNECT_DELAYS_MS.length - 1];
    this.reconnectAttempt++;
    console.log(`${this.logTag} transport reconnecting in ${delay}ms (attempt ${this.reconnectAttempt})`);
    this.setState('reconnecting');
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private setState(state: MultiplayerConnectionState): void {
    if (state === this.state) return;
    console.log(`${this.logTag} transport connection state: ${this.state} -> ${state}`);
    this.state = state;
    for (const listener of this.connectionListeners) listener(state);
  }

  private startPingLoop(): void {
    this.stopPingLoop();
    this.pingTimer = window.setInterval(() => this.pingTick(), DIAGNOSTIC_PING_INTERVAL_MS);
  }

  private stopPingLoop(): void {
    if (this.pingTimer !== null) window.clearInterval(this.pingTimer);
    this.pingTimer = null;
    this.pingPending = null;
  }

  private pingTick(): void {
    if (this.terminal || !this.authenticated) return;
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    const now = Date.now();
    if (this.pingPending) {
      // A previous ping is still outstanding. Only flag the connection stale
      // once it misses its deadline, then clear the pending probe so the next
      // tick sends a fresh one — keeping the line probed rather than giving up
      // after a single lost reply.
      if (now - this.pingPending.sentAt >= DIAGNOSTIC_PING_TIMEOUT_MS) {
        console.warn(`${this.logTag} transport ping unanswered for ${DIAGNOSTIC_PING_TIMEOUT_MS}ms — connection stale`);
        this.pingPending = null;
        this.setStale(true);
      }
      return;
    }
    const nonce = this.nextPingNonce++;
    this.pingPending = { nonce, sentAt: now };
    socket.send(JSON.stringify(encodeMultiplayerClientMessage({
      protocolVersion: MULTIPLAYER_PROTOCOL_VERSION,
      roomId: this.admission.roomId,
      playerId: this.admission.playerId,
      type: 'ping',
      nonce,
    })));
  }

  private handlePong(nonce: number): void {
    if (this.pingPending && this.pingPending.nonce === nonce) {
      this.rttMs = Date.now() - this.pingPending.sentAt;
      this.pingPending = null;
      console.debug(`${this.logTag} transport ping round-trip: ${this.rttMs}ms`);
    }
    this.setStale(false);
    this.emitDiagnostics();
  }

  private setStale(stale: boolean): void {
    if (stale === this.stale) return;
    this.stale = stale;
    this.emitDiagnostics();
  }

  private emitDiagnostics(): void {
    const diagnostics = this.diagnostics;
    for (const listener of this.diagnosticsListeners) listener(diagnostics);
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
    && isMultiplayerTransportErrorCode(record.error);
}
