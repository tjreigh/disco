// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { WebSocketMultiplayerTransport } from '../../platform/websocket-multiplayer-transport.js';
import type { MultiplayerTransportError } from '../../platform/websocket-multiplayer-transport.js';
import { SHARED_DUEL_MODE } from '../../game/modes/index.js';
import {
  multiplayerModeIdentity,
  MULTIPLAYER_PROTOCOL_VERSION,
} from '../../shared/multiplayer-contracts.js';
import type { MultiplayerConnectionState } from '../../shared/multiplayer-contracts.js';
import type { MultiplayerAdmission } from '../../platform/multiplayer-api-client.js';

type Listener = (event: unknown) => void;

/** Fully controllable stand-in for the browser WebSocket used by the transport under test. */
class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readonly OPEN = FakeWebSocket.OPEN;
  readyState = FakeWebSocket.CONNECTING;
  readonly sent: string[] = [];
  readonly closeCalls: Array<{ code: number | undefined; reason: string | undefined }> = [];
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: Listener): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
    this.readyState = FakeWebSocket.CLOSED;
  }

  simulateOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.emit('open', {});
  }

  simulateMessage(data: unknown): void {
    this.emit('message', { data: typeof data === 'string' ? data : JSON.stringify(data) });
  }

  /** Simulates the socket closing out from under the transport (server-initiated, network drop, etc). */
  simulateAbnormalClose(code = 1006): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit('close', { code });
  }

  private emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

const mode = multiplayerModeIdentity(SHARED_DUEL_MODE);
const admission: MultiplayerAdmission = {
  roomId: 'ROOM1',
  playerId: 'local-player',
  reconnectCredential: 'secret-credential',
  mode,
};

function firstSocket(): FakeWebSocket {
  const socket = FakeWebSocket.instances[0];
  if (!socket) throw new Error('Expected a WebSocket to have been constructed');
  return socket;
}

function validSnapshot(overrides: Record<string, unknown> = {}) {
  const {
    protocolVersion = MULTIPLAYER_PROTOCOL_VERSION,
    roomId = admission.roomId,
    mode: snapshotMode = mode,
    ...eventOverrides
  } = overrides;
  return {
    protocolVersion,
    room: { id: roomId, mode: snapshotMode },
    event: {
      type: 'room-state',
      localReady: false,
      opponentReady: false,
      opponentJoined: false,
      opponentConnected: false,
      ...eventOverrides,
    },
  };
}

function pongEnvelope(nonce: number) {
  return {
    protocolVersion: MULTIPLAYER_PROTOCOL_VERSION,
    room: { id: admission.roomId, mode },
    event: { type: 'pong', nonce },
  };
}

function connectionStates(transport: WebSocketMultiplayerTransport): MultiplayerConnectionState[] {
  const states: MultiplayerConnectionState[] = [];
  transport.subscribeConnection(state => states.push(state));
  return states;
}

function errors(transport: WebSocketMultiplayerTransport): MultiplayerTransportError[] {
  const found: MultiplayerTransportError[] = [];
  transport.subscribeError(error => found.push(error));
  return found;
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeWebSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('WebSocketMultiplayerTransport authentication readiness', () => {
  test('socket open sends authentication but does not publish connected', () => {
    const transport = new WebSocketMultiplayerTransport('https://api.example.test', admission);
    const states = connectionStates(transport);
    const socket = firstSocket();

    socket.simulateOpen();

    expect(states.at(-1)).toBe('reconnecting');
    expect(socket.sent).toHaveLength(1);
    expect(JSON.parse(socket.sent[0]!)).toMatchObject({
      protocolVersion: MULTIPLAYER_PROTOCOL_VERSION,
      authenticate: {
        roomId: admission.roomId,
        playerId: admission.playerId,
        reconnectCredential: admission.reconnectCredential,
      },
    });
    transport.destroy();
  });

  test('a valid matching snapshot publishes connected, forwards the message, then flushes queued readiness once', () => {
    const transport = new WebSocketMultiplayerTransport('https://api.example.test', admission);
    const states = connectionStates(transport);
    const messages: unknown[] = [];
    transport.subscribe(message => messages.push(message));
    const socket = firstSocket();
    socket.simulateOpen();

    transport.send({
      protocolVersion: MULTIPLAYER_PROTOCOL_VERSION,
      roomId: admission.roomId,
      playerId: admission.playerId,
      type: 'set-ready',
      ready: true,
    });
    // Queued, not sent yet — only the authentication frame has gone out.
    expect(socket.sent).toHaveLength(1);

    const snapshot = validSnapshot();
    socket.simulateMessage(snapshot);

    expect(states.at(-1)).toBe('connected');
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({
      protocolVersion: MULTIPLAYER_PROTOCOL_VERSION,
      roomId: admission.roomId,
      mode,
      type: 'room-state',
      localReady: false,
      opponentReady: false,
      opponentJoined: false,
      opponentConnected: false,
    });
    // The coalesced set-ready flushes right after, and only once.
    expect(socket.sent).toHaveLength(2);
    expect(JSON.parse(socket.sent[1]!)).toMatchObject({
      command: { type: 'set-ready', ready: true },
    });

    // A second, unrelated message must not re-flush anything.
    socket.simulateMessage(validSnapshot({ localReady: true }));
    expect(socket.sent).toHaveLength(2);
    transport.destroy();
  });

  test('malformed JSON does not authenticate', () => {
    const transport = new WebSocketMultiplayerTransport('https://api.example.test', admission);
    const states = connectionStates(transport);
    const socket = firstSocket();
    socket.simulateOpen();
    socket.simulateMessage('not json{{{');

    expect(states.at(-1)).toBe('reconnecting');
    transport.destroy();
  });

  test('a wrong-room snapshot never authenticates or flushes, and closes as a terminal error', () => {
    const transport = new WebSocketMultiplayerTransport('https://api.example.test', admission);
    const states = connectionStates(transport);
    const seenErrors = errors(transport);
    const socket = firstSocket();
    socket.simulateOpen();
    socket.simulateMessage(validSnapshot({ roomId: 'SOME-OTHER-ROOM' }));

    expect(states).not.toContain('connected');
    expect(seenErrors).toEqual(['room-not-found']);
    expect(socket.closeCalls).toHaveLength(1);
    transport.destroy();
  });

  test('a wrong-mode snapshot never authenticates or flushes, and closes as a terminal error', () => {
    const transport = new WebSocketMultiplayerTransport('https://api.example.test', admission);
    const states = connectionStates(transport);
    const seenErrors = errors(transport);
    const socket = firstSocket();
    socket.simulateOpen();
    socket.simulateMessage(validSnapshot({
      mode: { ...mode, version: mode.version + 1 },
    }));

    expect(states).not.toContain('connected');
    expect(seenErrors).toEqual(['mode-mismatch']);
    expect(socket.closeCalls).toHaveLength(1);
    transport.destroy();
  });

  test('a protocol-version mismatch on the first message never authenticates', () => {
    const transport = new WebSocketMultiplayerTransport('https://api.example.test', admission);
    const states = connectionStates(transport);
    const seenErrors = errors(transport);
    const socket = firstSocket();
    socket.simulateOpen();
    socket.simulateMessage(validSnapshot({ protocolVersion: MULTIPLAYER_PROTOCOL_VERSION + 1 }));

    expect(states).not.toContain('connected');
    expect(seenErrors).toEqual(['protocol-mismatch']);
    transport.destroy();
  });

  test('an explicit room-transport-error frame is terminal before authentication', () => {
    const transport = new WebSocketMultiplayerTransport('https://api.example.test', admission);
    const seenErrors = errors(transport);
    const socket = firstSocket();
    socket.simulateOpen();
    socket.simulateMessage({ type: 'room-transport-error', error: 'invalid-credential' });

    expect(seenErrors).toEqual(['invalid-credential']);
    expect(socket.closeCalls).toHaveLength(1);
    transport.destroy();
  });

  test('an explicit room-transport-error frame is also terminal after authentication', () => {
    const transport = new WebSocketMultiplayerTransport('https://api.example.test', admission);
    const states = connectionStates(transport);
    const seenErrors = errors(transport);
    const socket = firstSocket();
    socket.simulateOpen();
    socket.simulateMessage(validSnapshot());
    expect(states.at(-1)).toBe('connected');

    socket.simulateMessage({ type: 'room-transport-error', error: 'stale-connection' });
    expect(seenErrors).toEqual(['stale-connection']);
    expect(socket.closeCalls).toHaveLength(1);
    transport.destroy();
  });
});

describe('WebSocketMultiplayerTransport durable queue policy', () => {
  test('gameplay and Score Race progress/resume messages are dropped, not queued, while unauthenticated', () => {
    const transport = new WebSocketMultiplayerTransport('https://api.example.test', admission);
    const socket = firstSocket();
    socket.simulateOpen(); // open, but not yet authenticated

    const envelope = { protocolVersion: MULTIPLAYER_PROTOCOL_VERSION, roomId: admission.roomId, playerId: admission.playerId };
    transport.send({ ...envelope, type: 'play-turn', matchId: 'm1', column: 3 });
    transport.send({ ...envelope, type: 'move-cursor', matchId: 'm1', column: 3 });
    transport.send({ ...envelope, type: 'set-paused', matchId: 'm1', paused: true });
    transport.send({ ...envelope, type: 'forfeit-match', matchId: 'm1' });
    transport.send({ ...envelope, type: 'publish-progress', matchId: 'm1', progress: { sequence: 1, score: 0, turnsPlayed: 0 } });
    transport.send({ ...envelope, type: 'finish-match', matchId: 'm1', progress: { sequence: 1, score: 0, turnsPlayed: 0 } });
    transport.send({ ...envelope, type: 'resume-session', matchId: null, lastProgressSequence: 0 });

    // Only the initial authentication frame has gone out — nothing queued flushes on auth either.
    socket.simulateMessage(validSnapshot());
    expect(socket.sent).toHaveLength(1);
    transport.destroy();
  });

  test('set-ready is coalesced to its latest value while unauthenticated', () => {
    const transport = new WebSocketMultiplayerTransport('https://api.example.test', admission);
    const socket = firstSocket();
    socket.simulateOpen();

    const envelope = { protocolVersion: MULTIPLAYER_PROTOCOL_VERSION, roomId: admission.roomId, playerId: admission.playerId };
    transport.send({ ...envelope, type: 'set-ready', ready: false });
    transport.send({ ...envelope, type: 'set-ready', ready: true });

    socket.simulateMessage(validSnapshot());
    // Authentication + exactly one flushed set-ready (the latest value).
    expect(socket.sent).toHaveLength(2);
    expect(JSON.parse(socket.sent[1]!)).toMatchObject({
      command: { type: 'set-ready', ready: true },
    });
    transport.destroy();
  });

  test('sends go out immediately once authenticated', () => {
    const transport = new WebSocketMultiplayerTransport('https://api.example.test', admission);
    const socket = firstSocket();
    socket.simulateOpen();
    socket.simulateMessage(validSnapshot());

    transport.send({
      protocolVersion: MULTIPLAYER_PROTOCOL_VERSION,
      roomId: admission.roomId,
      playerId: admission.playerId,
      type: 'move-cursor',
      matchId: 'm1',
      column: 4,
    });
    expect(socket.sent).toHaveLength(2);
    expect(JSON.parse(socket.sent[1]!)).toMatchObject({
      command: { type: 'move-cursor', column: 4 },
    });
    transport.destroy();
  });
});

describe('WebSocketMultiplayerTransport reconnection', () => {
  test('old socket events after replacement are ignored', () => {
    vi.useFakeTimers();
    const transport = new WebSocketMultiplayerTransport('https://api.example.test', admission);
    const states = connectionStates(transport);
    const messages: unknown[] = [];
    transport.subscribe(message => messages.push(message));

    const first = firstSocket();
    first.simulateOpen();
    first.simulateMessage(validSnapshot());
    expect(states.at(-1)).toBe('connected');

    // Server-initiated / network drop — transitions through 'disconnected'
    // and synchronously into 'reconnecting' as scheduleReconnect() fires.
    first.simulateAbnormalClose();
    expect(states).toContain('disconnected');
    expect(states.at(-1)).toBe('reconnecting');

    vi.advanceTimersByTime(1_000);
    expect(FakeWebSocket.instances.length).toBeGreaterThan(1);
    const second = FakeWebSocket.instances[1]!;

    // Firing an event on the now-replaced first socket must be a no-op.
    first.simulateMessage(validSnapshot({ localReady: true }));
    expect(messages).toHaveLength(1); // still just the one from before the drop

    second.simulateOpen();
    second.simulateMessage(validSnapshot());
    expect(states.at(-1)).toBe('connected');
    transport.destroy();
  });

  test('destroy clears the reconnect timer, listeners, socket, and any retained readiness message', () => {
    vi.useFakeTimers();
    const transport = new WebSocketMultiplayerTransport('https://api.example.test', admission);
    const socket = firstSocket();
    socket.simulateOpen();
    transport.send({
      protocolVersion: MULTIPLAYER_PROTOCOL_VERSION,
      roomId: admission.roomId,
      playerId: admission.playerId,
      type: 'set-ready',
      ready: true,
    });

    socket.simulateAbnormalClose(); // schedules a reconnect
    transport.destroy();

    const instancesAtDestroy = FakeWebSocket.instances.length;
    vi.advanceTimersByTime(60_000);
    // No new socket gets constructed — the reconnect timer was cleared.
    expect(FakeWebSocket.instances.length).toBe(instancesAtDestroy);

    // send() after destroy is inert.
    transport.send({
      protocolVersion: MULTIPLAYER_PROTOCOL_VERSION,
      roomId: admission.roomId,
      playerId: admission.playerId,
      type: 'set-ready',
      ready: false,
    });
    expect(socket.sent).toHaveLength(1); // only the original authentication frame
  });
});

describe('WebSocketMultiplayerTransport connection diagnostics', () => {
  test('sends an application-level ping once authenticated', () => {
    vi.useFakeTimers();
    const transport = new WebSocketMultiplayerTransport('https://api.example.test', admission);
    const socket = firstSocket();
    socket.simulateOpen();
    socket.simulateMessage(validSnapshot());
    expect(socket.sent).toHaveLength(1); // authentication frame only

    vi.advanceTimersByTime(5_000);
    expect(socket.sent).toHaveLength(2);
    expect(JSON.parse(socket.sent[1]!)).toMatchObject({
      command: { type: 'ping', nonce: 0 },
    });
    transport.destroy();
  });

  test('a matching pong measures round-trip latency and is not forwarded to controllers', () => {
    vi.useFakeTimers();
    const transport = new WebSocketMultiplayerTransport('https://api.example.test', admission);
    const messages: unknown[] = [];
    transport.subscribe(message => messages.push(message));
    const socket = firstSocket();
    socket.simulateOpen();
    socket.simulateMessage(validSnapshot());
    expect(messages).toHaveLength(1);

    vi.advanceTimersByTime(5_000); // sends ping nonce 0
    vi.advanceTimersByTime(20);    // simulate a 20ms round trip
    socket.simulateMessage(pongEnvelope(0));

    expect(transport.diagnostics.rttMs).toBe(20);
    expect(transport.diagnostics.stale).toBe(false);
    expect(messages).toHaveLength(1); // pong never reaches the controllers
    transport.destroy();
  });

  test('an unanswered ping flags the connection stale after its deadline', () => {
    vi.useFakeTimers();
    const transport = new WebSocketMultiplayerTransport('https://api.example.test', admission);
    const socket = firstSocket();
    socket.simulateOpen();
    socket.simulateMessage(validSnapshot());
    expect(transport.diagnostics.stale).toBe(false);

    vi.advanceTimersByTime(5_000); // ping sent
    vi.advanceTimersByTime(10_000); // deadline passes -> stale
    expect(transport.diagnostics.stale).toBe(true);

    // A late pong recovers the connection health.
    socket.simulateMessage(pongEnvelope(0));
    expect(transport.diagnostics.stale).toBe(false);
    transport.destroy();
  });

  test('unexpected disconnects count toward reconnects and clear per-connection metrics', () => {
    vi.useFakeTimers();
    const transport = new WebSocketMultiplayerTransport('https://api.example.test', admission);
    const socket = firstSocket();
    socket.simulateOpen();
    socket.simulateMessage(validSnapshot());
    expect(transport.diagnostics.reconnects).toBe(0);
    expect(transport.diagnostics.connectedAt).not.toBeNull();

    socket.simulateAbnormalClose();
    expect(transport.diagnostics.reconnects).toBe(1);
    expect(transport.diagnostics.connectedAt).toBeNull();
    expect(transport.diagnostics.rttMs).toBeNull();
    transport.destroy();
  });
});
