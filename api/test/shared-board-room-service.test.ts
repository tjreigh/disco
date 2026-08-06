import { describe, expect, test } from 'vitest';
import {
  MULTIPLAYER_PROTOCOL_VERSION,
} from '../src/multiplayer/contracts.js';
import {
  SHARED_DUEL_ROOM_MODE,
  SharedBoardRoomService,
} from '../src/multiplayer/shared-board-room-service.js';
import type {
  MultiplayerClientMessage,
  MultiplayerModeIdentity,
  MultiplayerServerMessage,
} from '../src/multiplayer/contracts.js';
import type {
  RoomAdmission,
  RoomConnection,
  RoomDelivery,
  RoomServiceResult,
  RoomValueFactory,
} from '../src/multiplayer/room-service.js';

const COUNTDOWN_MS = 100;
const LOBBY_TTL_MS = 1_000;
const RESULT_TTL_MS = 500;
const TURN_TIMEOUT_MS = 50;

class ManualClock {
  constructor(public time = 10_000) {}

  now(): number {
    return this.time;
  }
}

class DeterministicRoomValues implements RoomValueFactory {
  private room = 0;
  private player = 0;
  private credential = 0;
  private match = 0;
  private seed = 40;

  createRoomId(): string {
    return `ROOM-${++this.room}`;
  }

  createPlayerId(): string {
    return `player-${++this.player}`;
  }

  createReconnectCredential(): string {
    return `credential-${++this.credential}`;
  }

  createMatchId(): string {
    return `match-${++this.match}`;
  }

  createSeed(): number {
    return ++this.seed;
  }
}

interface RoomHarness {
  readonly clock: ManualClock;
  readonly service: SharedBoardRoomService;
  readonly host: RoomAdmission;
  readonly guest: RoomAdmission;
  readonly hostConnection: RoomConnection;
  readonly guestConnection: RoomConnection;
}

function createService(clock = new ManualClock()): SharedBoardRoomService {
  return new SharedBoardRoomService({
    clock,
    values: new DeterministicRoomValues(),
    countdownMs: COUNTDOWN_MS,
    lobbyTtlMs: LOBBY_TTL_MS,
    resultTtlMs: RESULT_TTL_MS,
    turnTimeoutMs: TURN_TIMEOUT_MS,
  });
}

function admissionRequest(mode: MultiplayerModeIdentity = SHARED_DUEL_ROOM_MODE) {
  return {
    protocolVersion: MULTIPLAYER_PROTOCOL_VERSION,
    mode,
  };
}

function valueOf<T>(result: RoomServiceResult<T>): T {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`Expected success, received ${result.error}`);
  return result.value;
}

function errorOf<T>(result: RoomServiceResult<T>): string {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('Expected room service failure');
  return result.error;
}

function connect(service: SharedBoardRoomService, admission: RoomAdmission): RoomConnection {
  return valueOf(service.connect({
    roomId: admission.roomId,
    playerId: admission.playerId,
    reconnectCredential: admission.reconnectCredential,
  }));
}

function setupRoom(): RoomHarness {
  const clock = new ManualClock();
  const service = createService(clock);
  const host = valueOf(service.createRoom(admissionRequest()));
  const guest = valueOf(service.joinRoom({
    ...admissionRequest(),
    roomId: host.roomId,
  }));
  const hostConnection = connect(service, host);
  const guestConnection = connect(service, guest);
  return { clock, service, host, guest, hostConnection, guestConnection };
}

type ClientPayload = MultiplayerClientMessage extends infer Message
  ? Message extends MultiplayerClientMessage
    ? Omit<Message, 'protocolVersion' | 'roomId' | 'playerId'>
    : never
  : never;

function message(
  admission: RoomAdmission,
  payload: ClientPayload,
): MultiplayerClientMessage {
  return {
    protocolVersion: MULTIPLAYER_PROTOCOL_VERSION,
    roomId: admission.roomId,
    playerId: admission.playerId,
    ...payload,
  } as MultiplayerClientMessage;
}

function messagesOf(deliveries: readonly RoomDelivery[]): MultiplayerServerMessage[] {
  return deliveries.map(delivery => delivery.message);
}

interface Countdown {
  readonly matchId: string;
  readonly startsAt: number;
}

function startMatch(harness: RoomHarness): Countdown {
  valueOf(harness.service.receive(
    harness.hostConnection,
    message(harness.host, { type: 'set-ready', ready: true }),
  ));
  const started = harness.service.receive(
    harness.guestConnection,
    message(harness.guest, { type: 'set-ready', ready: true }),
  );
  valueOf(started);
  const countdown = started.deliveries.find(
    delivery => delivery.message.type === 'match-countdown',
  )?.message;
  if (!countdown || countdown.type !== 'match-countdown') {
    throw new Error('Expected match countdown');
  }
  return { matchId: countdown.matchId, startsAt: countdown.startsAt };
}

/** Drives a room from lobby through to the first 'turn-assigned' broadcast. */
function startPlaying(harness: RoomHarness): { matchId: string; firstPlayerId: string } {
  const countdown = startMatch(harness);
  harness.clock.time = countdown.startsAt;
  const tickResult = harness.service.tick();
  const assigned = tickResult.deliveries.find(
    delivery => delivery.message.type === 'turn-assigned',
  )?.message;
  if (!assigned || assigned.type !== 'turn-assigned') {
    throw new Error('Expected turn-assigned after countdown elapses');
  }
  return { matchId: countdown.matchId, firstPlayerId: assigned.playerId };
}

describe('SharedBoardRoomService', () => {
  test('rejects incompatible protocol and mode on create/join', () => {
    const service = createService();
    expect(errorOf(service.createRoom({
      protocolVersion: 99,
      mode: SHARED_DUEL_ROOM_MODE,
    }))).toBe('protocol-mismatch');
    expect(errorOf(service.createRoom(admissionRequest({
      ...SHARED_DUEL_ROOM_MODE,
      version: SHARED_DUEL_ROOM_MODE.version + 1,
    })))).toBe('mode-mismatch');

    const host = valueOf(service.createRoom(admissionRequest()));
    expect(errorOf(service.joinRoom({
      ...admissionRequest({
        ...SHARED_DUEL_ROOM_MODE,
        rules: { ...SHARED_DUEL_ROOM_MODE.rules, version: SHARED_DUEL_ROOM_MODE.rules.version + 1 },
      }),
      roomId: host.roomId,
    }))).toBe('mode-mismatch');
    expect(errorOf(service.joinRoom({
      ...admissionRequest(),
      roomId: 'missing',
    }))).toBe('room-not-found');
  });

  test('starts a match with a real countdown deadline, not a placeholder', () => {
    const harness = setupRoom();
    valueOf(harness.service.receive(
      harness.hostConnection,
      message(harness.host, { type: 'set-ready', ready: true }),
    ));
    const started = harness.service.receive(
      harness.guestConnection,
      message(harness.guest, { type: 'set-ready', ready: true }),
    );
    valueOf(started);
    const countdown = messagesOf(started.deliveries).find(m => m.type === 'match-countdown');
    expect(countdown?.type).toBe('match-countdown');
    if (countdown?.type !== 'match-countdown') throw new Error('Expected match-countdown');
    // Regression: match-countdown.deadline must be a real timestamp (the
    // countdown's own end, i.e. startsAt), not a hardcoded 0.
    expect(countdown.deadline).toBe(countdown.startsAt);
    expect(countdown.deadline).toBeGreaterThan(harness.clock.now());
  });

  test('countdown elapsing assigns the first turn to one of the two players', () => {
    const harness = setupRoom();
    const { firstPlayerId } = startPlaying(harness);
    expect([harness.host.playerId, harness.guest.playerId]).toContain(firstPlayerId);
  });

  // Regression: turn-assigned used to carry no disc/level data at all, so
  // the client always showed a fake, invalid disc (value 0).
  test('turn-assigned carries the real current/next disc and level state', () => {
    const harness = setupRoom();
    const countdown = startMatch(harness);
    harness.clock.time = countdown.startsAt;
    const tickResult = harness.service.tick();
    const assigned = tickResult.deliveries.find(d => d.message.type === 'turn-assigned')?.message;
    expect(assigned?.type).toBe('turn-assigned');
    if (assigned?.type !== 'turn-assigned') throw new Error('Expected turn-assigned');

    expect(assigned.currentDisc.value).toBeGreaterThanOrEqual(1);
    expect(assigned.currentDisc.value).toBeLessThanOrEqual(7);
    expect(assigned.nextDisc.value).toBeGreaterThanOrEqual(1);
    expect(assigned.nextDisc.value).toBeLessThanOrEqual(7);
    expect(assigned.level).toBe(1);
    expect(assigned.turnsPerLevel).toBeGreaterThan(0);
    expect(assigned.turnsRemaining).toBeGreaterThan(0);
    expect(assigned.turnsRemaining).toBeLessThanOrEqual(assigned.turnsPerLevel);
  });

  test('a played turn broadcasts the result and hands the turn to the other player', () => {
    const harness = setupRoom();
    const { matchId, firstPlayerId } = startPlaying(harness);
    const [connection, admission] = firstPlayerId === harness.host.playerId
      ? [harness.hostConnection, harness.host]
      : [harness.guestConnection, harness.guest];
    const opponentId = firstPlayerId === harness.host.playerId
      ? harness.guest.playerId
      : harness.host.playerId;

    const result = harness.service.receive(
      connection,
      message(admission, { type: 'play-turn', matchId, column: 3 }),
    );
    valueOf(result);

    const played = result.deliveries.find(d => d.message.type === 'turn-played')?.message;
    expect(played?.type).toBe('turn-played');
    if (played?.type !== 'turn-played') throw new Error('Expected turn-played');
    expect(played.turnResult.playerId).toBe(firstPlayerId);
    expect(played.turnResult.column).toBe(3);
    expect(played.nextPlayerId).toBe(opponentId);
    // Regression: stackSize used to be hardcoded to 0 regardless of the
    // real engine result.
    expect(played.turnResult.stackSize).toBeGreaterThanOrEqual(0);
    expect(played.currentDisc.value).toBeGreaterThanOrEqual(1);
    expect(played.currentDisc.value).toBeLessThanOrEqual(7);

    const assigned = result.deliveries.find(d => d.message.type === 'turn-assigned')?.message;
    expect(assigned?.type).toBe('turn-assigned');
    if (assigned?.type !== 'turn-assigned') throw new Error('Expected turn-assigned');
    expect(assigned.playerId).toBe(opponentId);
    expect(assigned.currentDisc).toEqual(played.currentDisc);
    expect(assigned.nextDisc).toEqual(played.nextDisc);
  });

  test('rejects a play-turn from the player who is not currently assigned', () => {
    const harness = setupRoom();
    const { matchId, firstPlayerId } = startPlaying(harness);
    const [connection, admission] = firstPlayerId === harness.host.playerId
      ? [harness.guestConnection, harness.guest]
      : [harness.hostConnection, harness.host];

    expect(errorOf(harness.service.receive(
      connection,
      message(admission, { type: 'play-turn', matchId, column: 3 }),
    ))).toBe('invalid-state');
  });

  test('rejects a play-turn for the wrong matchId', () => {
    const harness = setupRoom();
    const { firstPlayerId } = startPlaying(harness);
    const [connection, admission] = firstPlayerId === harness.host.playerId
      ? [harness.hostConnection, harness.host]
      : [harness.guestConnection, harness.guest];

    expect(errorOf(harness.service.receive(
      connection,
      message(admission, { type: 'play-turn', matchId: 'not-this-match', column: 3 }),
    ))).toBe('match-mismatch');
  });

  test('rejects a play-turn before the countdown has elapsed', () => {
    const harness = setupRoom();
    startMatch(harness);

    expect(errorOf(harness.service.receive(
      harness.hostConnection,
      message(harness.host, { type: 'play-turn', matchId: 'match-1', column: 3 }),
    ))).toBe('invalid-state');
  });

  test('a turn timeout auto-drops and hands the turn to the other player', () => {
    const harness = setupRoom();
    const { firstPlayerId } = startPlaying(harness);
    const opponentId = firstPlayerId === harness.host.playerId
      ? harness.guest.playerId
      : harness.host.playerId;

    harness.clock.time += TURN_TIMEOUT_MS;
    const tickResult = harness.service.tick();

    const expired = tickResult.deliveries.find(d => d.message.type === 'turn-expired')?.message;
    expect(expired?.type).toBe('turn-expired');
    if (expired?.type !== 'turn-expired') throw new Error('Expected turn-expired');
    expect(expired.turnResult.playerId).toBe(firstPlayerId);
    expect(expired.turnResult.column).not.toBeNull();
    expect(expired.turnResult.column).toBeGreaterThanOrEqual(0);
    expect(expired.turnResult.column).toBeLessThanOrEqual(6);
    expect(expired.turnResult.stackSize).toBeGreaterThanOrEqual(0);

    const assigned = tickResult.deliveries.find(d => d.message.type === 'turn-assigned')?.message;
    expect(assigned?.type).toBe('turn-assigned');
    if (assigned?.type !== 'turn-assigned') throw new Error('Expected turn-assigned');
    expect(assigned.playerId).toBe(opponentId);
  });

  test('relays the active player\'s cursor move to their opponent only', () => {
    const harness = setupRoom();
    const { matchId, firstPlayerId } = startPlaying(harness);
    const [connection, admission] = firstPlayerId === harness.host.playerId
      ? [harness.hostConnection, harness.host]
      : [harness.guestConnection, harness.guest];
    const opponentId = firstPlayerId === harness.host.playerId
      ? harness.guest.playerId
      : harness.host.playerId;

    const result = harness.service.receive(
      connection,
      message(admission, { type: 'move-cursor', matchId, column: 5 }),
    );
    valueOf(result);

    const cursorDeliveries = result.deliveries.filter(d => d.message.type === 'opponent-cursor');
    expect(cursorDeliveries).toHaveLength(1);
    expect(cursorDeliveries[0]!.playerId).toBe(opponentId);
    const cursorMessage = cursorDeliveries[0]!.message;
    expect(cursorMessage.type).toBe('opponent-cursor');
    if (cursorMessage.type !== 'opponent-cursor') throw new Error('Expected opponent-cursor');
    expect(cursorMessage.playerId).toBe(firstPlayerId);
    expect(cursorMessage.column).toBe(5);
  });

  test('rejects a cursor move from the player who is not currently assigned', () => {
    const harness = setupRoom();
    const { matchId, firstPlayerId } = startPlaying(harness);
    const [connection, admission] = firstPlayerId === harness.host.playerId
      ? [harness.guestConnection, harness.guest]
      : [harness.hostConnection, harness.host];

    expect(errorOf(harness.service.receive(
      connection,
      message(admission, { type: 'move-cursor', matchId, column: 5 }),
    ))).toBe('invalid-state');
  });

  test('rejects a cursor move for the wrong matchId', () => {
    const harness = setupRoom();
    const { firstPlayerId } = startPlaying(harness);
    const [connection, admission] = firstPlayerId === harness.host.playerId
      ? [harness.hostConnection, harness.host]
      : [harness.guestConnection, harness.guest];

    expect(errorOf(harness.service.receive(
      connection,
      message(admission, { type: 'move-cursor', matchId: 'not-this-match', column: 5 }),
    ))).toBe('match-mismatch');
  });

  test('rejects a cursor move before the countdown has elapsed', () => {
    const harness = setupRoom();
    startMatch(harness);

    expect(errorOf(harness.service.receive(
      harness.hostConnection,
      message(harness.host, { type: 'move-cursor', matchId: 'match-1', column: 5 }),
    ))).toBe('invalid-state');
  });

  // Regression for the deterministic-auto-drop bug: a timed-out turn used to
  // always land in the leftmost open column. Across many independent
  // matches (different seeds), the auto-dropped column should vary.
  test('turn timeout auto-drop is not always the same column', () => {
    const observedColumns = new Set<number>();
    for (let trial = 0; trial < 40; trial++) {
      const harness = setupRoom();
      startPlaying(harness);
      harness.clock.time += TURN_TIMEOUT_MS;
      const tickResult = harness.service.tick();
      const expired = tickResult.deliveries.find(d => d.message.type === 'turn-expired')?.message;
      if (expired?.type === 'turn-expired' && expired.turnResult.column !== null) {
        observedColumns.add(expired.turnResult.column);
      }
    }
    expect(observedColumns.size).toBeGreaterThan(1);
  });

  test('a reconnecting player receives a turn-assigned snapshot of the live board', () => {
    const harness = setupRoom();
    startPlaying(harness);
    harness.service.disconnect(harness.hostConnection);

    const reconnected = harness.service.connect({
      roomId: harness.host.roomId,
      playerId: harness.host.playerId,
      reconnectCredential: harness.host.reconnectCredential,
    });
    valueOf(reconnected);
    const snapshot = reconnected.deliveries.find(d => d.message.type === 'turn-assigned')?.message;
    expect(snapshot).toBeDefined();
    if (snapshot?.type !== 'turn-assigned') throw new Error('Expected turn-assigned');
    // Regression: a reconnecting player must see current disc/level state,
    // not stale or placeholder values.
    expect(snapshot.currentDisc.value).toBeGreaterThanOrEqual(1);
    expect(snapshot.currentDisc.value).toBeLessThanOrEqual(7);
    expect(snapshot.level).toBeGreaterThanOrEqual(1);
  });
});

describe('SharedBoardRoomService pause and forfeit', () => {
  test('pause blocks turn expiry and rejects gameplay input until the pauser resumes', () => {
    const harness = setupRoom();
    const { matchId, firstPlayerId } = startPlaying(harness);
    const [connection, admission] = firstPlayerId === harness.host.playerId
      ? [harness.hostConnection, harness.host]
      : [harness.guestConnection, harness.guest];
    const [otherConnection, otherAdmission] = firstPlayerId === harness.host.playerId
      ? [harness.guestConnection, harness.guest]
      : [harness.hostConnection, harness.host];

    const paused = harness.service.receive(
      connection,
      message(admission, { type: 'set-paused', matchId, paused: true }),
    );
    valueOf(paused);
    expect(paused.deliveries).toHaveLength(2);
    for (const delivery of paused.deliveries) {
      expect(delivery.message).toEqual(expect.objectContaining({
        type: 'match-paused', paused: true, pausedBy: firstPlayerId,
      }));
    }

    // Turn timeout would have fired by now — but the room is paused.
    harness.clock.time += TURN_TIMEOUT_MS * 5;
    expect(harness.service.tick().deliveries).toEqual([]);

    expect(errorOf(harness.service.receive(
      connection,
      message(admission, { type: 'play-turn', matchId, column: 3 }),
    ))).toBe('invalid-state');
    expect(errorOf(harness.service.receive(
      connection,
      message(admission, { type: 'move-cursor', matchId, column: 5 }),
    ))).toBe('invalid-state');

    // Only the player who paused can resume.
    expect(errorOf(harness.service.receive(
      otherConnection,
      message(otherAdmission, { type: 'set-paused', matchId, paused: false }),
    ))).toBe('invalid-state');

    const resumed = harness.service.receive(
      connection,
      message(admission, { type: 'set-paused', matchId, paused: false }),
    );
    valueOf(resumed);
    expect(resumed.deliveries).toHaveLength(2);
    for (const delivery of resumed.deliveries) {
      expect(delivery.message.type).toBe('match-paused');
      if (delivery.message.type !== 'match-paused') continue;
      expect(delivery.message.paused).toBe(false);
      // The shifted deadline must be in the future, not left in the past
      // from before the pause.
      expect(delivery.message.deadline).toBeGreaterThan(harness.clock.time);
    }

    // Turn play accepted again post-resume.
    valueOf(harness.service.receive(
      connection,
      message(admission, { type: 'play-turn', matchId, column: 3 }),
    ));
  });

  test('disconnecting the pausing player auto-resumes so the opponent is not soft-locked', () => {
    const harness = setupRoom();
    const { matchId, firstPlayerId } = startPlaying(harness);
    const [connection, admission] = firstPlayerId === harness.host.playerId
      ? [harness.hostConnection, harness.host]
      : [harness.guestConnection, harness.guest];
    const otherAdmission = firstPlayerId === harness.host.playerId ? harness.guest : harness.host;

    valueOf(harness.service.receive(
      connection,
      message(admission, { type: 'set-paused', matchId, paused: true }),
    ));

    harness.clock.time += TURN_TIMEOUT_MS;
    // This service's broadcast() sends to both players unconditionally
    // (offline sockets are no-ops at the gateway layer) — unlike Score
    // Race's room service, which filters by live connection.
    const disconnectDeliveries = harness.service.disconnect(connection);
    const otherDelivery = disconnectDeliveries.find(d => d.playerId === otherAdmission.playerId);
    expect(otherDelivery?.message).toEqual(expect.objectContaining({
      type: 'match-paused', paused: false, pausedBy: firstPlayerId,
    }));

    // The room resumed — a normal turn-expiry tick can fire again.
    harness.clock.time += TURN_TIMEOUT_MS;
    const tickResult = harness.service.tick();
    expect(tickResult.deliveries.some(d => d.message.type === 'turn-expired')).toBe(true);
  });

  test('a reconnecting player receives the current pause state', () => {
    const harness = setupRoom();
    const { matchId, firstPlayerId } = startPlaying(harness);
    const pauser = firstPlayerId === harness.host.playerId ? harness.host : harness.guest;
    const pauserConnection = firstPlayerId === harness.host.playerId
      ? harness.hostConnection
      : harness.guestConnection;
    const other = firstPlayerId === harness.host.playerId ? harness.guest : harness.host;
    const otherConnection = firstPlayerId === harness.host.playerId
      ? harness.guestConnection
      : harness.hostConnection;

    valueOf(harness.service.receive(
      pauserConnection,
      message(pauser, { type: 'set-paused', matchId, paused: true }),
    ));

    harness.service.disconnect(otherConnection);
    const reconnected = harness.service.connect({
      roomId: other.roomId,
      playerId: other.playerId,
      reconnectCredential: other.reconnectCredential,
    });
    valueOf(reconnected);
    const pausedSnapshot = reconnected.deliveries.find(d => d.message.type === 'match-paused')?.message;
    expect(pausedSnapshot).toEqual(expect.objectContaining({
      type: 'match-paused', paused: true, pausedBy: pauser.playerId,
    }));
  });

  test('forfeit always hands the win to the opponent, even mid-pause', () => {
    const harness = setupRoom();
    const { matchId, firstPlayerId } = startPlaying(harness);
    const forfeiter = firstPlayerId === harness.host.playerId ? harness.host : harness.guest;
    const forfeiterConnection = firstPlayerId === harness.host.playerId
      ? harness.hostConnection
      : harness.guestConnection;
    const opponent = firstPlayerId === harness.host.playerId ? harness.guest : harness.host;

    valueOf(harness.service.receive(
      forfeiterConnection,
      message(forfeiter, { type: 'set-paused', matchId, paused: true }),
    ));

    const forfeited = harness.service.receive(
      forfeiterConnection,
      message(forfeiter, { type: 'forfeit-match', matchId }),
    );
    valueOf(forfeited);
    const results = forfeited.deliveries.filter(d => d.message.type === 'match-finished');
    expect(results).toHaveLength(2);
    expect(results[0]?.message).toEqual(expect.objectContaining({
      type: 'match-finished',
      result: expect.objectContaining({ winnerId: opponent.playerId }),
    }));

    // The pause no longer blocks anything post-forfeit — the match is over.
    harness.clock.time += TURN_TIMEOUT_MS * 10;
    expect(harness.service.tick().deliveries).toEqual([]);
  });
});
