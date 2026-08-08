import { afterEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { buildApp } from '../src/app.js';
import {
  MULTIPLAYER_PROTOCOL_VERSION,
} from '../src/multiplayer/contracts.js';
import {
  SCORE_RACE_ROOM_MODE,
  ScoreRaceRoomService,
} from '../src/multiplayer/room-service.js';
import {
  SHARED_DUEL_ROOM_MODE,
  SharedBoardRoomService,
} from '../src/multiplayer/shared-board-room-service.js';
import { createTestConfig, createTestDb } from './helpers.js';

let db: Database.Database | null = null;
let app: FastifyInstance | null = null;
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  await app?.close();
  db?.close();
  app = null;
  db = null;
});

async function createApp(): Promise<FastifyInstance> {
  db = createTestDb();
  const roomService = new ScoreRaceRoomService({
    clock: { now: () => Date.now() },
    countdownMs: 5,
  });
  app = await buildApp(createTestConfig(), db, { roomService, roomTickMs: 5 });
  await app.ready();
  return app;
}

const admissionRequest = {
  protocolVersion: MULTIPLAYER_PROTOCOL_VERSION,
  mode: SCORE_RACE_ROOM_MODE,
};

describe('multiplayer room gateway', () => {
  it('validates public room admission and rejects incompatible or full rooms', async () => {
    const instance = await createApp();

    const invalid = await instance.inject({
      method: 'POST',
      url: '/multiplayer/rooms',
      payload: { ...admissionRequest, unexpected: true },
    });
    const incompatible = await instance.inject({
      method: 'POST',
      url: '/multiplayer/rooms',
      payload: {
        ...admissionRequest,
        mode: { ...SCORE_RACE_ROOM_MODE, version: 2 },
      },
    });
    const created = await instance.inject({
      method: 'POST',
      url: '/multiplayer/rooms',
      payload: admissionRequest,
    });
    const room = created.json();
    const joined = await instance.inject({
      method: 'POST',
      url: `/multiplayer/rooms/${String(room.roomId).toLowerCase()}/join`,
      payload: admissionRequest,
    });
    const full = await instance.inject({
      method: 'POST',
      url: `/multiplayer/rooms/${String(room.roomId)}/join`,
      payload: admissionRequest,
    });

    expect(invalid.statusCode).toBe(400);
    expect(incompatible.statusCode).toBe(409);
    expect(incompatible.json()).toEqual({ error: 'mode-mismatch' });
    expect(created.statusCode).toBe(201);
    expect(room).toEqual({
      roomId: expect.stringMatching(/^[A-Z2-9]{8}$/),
      playerId: expect.any(String),
      reconnectCredential: expect.any(String),
      mode: SCORE_RACE_ROOM_MODE,
    });
    expect(joined.statusCode).toBe(201);
    expect(joined.json().roomId).toBe(room.roomId);
    expect(full.statusCode).toBe(409);
    expect(full.json()).toEqual({ error: 'room-full' });
  });

  it('rate limits room creation by forwarded client address', async () => {
    const instance = await createApp();
    const create = () => instance.inject({
      method: 'POST',
      url: '/multiplayer/rooms',
      remoteAddress: '127.0.0.1',
      headers: { 'x-forwarded-for': '203.0.113.40' },
      payload: admissionRequest,
    });

    for (let attempt = 0; attempt < 10; attempt++) {
      expect((await create()).statusCode).toBe(201);
    }
    const limited = await create();

    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toEqual({ error: 'rate_limited' });
  });

  it('authenticates sockets, relays canonical progress, and broadcasts one result', async () => {
    const instance = await createApp();
    const hostAdmission = await admit(instance, '/multiplayer/rooms');
    const guestAdmission = await admit(
      instance,
      `/multiplayer/rooms/${hostAdmission.roomId}/join`,
    );
    const host = await connect(instance, hostAdmission);
    const guest = await connect(instance, guestAdmission);

    await readyPlayer(host, true);
    await readyPlayer(guest, true);
    const hostCountdown = await nextMessageOfType(host, 'match-countdown');
    const guestCountdown = await nextMessageOfType(guest, 'match-countdown');
    expect(guestCountdown).toEqual(hostCountdown);

    await new Promise(resolve => setTimeout(resolve, 10));
    host.send(JSON.stringify({
      ...clientEnvelope(hostAdmission),
      type: 'publish-progress',
      matchId: hostCountdown.matchId,
      progress: { sequence: 1, score: 120, turnsPlayed: 1 },
    }));
    expect(await nextMessageOfType(guest, 'opponent-progress')).toMatchObject({
      matchId: hostCountdown.matchId,
      progress: {
        playerId: hostAdmission.playerId,
        sequence: 1,
        score: 120,
        turnsPlayed: 1,
        finished: false,
      },
    });

    host.send(JSON.stringify({
      ...clientEnvelope(hostAdmission),
      type: 'finish-match',
      matchId: hostCountdown.matchId,
      progress: { sequence: 1, score: 120, turnsPlayed: 1 },
    }));
    await nextMessageOfType(guest, 'opponent-progress');
    guest.send(JSON.stringify({
      ...clientEnvelope(guestAdmission),
      type: 'finish-match',
      matchId: hostCountdown.matchId,
      progress: { sequence: 1, score: 80, turnsPlayed: 1 },
    }));

    const hostResult = await nextMessageOfType(host, 'match-finished');
    const guestResult = await nextMessageOfType(guest, 'match-finished');
    expect(guestResult).toEqual(hostResult);
    expect(hostResult.result).toEqual({
      winnerId: hostAdmission.playerId,
      scores: [
        { playerId: hostAdmission.playerId, score: 120 },
        { playerId: guestAdmission.playerId, score: 80 },
      ],
      forfeitedBy: null,
    });
  });

  it('rejects an invalid first frame without admitting the socket', async () => {
    const instance = await createApp();
    const socket = await instance.injectWS('/multiplayer/socket');
    sockets.push(socket);
    retainMessages(socket);
    socket.send(JSON.stringify({ type: 'set-ready', ready: true }));

    expect(await nextJson(socket)).toEqual({
      type: 'room-transport-error',
      error: 'invalid-message',
    });
    await new Promise<void>(resolve => socket.once('close', () => resolve()));
    expect(socket.readyState).toBe(socket.CLOSED);
  });
});

interface Admission {
  readonly roomId: string;
  readonly playerId: string;
  readonly reconnectCredential: string;
}

async function admit(instance: FastifyInstance, url: string): Promise<Admission> {
  const response = await instance.inject({
    method: 'POST',
    url,
    payload: admissionRequest,
  });
  expect(response.statusCode).toBe(201);
  return response.json() as Admission;
}

async function connect(instance: FastifyInstance, admission: Admission): Promise<WebSocket> {
  const socket = await instance.injectWS('/multiplayer/socket');
  sockets.push(socket);
  retainMessages(socket);
  attachHeartbeatResponder(socket);
  socketAdmissions.set(socket, admission);
  socket.send(JSON.stringify({
    type: 'authenticate-room',
    ...clientEnvelope(admission),
    reconnectCredential: admission.reconnectCredential,
  }));
  await nextMessageOfType(socket, 'room-state');
  return socket;
}

/** Like connect(), but for a reconnect while the match is already 'playing' — that snapshot leads with turn-assigned, not room-state. */
async function reconnectMidMatch(instance: FastifyInstance, admission: Admission): Promise<WebSocket> {
  const socket = await instance.injectWS('/multiplayer/socket');
  sockets.push(socket);
  retainMessages(socket);
  attachHeartbeatResponder(socket);
  socketAdmissions.set(socket, admission);
  socket.send(JSON.stringify({
    type: 'authenticate-room',
    ...clientEnvelope(admission),
    reconnectCredential: admission.reconnectCredential,
  }));
  await nextMessageOfType(socket, 'turn-assigned');
  // Status is deliberately last in the snapshot (see snapshotDeliveries) — drain it too.
  await nextMessageOfType(socket, 'duel-status');
  return socket;
}

function clientEnvelope(admission: Admission) {
  return {
    protocolVersion: MULTIPLAYER_PROTOCOL_VERSION,
    roomId: admission.roomId,
    playerId: admission.playerId,
  };
}

async function readyPlayer(socket: WebSocket, ready: boolean): Promise<void> {
  const admission = await admissionForSocket(socket);
  socket.send(JSON.stringify({
    ...clientEnvelope(admission),
    type: 'set-ready',
    ready,
  }));
  await nextMessageOfType(socket, 'room-state');
}

const socketAdmissions = new WeakMap<WebSocket, Admission>();

async function admissionForSocket(socket: WebSocket): Promise<Admission> {
  const admission = socketAdmissions.get(socket);
  if (!admission) throw new Error('Socket admission was not retained');
  return admission;
}

async function nextMessageOfType(socket: WebSocket, type: string): Promise<any> {
  while (true) {
    const message = await nextJson(socket);
    if (message.type === type) return message;
  }
}

async function nextJson(socket: WebSocket): Promise<any> {
  const inbox = socketInboxes.get(socket);
  if (!inbox) throw new Error('Socket inbox was not retained');
  const queued = inbox.messages.shift();
  if (queued !== undefined) return queued;
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      const index = inbox.waiters.indexOf(waiter);
      if (index >= 0) inbox.waiters.splice(index, 1);
      reject(new Error('Timed out waiting for WebSocket message'));
    }, 1_000);
    const waiter = (message: unknown) => {
      clearTimeout(timeout);
      resolve(message);
    };
    inbox.waiters.push(waiter);
  });
}

interface SocketInbox {
  readonly messages: unknown[];
  readonly waiters: Array<(message: unknown) => void>;
}

const socketInboxes = new WeakMap<WebSocket, SocketInbox>();

function retainMessages(socket: WebSocket): void {
  const inbox: SocketInbox = { messages: [], waiters: [] };
  socketInboxes.set(socket, inbox);
  socket.on('message', raw => {
    const message = JSON.parse(raw.toString()) as unknown;
    const waiter = inbox.waiters.shift();
    if (waiter) waiter(message);
    else inbox.messages.push(message);
  });
}

interface HeartbeatResponderState {
  enabled: boolean;
}

const heartbeatResponders = new WeakMap<WebSocket, HeartbeatResponderState>();

// injectWS's in-process test client does not auto-respond to ping frames
// the way a real browser does, so heartbeat tests need to simulate that
// themselves. Attached immediately after every socket is created (not
// after a multi-step setup like startDuel() completes) so a real
// connection is never mistaken for unresponsive purely because setup took
// longer than a test's (deliberately short) heartbeat interval.
function attachHeartbeatResponder(socket: WebSocket): void {
  const state: HeartbeatResponderState = { enabled: true };
  heartbeatResponders.set(socket, state);
  socket.on('ping', () => {
    if (state.enabled) socket.pong();
  });
}

function setHeartbeatResponsive(socket: WebSocket, enabled: boolean): void {
  const state = heartbeatResponders.get(socket);
  if (!state) throw new Error('Heartbeat responder was not attached to this socket');
  state.enabled = enabled;
}

// --- Shared Duel: recoverable vs. fatal disposition ---------------------
//
// room-gateway.ts used to close the socket on *any* room-service rejection.
// It now keeps the socket open for `disposition: 'recoverable'` failures
// (benign gameplay races) and dispatches a corrective snapshot to the
// rejecting player instead, while genuinely fatal failures (bad credential,
// protocol mismatch, malformed frames) still close the socket exactly as
// before. These tests exercise that split end-to-end through two real
// sockets, not just the room-service unit in isolation.

const duelAdmissionRequest = {
  protocolVersion: MULTIPLAYER_PROTOCOL_VERSION,
  mode: SHARED_DUEL_ROOM_MODE,
};

async function createDuelApp(): Promise<FastifyInstance> {
  db = createTestDb();
  const sharedBoardRoomService = new SharedBoardRoomService({
    clock: { now: () => Date.now() },
    countdownMs: 5,
  });
  app = await buildApp(createTestConfig(), db, { sharedBoardRoomService, roomTickMs: 5 });
  await app.ready();
  return app;
}

async function createDuelAppWithHeartbeat(heartbeatMs: number): Promise<FastifyInstance> {
  db = createTestDb();
  const sharedBoardRoomService = new SharedBoardRoomService({
    clock: { now: () => Date.now() },
    countdownMs: 5,
  });
  app = await buildApp(createTestConfig(), db, {
    sharedBoardRoomService,
    roomTickMs: 5,
    roomHeartbeatMs: heartbeatMs,
  });
  await app.ready();
  return app;
}

async function duelAdmit(instance: FastifyInstance, url: string): Promise<Admission> {
  const response = await instance.inject({
    method: 'POST',
    url,
    payload: duelAdmissionRequest,
  });
  expect(response.statusCode).toBe(201);
  return response.json() as Admission;
}

interface DuelPlayers {
  readonly host: Admission;
  readonly guest: Admission;
  readonly hostSocket: WebSocket;
  readonly guestSocket: WebSocket;
  readonly matchId: string;
  readonly activeAdmission: Admission;
  readonly activeSocket: WebSocket;
  readonly inactiveAdmission: Admission;
  readonly inactiveSocket: WebSocket;
}

/** Admits two duel players, readies both, and waits for the first turn-assigned. */
async function startDuel(instance: FastifyInstance): Promise<DuelPlayers> {
  const host = await duelAdmit(instance, '/multiplayer/rooms');
  const guest = await duelAdmit(instance, `/multiplayer/rooms/${host.roomId}/join`);
  const hostSocket = await connect(instance, host);
  const guestSocket = await connect(instance, guest);

  await readyPlayer(hostSocket, true);
  await readyPlayer(guestSocket, true);
  await nextMessageOfType(hostSocket, 'match-countdown');
  await nextMessageOfType(guestSocket, 'match-countdown');

  const assigned = await nextMessageOfType(hostSocket, 'turn-assigned');
  // The guest sees the same broadcast; drain it so its inbox doesn't carry
  // a stale turn-assigned into the next assertion.
  await nextMessageOfType(guestSocket, 'turn-assigned');
  // Both sockets also receive the paired duel-status pulse — drain it too.
  await nextMessageOfType(hostSocket, 'duel-status');
  await nextMessageOfType(guestSocket, 'duel-status');

  const activePlayerId: string = assigned.playerId;
  const [activeAdmission, activeSocket, inactiveAdmission, inactiveSocket] =
    activePlayerId === host.playerId
      ? [host, hostSocket, guest, guestSocket] as const
      : [guest, guestSocket, host, hostSocket] as const;

  return {
    host,
    guest,
    hostSocket,
    guestSocket,
    matchId: assigned.matchId,
    activeAdmission,
    activeSocket,
    inactiveAdmission,
    inactiveSocket,
  };
}

/** Proves the match is still live and convergent: the active player drops, both sockets see the result. */
async function assertMatchStillUsable(duel: DuelPlayers): Promise<void> {
  duel.activeSocket.send(JSON.stringify({
    ...clientEnvelope(duel.activeAdmission),
    type: 'play-turn',
    matchId: duel.matchId,
    column: 3,
  }));
  const hostPlayed = await nextMessageOfType(duel.hostSocket, 'turn-played');
  const guestPlayed = await nextMessageOfType(duel.guestSocket, 'turn-played');
  expect(hostPlayed.turnResult.playerId).toBe(duel.activeAdmission.playerId);
  expect(guestPlayed.turnResult.playerId).toBe(duel.activeAdmission.playerId);
}

describe('multiplayer room gateway — shared duel recoverable failures', () => {
  it('keeps the socket open and sends a corrective snapshot for a cursor move from the inactive player', async () => {
    const instance = await createDuelApp();
    const duel = await startDuel(instance);

    duel.inactiveSocket.send(JSON.stringify({
      ...clientEnvelope(duel.inactiveAdmission),
      type: 'move-cursor',
      matchId: duel.matchId,
      column: 5,
    }));

    // Recoverable playing-state snapshot is turn-assigned followed by duel-status.
    const snapshotAssigned = await nextMessageOfType(duel.inactiveSocket, 'turn-assigned');
    expect(snapshotAssigned.matchId).toBe(duel.matchId);
    expect(snapshotAssigned.playerId).toBe(duel.activeAdmission.playerId);
    const snapshotStatus = await nextMessageOfType(duel.inactiveSocket, 'duel-status');
    expect(snapshotStatus.matchId).toBe(duel.matchId);
    expect(snapshotStatus.activePlayerId).toBe(duel.activeAdmission.playerId);

    expect(duel.inactiveSocket.readyState).toBe(duel.inactiveSocket.OPEN);
    expect(duel.activeSocket.readyState).toBe(duel.activeSocket.OPEN);
    await assertMatchStillUsable(duel);
  });

  it('keeps the socket open for a duplicate/stale play-turn from the player who just moved', async () => {
    const instance = await createDuelApp();
    const duel = await startDuel(instance);

    // The active player plays a real turn — the turn now belongs to the opponent.
    const mover = duel.activeAdmission;
    const moverSocket = duel.activeSocket;
    moverSocket.send(JSON.stringify({
      ...clientEnvelope(mover),
      type: 'play-turn',
      matchId: duel.matchId,
      column: 2,
    }));
    await nextMessageOfType(duel.hostSocket, 'turn-played');
    await nextMessageOfType(duel.guestSocket, 'turn-played');
    await nextMessageOfType(duel.hostSocket, 'turn-assigned');
    await nextMessageOfType(duel.guestSocket, 'turn-assigned');
    await nextMessageOfType(duel.hostSocket, 'duel-status');
    await nextMessageOfType(duel.guestSocket, 'duel-status');

    // The player who just moved tries to move again immediately — duplicate/stale.
    moverSocket.send(JSON.stringify({
      ...clientEnvelope(mover),
      type: 'play-turn',
      matchId: duel.matchId,
      column: 1,
    }));
    const snapshotAssigned = await nextMessageOfType(moverSocket, 'turn-assigned');
    expect(snapshotAssigned.playerId).not.toBe(mover.playerId);
    await nextMessageOfType(moverSocket, 'duel-status');

    expect(moverSocket.readyState).toBe(moverSocket.OPEN);
    // Rebuild the active/inactive pairing since the turn has since passed.
    const refreshed: DuelPlayers = {
      ...duel,
      activeAdmission: duel.inactiveAdmission,
      activeSocket: duel.inactiveSocket,
      inactiveAdmission: duel.activeAdmission,
      inactiveSocket: duel.activeSocket,
    };
    await assertMatchStillUsable(refreshed);
  });

  it('keeps the socket open for a stale matchId on play-turn, set-paused, and forfeit-match', async () => {
    const instance = await createDuelApp();
    const duel = await startDuel(instance);
    const staleMatchId = 'not-this-match';

    for (const type of ['play-turn', 'set-paused', 'forfeit-match'] as const) {
      const payload = type === 'play-turn'
        ? { type, matchId: staleMatchId, column: 3 }
        : type === 'set-paused'
          ? { type, matchId: staleMatchId, paused: true }
          : { type, matchId: staleMatchId };
      duel.activeSocket.send(JSON.stringify({
        ...clientEnvelope(duel.activeAdmission),
        ...payload,
      }));
      const snapshotAssigned = await nextMessageOfType(duel.activeSocket, 'turn-assigned');
      expect(snapshotAssigned.matchId).toBe(duel.matchId);
      await nextMessageOfType(duel.activeSocket, 'duel-status');
      expect(duel.activeSocket.readyState).toBe(duel.activeSocket.OPEN);
    }

    await assertMatchStillUsable(duel);
  });

  it('samples repeated identical recoverable rejections without breaking the connection', async () => {
    const instance = await createDuelApp();
    const duel = await startDuel(instance);

    for (let attempt = 0; attempt < 5; attempt++) {
      duel.inactiveSocket.send(JSON.stringify({
        ...clientEnvelope(duel.inactiveAdmission),
        type: 'move-cursor',
        matchId: duel.matchId,
        column: attempt,
      }));
      await nextMessageOfType(duel.inactiveSocket, 'turn-assigned');
      await nextMessageOfType(duel.inactiveSocket, 'duel-status');
    }

    expect(duel.inactiveSocket.readyState).toBe(duel.inactiveSocket.OPEN);
    await assertMatchStillUsable(duel);
  });

  it('still closes the socket for a malformed frame sent after authentication', async () => {
    const instance = await createDuelApp();
    const duel = await startDuel(instance);

    duel.activeSocket.send('not json');

    expect(await nextJson(duel.activeSocket)).toEqual({
      type: 'room-transport-error',
      error: 'invalid-message',
    });
    await new Promise<void>(resolve => duel.activeSocket.once('close', () => resolve()));
    expect(duel.activeSocket.readyState).toBe(duel.activeSocket.CLOSED);
  });

  it('still closes the socket for a protocol-version mismatch sent after authentication', async () => {
    const instance = await createDuelApp();
    const duel = await startDuel(instance);

    duel.activeSocket.send(JSON.stringify({
      ...clientEnvelope(duel.activeAdmission),
      protocolVersion: MULTIPLAYER_PROTOCOL_VERSION + 1,
      type: 'play-turn',
      matchId: duel.matchId,
      column: 3,
    }));

    // parseClientMessage collapses every post-auth client parse failure
    // (including a protocol mismatch) into a generic 'invalid-message' close
    // reason — pre-existing gateway behavior, unrelated to the fatal/
    // recoverable disposition split. What matters here is that it still
    // closes the socket rather than silently accepting a mismatched frame.
    expect(await nextJson(duel.activeSocket)).toEqual({
      type: 'room-transport-error',
      error: 'invalid-message',
    });
    await new Promise<void>(resolve => duel.activeSocket.once('close', () => resolve()));
    expect(duel.activeSocket.readyState).toBe(duel.activeSocket.CLOSED);
  });
});

// --- Connection heartbeat -------------------------------------------------
//
// room-gateway.ts only learns a connection is gone via the socket's own
// 'close' event. A clean drop (tab closed, client reconnect logic kicking
// in) always fires that. A silently dead connection (network partition, a
// device sleeping mid-connection) may never fire it on its own — nothing
// else in the stack would ever notice, so the freeze/abandonment behavior
// from shared-board-room-service.ts would never engage for it. The
// heartbeat pings each socket periodically and terminates it if a pong
// doesn't come back, which forces that same 'close' event.
//
// injectWS's in-process test client does not auto-respond to ping frames
// (verified empirically — unlike a real browser, which does this at the
// protocol level automatically). connect()/reconnectMidMatch() attach a
// controllable responder (default: on) to every socket the instant it's
// created — before any multi-step setup like startDuel() runs — so a real
// connection is never mistaken for unresponsive purely because setup took
// longer than a test's (deliberately short) heartbeat interval. Tests that
// want to simulate a dead connection call setHeartbeatResponsive(socket,
// false) only after setup has completed.

describe('multiplayer room gateway — connection heartbeat', () => {
  it('a responsive socket (one that answers pings) survives many heartbeat intervals', async () => {
    const heartbeatMs = 20;
    const instance = await createDuelAppWithHeartbeat(heartbeatMs);
    const duel = await startDuel(instance);

    await new Promise(resolve => setTimeout(resolve, heartbeatMs * 6));

    expect(duel.hostSocket.readyState).toBe(duel.hostSocket.OPEN);
    expect(duel.guestSocket.readyState).toBe(duel.guestSocket.OPEN);
    await assertMatchStillUsable(duel);
  });

  it('an unresponsive socket is terminated, which freezes the match for the opponent', async () => {
    const heartbeatMs = 20;
    const instance = await createDuelAppWithHeartbeat(heartbeatMs);
    const duel = await startDuel(instance);

    // The active player's socket goes quiet only now, after setup — the
    // opponent's responder stays on (its default), simulating a connection
    // that died without ever firing 'close' on its own.
    setHeartbeatResponsive(duel.activeSocket, false);

    await new Promise<void>(resolve => duel.activeSocket.once('close', () => resolve()));
    expect(duel.activeSocket.readyState).toBe(duel.activeSocket.CLOSED);

    const paused = await nextMessageOfType(duel.inactiveSocket, 'match-paused');
    expect(paused).toEqual(expect.objectContaining({
      type: 'match-paused', paused: true, pausedBy: duel.activeAdmission.playerId,
    }));
  });

  it('a replacement socket is unaffected by the old socket\'s heartbeat state', async () => {
    const heartbeatMs = 20;
    const instance = await createDuelAppWithHeartbeat(heartbeatMs);
    const duel = await startDuel(instance);

    // The old socket goes quiet only now, after setup — about to be
    // superseded by a reconnect before its own heartbeat would ever have a
    // chance to terminate it. The opponent's responder stays on throughout.
    const staleSocket = duel.activeSocket;
    setHeartbeatResponsive(staleSocket, false);

    const reconnected = await reconnectMidMatch(instance, duel.activeAdmission);

    // The gateway's explicit "connection replaced" close beats the heartbeat here.
    await new Promise<void>(resolve => staleSocket.once('close', () => resolve()));
    expect(staleSocket.readyState).toBe(staleSocket.CLOSED);

    // Give the old socket's now-defunct heartbeat entry plenty of chances
    // to (wrongly) terminate the new connection or disconnect it from the
    // room — the existing connection-identity check in the close handler
    // should make this a no-op regardless of who closes the stale socket.
    await new Promise(resolve => setTimeout(resolve, heartbeatMs * 6));

    expect(reconnected.readyState).toBe(reconnected.OPEN);
    const refreshed: DuelPlayers = duel.activeAdmission.playerId === duel.host.playerId
      ? { ...duel, hostSocket: reconnected, activeSocket: reconnected }
      : { ...duel, guestSocket: reconnected, activeSocket: reconnected };
    await assertMatchStillUsable(refreshed);
  });

  it('clears the heartbeat timer on shutdown, not just the sockets it was tracking', async () => {
    // instance.close() also closes every open socket, so merely observing
    // "no more pings after close" would pass even if the interval kept
    // running (the loop's own readyState guard would just skip a closed
    // socket) — that doesn't prove the timer itself was cleared. Capture
    // the actual Timeout the heartbeat interval creates (identified by its
    // distinctive delay) and assert clearInterval is called with that exact
    // handle on shutdown.
    const heartbeatMs = 15;
    const originalSetInterval = global.setInterval;
    const capturedIntervals: Array<{ delayMs: number; handle: NodeJS.Timeout }> = [];
    const setIntervalSpy = vi.spyOn(global, 'setInterval')
      .mockImplementation(((handler: (...args: unknown[]) => void, delayMs?: number, ...args: unknown[]) => {
        const handle = originalSetInterval(handler, delayMs, ...args);
        capturedIntervals.push({ delayMs: delayMs ?? 0, handle });
        return handle;
      }) as typeof setInterval);
    const clearIntervalSpy = vi.spyOn(global, 'clearInterval');

    try {
      const instance = await createDuelAppWithHeartbeat(heartbeatMs);
      const heartbeatEntry = capturedIntervals.find(entry => entry.delayMs === heartbeatMs);
      expect(heartbeatEntry).toBeDefined();

      await instance.close();
      app = null;

      expect(clearIntervalSpy).toHaveBeenCalledWith(heartbeatEntry!.handle);
    } finally {
      setIntervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
    }
  });
});
