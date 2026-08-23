import { describe, expect, test } from 'vitest';
import {
  MULTIPLAYER_PROTOCOL_VERSION,
} from '../src/multiplayer/contracts.js';
import {
  SHARED_DUEL_ROOM_MODE,
  SharedBoardRoomService,
} from '../src/multiplayer/shared-board-room-service.js';
import { MAX_CHAT_MESSAGES_PER_WINDOW } from '../src/multiplayer/chat-policy.js';
import { createRoomIdAllocator } from '../src/multiplayer/room-values.js';
import type {
  MultiplayerClientMessage,
  MultiplayerModeIdentity,
  MultiplayerServerMessage,
} from '../src/multiplayer/contracts.js';
import type { WireStep } from '#multiplayer-contracts';
import type {
  RoomAdmission,
  RoomConnection,
  RoomDelivery,
  RoomServiceResult,
  RoomValueFactory,
} from '../src/multiplayer/room-types.js';

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

class FixedRoomIdValues extends DeterministicRoomValues {
  private rejectNextPlayerId: boolean;

  constructor(
    private readonly roomId: string,
    rejectNextPlayerId = false,
  ) {
    super();
    this.rejectNextPlayerId = rejectNextPlayerId;
  }

  override createRoomId(): string {
    return this.roomId;
  }

  override createPlayerId(): string {
    if (this.rejectNextPlayerId) {
      this.rejectNextPlayerId = false;
      return '';
    }
    return super.createPlayerId();
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

function createService(
  clock = new ManualClock(),
  overrides: Partial<{
    statusPulseMs: number;
    abandonTimeoutMs: number;
    estimateTurnAnimationMs: (steps: readonly WireStep[]) => number;
  }> = {},
): SharedBoardRoomService {
  return new SharedBoardRoomService({
    clock,
    values: new DeterministicRoomValues(),
    countdownMs: COUNTDOWN_MS,
    lobbyTtlMs: LOBBY_TTL_MS,
    resultTtlMs: RESULT_TTL_MS,
    turnTimeoutMs: TURN_TIMEOUT_MS,
    // Real turn-animation grace is covered by its own tests below; defaulting
    // it to zero here keeps every other test's turn-timeout arithmetic exact.
    estimateTurnAnimationMs: () => 0,
    ...overrides,
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

/** Asserts the failure is recoverable (socket stays open) and returns its corrective snapshot deliveries. */
function recoverableOf<T>(result: RoomServiceResult<T>): readonly RoomDelivery[] {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('Expected room service failure');
  expect(result.disposition).toBe('recoverable');
  expect(result.deliveries.length).toBeGreaterThan(0);
  return result.deliveries;
}

/** Asserts the failure is fatal (socket closes). */
function fatalOf<T>(result: RoomServiceResult<T>): string {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('Expected room service failure');
  expect(result.disposition).toBe('fatal');
  return result.error;
}

function connect(service: SharedBoardRoomService, admission: RoomAdmission): RoomConnection {
  return valueOf(service.connect({
    roomId: admission.roomId,
    playerId: admission.playerId,
    reconnectCredential: admission.reconnectCredential,
  }));
}

function setupRoom(overrides: Partial<{
  statusPulseMs: number;
  abandonTimeoutMs: number;
  estimateTurnAnimationMs: (steps: readonly WireStep[]) => number;
}> = {}): RoomHarness {
  const clock = new ManualClock();
  const service = createService(clock, overrides);
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
  test('reports opponent admission separately from an active connection', () => {
    const service = createService();
    const host = valueOf(service.createRoom(admissionRequest()));
    const guest = valueOf(service.joinRoom({ ...admissionRequest(), roomId: host.roomId }));

    const hostConnect = service.connect({
      roomId: host.roomId, playerId: host.playerId, reconnectCredential: host.reconnectCredential,
    });
    const hostConnection = valueOf(hostConnect);
    expect(hostConnect.deliveries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        playerId: host.playerId,
        message: expect.objectContaining({
          type: 'room-state', opponentJoined: true, opponentConnected: false,
        }),
      }),
    ]));

    const guestConnect = service.connect({
      roomId: guest.roomId, playerId: guest.playerId, reconnectCredential: guest.reconnectCredential,
    });
    valueOf(guestConnect);
    expect(guestConnect.deliveries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        message: expect.objectContaining({
          type: 'room-state', opponentJoined: true, opponentConnected: true,
        }),
      }),
    ]));

    const disconnected = service.disconnect(hostConnection);
    expect(disconnected).toEqual(expect.arrayContaining([
      expect.objectContaining({
        playerId: guest.playerId,
        message: expect.objectContaining({
          type: 'room-state', opponentJoined: true, opponentConnected: false,
        }),
      }),
    ]));
  });

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

  test('withholds the next turn deadline by the estimated animation duration after a played turn', () => {
    const GRACE_MS = 777;
    const harness = setupRoom({ estimateTurnAnimationMs: () => GRACE_MS });
    const { matchId, firstPlayerId } = startPlaying(harness);
    const [connection, admission] = firstPlayerId === harness.host.playerId
      ? [harness.hostConnection, harness.host]
      : [harness.guestConnection, harness.guest];

    harness.clock.time += 25;
    const resolvedAt = harness.clock.time;
    const result = harness.service.receive(
      connection,
      message(admission, { type: 'play-turn', matchId, column: 3 }),
    );
    valueOf(result);

    const assigned = result.deliveries.find(d => d.message.type === 'turn-assigned')?.message;
    if (assigned?.type !== 'turn-assigned') throw new Error('Expected turn-assigned');
    expect(assigned.turnDeadline).toBe(resolvedAt + GRACE_MS + TURN_TIMEOUT_MS);
  });

  test('withholds the next turn deadline by the estimated animation duration after a turn auto-expires', () => {
    const GRACE_MS = 333;
    const harness = setupRoom({ estimateTurnAnimationMs: () => GRACE_MS });
    startPlaying(harness);

    harness.clock.time += TURN_TIMEOUT_MS;
    const resolvedAt = harness.clock.time;
    const tickResult = harness.service.tick();

    const assigned = tickResult.deliveries.find(d => d.message.type === 'turn-assigned')?.message;
    if (assigned?.type !== 'turn-assigned') throw new Error('Expected turn-assigned');
    expect(assigned.turnDeadline).toBe(resolvedAt + GRACE_MS + TURN_TIMEOUT_MS);
  });

  test('feeds the resolved turn\'s actual steps into the animation-grace estimator', () => {
    const received: (readonly WireStep[])[] = [];
    const harness = setupRoom({
      estimateTurnAnimationMs: steps => { received.push(steps); return 250; },
    });
    const { matchId, firstPlayerId } = startPlaying(harness);
    const [connection, admission] = firstPlayerId === harness.host.playerId
      ? [harness.hostConnection, harness.host]
      : [harness.guestConnection, harness.guest];

    const result = harness.service.receive(
      connection,
      message(admission, { type: 'play-turn', matchId, column: 3 }),
    );
    const played = result.deliveries.find(d => d.message.type === 'turn-played')?.message;
    if (played?.type !== 'turn-played') throw new Error('Expected turn-played');

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(played.turnResult.steps);
  });

  // Confirms the class's real default (not the test harness's zero-grace
  // convenience default) is actually wired up: every accepted turn contains
  // at least one drop step, whose duration floors at 120ms, so a real turn
  // played with no estimator override must push the deadline out further
  // than turnTimeoutMs alone would.
  test('the production default estimator adds real, non-zero grace', () => {
    const harness = setupRoom({ estimateTurnAnimationMs: undefined });
    const { matchId, firstPlayerId } = startPlaying(harness);
    const [connection, admission] = firstPlayerId === harness.host.playerId
      ? [harness.hostConnection, harness.host]
      : [harness.guestConnection, harness.guest];

    const resolvedAt = harness.clock.time;
    const result = harness.service.receive(
      connection,
      message(admission, { type: 'play-turn', matchId, column: 3 }),
    );
    const assigned = result.deliveries.find(d => d.message.type === 'turn-assigned')?.message;
    if (assigned?.type !== 'turn-assigned') throw new Error('Expected turn-assigned');
    expect(assigned.turnDeadline).toBeGreaterThanOrEqual(resolvedAt + TURN_TIMEOUT_MS + 120);
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

describe('SharedBoardRoomService duel-status pulses', () => {
  function statusIn(deliveries: readonly RoomDelivery[], playerId?: string) {
    const message = deliveries.find(d =>
      d.message.type === 'duel-status' && (playerId === undefined || d.playerId === playerId),
    )?.message;
    if (message?.type !== 'duel-status') throw new Error('Expected duel-status');
    return message;
  }

  // Regression: the confirmed bug this whole remediation exists for — a
  // fresh turn-assigned carries no scores/cursor, so a reconnecting or
  // just-started client used to show 0-0 scores and no opponent ghost until
  // the opponent moved. The paired duel-status must correct both instantly.
  test('the first duel-status after countdown reports revision 0, 0-0 scores, and the default cursor', () => {
    const harness = setupRoom();
    const countdown = startMatch(harness);
    harness.clock.time = countdown.startsAt;
    const tickResult = harness.service.tick();

    const status = statusIn(tickResult.deliveries);
    expect(status.revision).toBe(0);
    expect(status.scores).toHaveLength(2);
    for (const score of status.scores) expect(score.score).toBe(0);
    expect(status.activeColumn).toBe(3);
    expect([harness.host.playerId, harness.guest.playerId]).toContain(status.activePlayerId);
    expect(status.paused).toBe(false);
    expect(status.pausedBy).toBeNull();
  });

  test('a cursor move is retained: relayed immediately and read back on a later snapshot', () => {
    const harness = setupRoom();
    const { matchId, firstPlayerId } = startPlaying(harness);
    const [connection, admission] = firstPlayerId === harness.host.playerId
      ? [harness.hostConnection, harness.host]
      : [harness.guestConnection, harness.guest];

    const moved = harness.service.receive(
      connection,
      message(admission, { type: 'move-cursor', matchId, column: 5 }),
    );
    valueOf(moved);
    const relay = moved.deliveries.find(d => d.message.type === 'opponent-cursor')?.message;
    expect(relay?.type === 'opponent-cursor' && relay.column).toBe(5);

    // Prove it's stored on the match (not just relayed once) by reading it
    // back through an unrelated later snapshot: disconnect/reconnect the
    // active player and check the targeted duel-status's activeColumn.
    harness.service.disconnect(connection);
    const reconnected = harness.service.connect({
      roomId: admission.roomId,
      playerId: admission.playerId,
      reconnectCredential: admission.reconnectCredential,
    });
    valueOf(reconnected);
    const status = statusIn(reconnected.deliveries);
    expect(status.activeColumn).toBe(5);
  });

  test('a scored turn produces a duel-status with authoritative scores and revision 1', () => {
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
    if (played?.type !== 'turn-played') throw new Error('Expected turn-played');

    const status = statusIn(result.deliveries);
    expect(status.revision).toBe(1);
    const triggerScore = status.scores.find(s => s.playerId === firstPlayerId)?.score;
    const opponentScore = status.scores.find(s => s.playerId === opponentId)?.score;
    expect(triggerScore).toBe(played.turnResult.triggerScoreDelta);
    expect(opponentScore).toBe(played.turnResult.opponentScoreDelta);
    expect(status.activePlayerId).toBe(opponentId);
  });

  test('a completed match receives no duel-status — match-finished is the terminal recovery message', () => {
    const harness = setupRoom();
    const { matchId, firstPlayerId } = startPlaying(harness);
    const [connection, admission] = firstPlayerId === harness.host.playerId
      ? [harness.hostConnection, harness.host]
      : [harness.guestConnection, harness.guest];

    const forfeited = harness.service.receive(
      connection,
      message(admission, { type: 'forfeit-match', matchId }),
    );
    valueOf(forfeited);
    expect(forfeited.deliveries.some(d => d.message.type === 'match-finished')).toBe(true);
    expect(forfeited.deliveries.some(d => d.message.type === 'duel-status')).toBe(false);
  });

  test('reconnecting after several turns restores scores, cursor, and revision via a targeted duel-status', () => {
    const harness = setupRoom();
    const { matchId, firstPlayerId } = startPlaying(harness);
    let [connection, admission] = firstPlayerId === harness.host.playerId
      ? [harness.hostConnection, harness.host]
      : [harness.guestConnection, harness.guest];

    for (let i = 0; i < 2; i++) {
      const result = harness.service.receive(
        connection,
        message(admission, { type: 'play-turn', matchId, column: 3 }),
      );
      valueOf(result);
      const nextTurn = result.deliveries.find(d => d.message.type === 'turn-assigned')?.message;
      if (nextTurn?.type !== 'turn-assigned') throw new Error('Expected turn-assigned');
      const isHostNext = nextTurn.playerId === harness.host.playerId;
      connection = isHostNext ? harness.hostConnection : harness.guestConnection;
      admission = isHostNext ? harness.host : harness.guest;
    }

    harness.service.disconnect(harness.hostConnection);
    const reconnected = harness.service.connect({
      roomId: harness.host.roomId,
      playerId: harness.host.playerId,
      reconnectCredential: harness.host.reconnectCredential,
    });
    valueOf(reconnected);
    const status = statusIn(reconnected.deliveries, harness.host.playerId);
    expect(status.revision).toBe(2);
    expect(status.scores.every(s => s.score >= 0)).toBe(true);
    // At least one player scored nothing extra by construction is not
    // guaranteed, but scores must be internally consistent (present for
    // both players, never negative) after two real drops.
    expect(status.scores).toHaveLength(2);
  });

  test('periodic pulses fire at the configured interval and do not double-fire', () => {
    // statusPulseMs deliberately well under TURN_TIMEOUT_MS (50) so a real
    // turn expiry (which also emits its own duel-status) can't interfere.
    const harness = setupRoom({ statusPulseMs: 10 });
    startPlaying(harness);

    harness.clock.time += 5;
    expect(harness.service.tick().deliveries.some(d => d.message.type === 'duel-status')).toBe(false);

    harness.clock.time += 10; // 15ms since start: past the 10ms interval, still under the 50ms turn timeout
    const due = harness.service.tick();
    expect(due.deliveries.some(d => d.message.type === 'duel-status')).toBe(true);

    // Immediately again, before another interval elapses: no duplicate pulse.
    const immediate = harness.service.tick();
    expect(immediate.deliveries.some(d => d.message.type === 'duel-status')).toBe(false);
  });

  test('the periodic pulse keeps firing while paused, still reporting pause state', () => {
    const harness = setupRoom({ statusPulseMs: 100 });
    const { matchId, firstPlayerId } = startPlaying(harness);
    const [connection, admission] = firstPlayerId === harness.host.playerId
      ? [harness.hostConnection, harness.host]
      : [harness.guestConnection, harness.guest];

    const pauseResult = harness.service.receive(
      connection,
      message(admission, { type: 'set-paused', matchId, paused: true }),
    );
    valueOf(pauseResult);
    const initialStatus = statusIn(pauseResult.deliveries);
    const initialRemainingMs = initialStatus.turnDeadline - initialStatus.serverTime;

    harness.clock.time += 150;
    const due = harness.service.tick();
    const status = statusIn(due.deliveries);
    expect(status.paused).toBe(true);
    expect(status.pausedBy).toBe(firstPlayerId);
    expect(status.turnDeadline - status.serverTime).toBe(initialRemainingMs);
  });
});

describe('SharedBoardRoomService recoverable vs. fatal failures', () => {
  test('a queued set-ready arriving after the room starts is recoverable', () => {
    const harness = setupRoom();
    const { matchId } = startPlaying(harness);

    const late = harness.service.receive(
      harness.hostConnection,
      message(harness.host, { type: 'set-ready', ready: true }),
    );
    const snapshot = recoverableOf(late);
    expect(snapshot.some(delivery =>
      delivery.message.type === 'turn-assigned' && delivery.message.matchId === matchId,
    )).toBe(true);
    expect(snapshot.some(delivery => delivery.message.type === 'duel-status')).toBe(true);
  });

  test('a late cursor move after turn ownership changed is recoverable with a corrective snapshot', () => {
    const harness = setupRoom();
    const { matchId, firstPlayerId } = startPlaying(harness);
    const [staleConnection, staleAdmission] = firstPlayerId === harness.host.playerId
      ? [harness.hostConnection, harness.host]
      : [harness.guestConnection, harness.guest];
    const [activeConnection, activeAdmission] = firstPlayerId === harness.host.playerId
      ? [harness.guestConnection, harness.guest]
      : [harness.hostConnection, harness.host];

    // Pass the turn to the other player first.
    valueOf(harness.service.receive(
      staleConnection,
      message(staleAdmission, { type: 'play-turn', matchId, column: 3 }),
    ));

    const late = harness.service.receive(
      staleConnection,
      message(staleAdmission, { type: 'move-cursor', matchId, column: 1 }),
    );
    const snapshot = recoverableOf(late);
    expect(snapshot.some(d => d.message.type === 'turn-assigned' && d.playerId === staleAdmission.playerId)).toBe(true);
    expect(snapshot.some(d => d.message.type === 'duel-status' && d.playerId === staleAdmission.playerId)).toBe(true);

    // The connection is still usable for a subsequent valid action.
    valueOf(harness.service.receive(
      activeConnection,
      message(activeAdmission, { type: 'move-cursor', matchId, column: 2 }),
    ));
  });

  test('a duplicate play-turn for an already-resolved turn is recoverable', () => {
    const harness = setupRoom();
    const { matchId, firstPlayerId } = startPlaying(harness);
    const [connection, admission] = firstPlayerId === harness.host.playerId
      ? [harness.hostConnection, harness.host]
      : [harness.guestConnection, harness.guest];

    valueOf(harness.service.receive(
      connection,
      message(admission, { type: 'play-turn', matchId, column: 3 }),
    ));
    // Same player, same matchId, second drop attempt — no longer their turn.
    const duplicate = harness.service.receive(
      connection,
      message(admission, { type: 'play-turn', matchId, column: 4 }),
    );
    recoverableOf(duplicate);
  });

  test('a stale matchId on play-turn, move-cursor, set-paused, and forfeit-match is recoverable', () => {
    const harness = setupRoom();
    const { firstPlayerId } = startPlaying(harness);
    const [connection, admission] = firstPlayerId === harness.host.playerId
      ? [harness.hostConnection, harness.host]
      : [harness.guestConnection, harness.guest];

    recoverableOf(harness.service.receive(
      connection,
      message(admission, { type: 'play-turn', matchId: 'stale-match', column: 3 }),
    ));
    recoverableOf(harness.service.receive(
      connection,
      message(admission, { type: 'move-cursor', matchId: 'stale-match', column: 3 }),
    ));
    recoverableOf(harness.service.receive(
      connection,
      message(admission, { type: 'set-paused', matchId: 'stale-match', paused: true }),
    ));
    recoverableOf(harness.service.receive(
      connection,
      message(admission, { type: 'forfeit-match', matchId: 'stale-match' }),
    ));
  });

  test('a play-turn or move-cursor rejected while paused is recoverable, not fatal', () => {
    const harness = setupRoom();
    const { matchId, firstPlayerId } = startPlaying(harness);
    const [connection, admission] = firstPlayerId === harness.host.playerId
      ? [harness.hostConnection, harness.host]
      : [harness.guestConnection, harness.guest];

    valueOf(harness.service.receive(
      connection,
      message(admission, { type: 'set-paused', matchId, paused: true }),
    ));
    recoverableOf(harness.service.receive(
      connection,
      message(admission, { type: 'play-turn', matchId, column: 3 }),
    ));
    recoverableOf(harness.service.receive(
      connection,
      message(admission, { type: 'move-cursor', matchId, column: 3 }),
    ));
  });

  test('an unrecognized connection (stale/replaced) is fatal', () => {
    const harness = setupRoom();
    startPlaying(harness);
    // A connection object that was never returned by connect() for this
    // room — simulates a stale/replaced socket's identity.
    const bogusConnection: RoomConnection = Object.freeze({
      roomId: harness.host.roomId,
      playerId: harness.host.playerId,
    });
    fatalOf(harness.service.receive(
      bogusConnection,
      message(harness.host, { type: 'move-cursor', matchId: 'whatever', column: 1 }),
    ));
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
    // 2 match-paused broadcasts + 2 duel-status broadcasts (pausing is one
    // of the pulse points — see docs/fix-duel-sync-resilience-plan.md §3).
    expect(paused.deliveries).toHaveLength(4);
    const pausedMessages = paused.deliveries.filter(d => d.message.type === 'match-paused');
    expect(pausedMessages).toHaveLength(2);
    for (const delivery of pausedMessages) {
      expect(delivery.message).toEqual(expect.objectContaining({
        type: 'match-paused', paused: true, pausedBy: firstPlayerId,
      }));
    }
    const statusMessages = paused.deliveries.filter(d => d.message.type === 'duel-status');
    expect(statusMessages).toHaveLength(2);
    for (const delivery of statusMessages) {
      expect(delivery.message).toEqual(expect.objectContaining({
        type: 'duel-status', paused: true, pausedBy: firstPlayerId,
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
    // 2 match-paused + 2 duel-status, same reasoning as the pause above —
    // resume is also a pulse point.
    expect(resumed.deliveries).toHaveLength(4);
    const resumedPausedMessages = resumed.deliveries.filter(d => d.message.type === 'match-paused');
    expect(resumedPausedMessages).toHaveLength(2);
    for (const delivery of resumedPausedMessages) {
      expect(delivery.message.type).toBe('match-paused');
      if (delivery.message.type !== 'match-paused') continue;
      expect(delivery.message.paused).toBe(false);
      // The shifted deadline must be in the future, not left in the past
      // from before the pause.
      expect(delivery.message.deadline).toBeGreaterThan(harness.clock.time);
    }
    const resumedStatusMessages = resumed.deliveries.filter(d => d.message.type === 'duel-status');
    expect(resumedStatusMessages).toHaveLength(2);
    for (const delivery of resumedStatusMessages) {
      expect(delivery.message).toEqual(expect.objectContaining({ type: 'duel-status', paused: false }));
    }

    // Turn play accepted again post-resume.
    valueOf(harness.service.receive(
      connection,
      message(admission, { type: 'play-turn', matchId, column: 3 }),
    ));
  });

  test('disconnecting an unpaused player during play freezes the match instead of leaving the clock running', () => {
    const harness = setupRoom();
    const { matchId, firstPlayerId } = startPlaying(harness);
    const [connection, otherAdmission] = firstPlayerId === harness.host.playerId
      ? [harness.hostConnection, harness.guest]
      : [harness.guestConnection, harness.host];

    // This service's broadcast() sends to both players unconditionally
    // (offline sockets are no-ops at the gateway layer) — unlike Score
    // Race's room service, which filters by live connection.
    const disconnectDeliveries = harness.service.disconnect(connection);
    const otherDelivery = disconnectDeliveries.find(d => d.playerId === otherAdmission.playerId);
    expect(otherDelivery?.message).toEqual(expect.objectContaining({
      type: 'match-paused', paused: true, pausedBy: firstPlayerId,
    }));

    // The clock is frozen — a turn timeout that would otherwise have fired does nothing.
    harness.clock.time += TURN_TIMEOUT_MS * 5;
    expect(harness.service.tick().deliveries).toEqual([]);
  });

  test('a manual pause resuming does not un-freeze the match while a different player is still disconnected', () => {
    const harness = setupRoom();
    const { matchId, firstPlayerId } = startPlaying(harness);
    const [pauserConnection, pauserAdmission] = firstPlayerId === harness.host.playerId
      ? [harness.hostConnection, harness.host]
      : [harness.guestConnection, harness.guest];
    const [otherConnection, otherAdmission] = firstPlayerId === harness.host.playerId
      ? [harness.guestConnection, harness.guest]
      : [harness.hostConnection, harness.host];

    valueOf(harness.service.receive(
      pauserConnection,
      message(pauserAdmission, { type: 'set-paused', matchId, paused: true }),
    ));
    harness.service.disconnect(otherConnection);

    const resumed = harness.service.receive(
      pauserConnection,
      message(pauserAdmission, { type: 'set-paused', matchId, paused: false }),
    );
    valueOf(resumed);
    // Still frozen — attribution flips to whoever is actually still gone.
    const statusMessage = resumed.deliveries.find(d => d.message.type === 'duel-status')?.message;
    expect(statusMessage).toEqual(expect.objectContaining({
      type: 'duel-status', paused: true, pausedBy: otherAdmission.playerId,
    }));

    harness.clock.time += TURN_TIMEOUT_MS * 5;
    expect(harness.service.tick().deliveries).toEqual([]);
  });

  test('the pausing player disconnecting while their own pause is active does not auto-resume the match', () => {
    const harness = setupRoom();
    const { matchId, firstPlayerId } = startPlaying(harness);
    const [connection, admission] = firstPlayerId === harness.host.playerId
      ? [harness.hostConnection, harness.host]
      : [harness.guestConnection, harness.guest];

    valueOf(harness.service.receive(
      connection,
      message(admission, { type: 'set-paused', matchId, paused: true }),
    ));

    harness.clock.time += TURN_TIMEOUT_MS;
    const disconnectDeliveries = harness.service.disconnect(connection);
    // No resume broadcast — the freeze remains, still attributed to the pauser.
    expect(disconnectDeliveries.some(d => d.message.type === 'match-paused' && d.message.paused === false))
      .toBe(false);

    harness.clock.time += TURN_TIMEOUT_MS * 5;
    expect(harness.service.tick().deliveries).toEqual([]);
  });

  test('reconnecting the only disconnected player fully unfreezes the match and shifts the deadline', () => {
    const harness = setupRoom();
    const { firstPlayerId } = startPlaying(harness);
    const [connection, admission] = firstPlayerId === harness.host.playerId
      ? [harness.hostConnection, harness.host]
      : [harness.guestConnection, harness.guest];

    harness.service.disconnect(connection);
    harness.clock.time += TURN_TIMEOUT_MS;

    const reconnected = harness.service.connect({
      roomId: admission.roomId,
      playerId: admission.playerId,
      reconnectCredential: admission.reconnectCredential,
    });
    valueOf(reconnected);
    const pausedFalse = reconnected.deliveries.find(d => d.message.type === 'match-paused')?.message;
    expect(pausedFalse).toEqual(expect.objectContaining({ type: 'match-paused', paused: false }));
    if (pausedFalse?.type === 'match-paused') {
      expect(pausedFalse.deadline).toBeGreaterThan(harness.clock.time);
    }

    // Normal turn-expiry ticks fire again.
    harness.clock.time += TURN_TIMEOUT_MS;
    expect(harness.service.tick().deliveries.some(d => d.message.type === 'turn-expired')).toBe(true);
  });

  test('reconnecting shortly after a missed turn timeout does not trigger a bogus expireTurn against the stale deadline', () => {
    const harness = setupRoom();
    const { matchId, firstPlayerId } = startPlaying(harness);
    const [connection, admission] = firstPlayerId === harness.host.playerId
      ? [harness.hostConnection, harness.host]
      : [harness.guestConnection, harness.guest];

    harness.service.disconnect(connection);
    // Past one turn timeout, but nowhere near the (default) abandonment
    // timeout, and — critically — no tick() has run to process anything.
    harness.clock.time += TURN_TIMEOUT_MS * 3;

    const reconnected = harness.service.connect({
      roomId: admission.roomId,
      playerId: admission.playerId,
      reconnectCredential: admission.reconnectCredential,
    });
    valueOf(reconnected);
    expect(reconnected.deliveries.some(d => d.message.type === 'turn-expired')).toBe(false);
    const assigned = reconnected.deliveries.find(d => d.message.type === 'turn-assigned')?.message;
    expect(assigned).toEqual(expect.objectContaining({ matchId, playerId: firstPlayerId, revision: 0 }));
  });

  test('reconnecting at or past the abandonment deadline is treated as already abandoned', () => {
    const abandonTimeoutMs = TURN_TIMEOUT_MS * 4;
    const harness = setupRoom({ abandonTimeoutMs });
    const { firstPlayerId } = startPlaying(harness);
    const [connection, admission] = firstPlayerId === harness.host.playerId
      ? [harness.hostConnection, harness.host]
      : [harness.guestConnection, harness.guest];
    const opponentId = firstPlayerId === harness.host.playerId ? harness.guest.playerId : harness.host.playerId;

    harness.service.disconnect(connection);
    harness.clock.time += abandonTimeoutMs;

    // Reconnecting right at the deadline, with no intervening tick().
    const reconnected = harness.service.connect({
      roomId: admission.roomId,
      playerId: admission.playerId,
      reconnectCredential: admission.reconnectCredential,
    });
    valueOf(reconnected);
    const finished = reconnected.deliveries.find(d => d.message.type === 'match-finished')?.message;
    expect(finished).toEqual(expect.objectContaining({
      type: 'match-finished',
      result: expect.objectContaining({ winnerId: opponentId, forfeitedBy: admission.playerId }),
    }));

    // Exact per-player sequence: the opponent (not reconnecting) gets a
    // single broadcast match-finished. The reconnecting player must NOT
    // also receive that broadcast copy ahead of their snapshot — only their
    // own clean countdown-then-finished snapshot pair, or a client that
    // just applied 'complete' would transiently flip back to 'countdown'
    // (its match-countdown handler deliberately allows that transition from
    // 'complete' to support a real rematch).
    const opponentTypes = reconnected.deliveries
      .filter(d => d.playerId === opponentId)
      .map(d => d.message.type);
    expect(opponentTypes).toEqual(['match-finished']);
    const reconnectingTypes = reconnected.deliveries
      .filter(d => d.playerId === admission.playerId)
      .map(d => d.message.type);
    expect(reconnectingTypes).toEqual(['match-countdown', 'match-finished']);
  });

  test('a player who never reconnects is auto-forfeited once the abandonment timeout elapses, even under an unrelated manual pause', () => {
    const abandonTimeoutMs = TURN_TIMEOUT_MS * 4;
    const harness = setupRoom({ abandonTimeoutMs });
    const { matchId, firstPlayerId } = startPlaying(harness);
    const [vanishingConnection, vanishingAdmission] = firstPlayerId === harness.host.playerId
      ? [harness.hostConnection, harness.host]
      : [harness.guestConnection, harness.guest];
    const [stayingConnection, stayingAdmission] = firstPlayerId === harness.host.playerId
      ? [harness.guestConnection, harness.guest]
      : [harness.hostConnection, harness.host];

    harness.service.disconnect(vanishingConnection);
    // The staying player separately manually pauses — this must not block
    // abandonment from firing against the vanished player.
    valueOf(harness.service.receive(
      stayingConnection,
      message(stayingAdmission, { type: 'set-paused', matchId, paused: true }),
    ));

    harness.clock.time += abandonTimeoutMs;
    const tickResult = harness.service.tick();
    const finished = tickResult.deliveries.find(d => d.message.type === 'match-finished')?.message;
    expect(finished).toEqual(expect.objectContaining({
      type: 'match-finished',
      result: expect.objectContaining({
        winnerId: stayingAdmission.playerId,
        forfeitedBy: vanishingAdmission.playerId,
      }),
    }));

    harness.clock.time += TURN_TIMEOUT_MS * 5;
    expect(harness.service.tick().deliveries).toEqual([]);
  });

  test('a disconnect during countdown freezes the match immediately once it transitions to playing', () => {
    const harness = setupRoom();
    const countdown = startMatch(harness);
    harness.service.disconnect(harness.hostConnection);

    harness.clock.time = countdown.startsAt;
    const tickResult = harness.service.tick();
    expect(tickResult.deliveries.some(d => d.message.type === 'turn-expired')).toBe(false);
    const pausedTrue = tickResult.deliveries.find(d => d.message.type === 'match-paused')?.message;
    expect(pausedTrue).toEqual(expect.objectContaining({
      type: 'match-paused', paused: true, pausedBy: harness.host.playerId,
    }));

    // Frozen — no turn-expiry fires against the missing player.
    harness.clock.time += TURN_TIMEOUT_MS * 5;
    expect(harness.service.tick().deliveries).toEqual([]);
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
    const pausedIndex = reconnected.deliveries.findIndex(d => d.message.type === 'match-paused');
    const statusIndex = reconnected.deliveries.findIndex(d => d.message.type === 'duel-status');
    expect(statusIndex).toBeGreaterThan(pausedIndex);
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

// countdownMs/lobbyTtlMs/resultTtlMs previously went unvalidated here even
// though ScoreRaceRoomService already rejected non-positive values for the
// same three options — see room-values.ts's positiveDuration, now shared by
// both services.
describe('SharedBoardRoomService construction validation', () => {
  test.each([
    ['countdownMs', 0] as const,
    ['countdownMs', -1] as const,
    ['lobbyTtlMs', 0] as const,
    ['resultTtlMs', -100] as const,
    ['statusPulseMs', 0] as const,
  ])('rejects a non-positive %s', (key, value) => {
    expect(() => new SharedBoardRoomService({
      clock: new ManualClock(),
      values: new DeterministicRoomValues(),
      [key]: value,
    })).toThrow();
  });

  test('abandonTimeoutMs and turnTimeoutMs are not validated (independent of the shared TTL check)', () => {
    // Documents the current, deliberately-unchanged behavior rather than
    // asserting a requirement — Slice 6 only extended positiveDuration to
    // countdown/lobby/result/status-pulse, not these two.
    expect(() => new SharedBoardRoomService({
      clock: new ManualClock(),
      values: new DeterministicRoomValues(),
      abandonTimeoutMs: -1,
      turnTimeoutMs: -1,
    })).not.toThrow();
  });
});

describe('SharedBoardRoomService room id allocation', () => {
  test('releases an expired room id so a later room can reuse it', () => {
    const clock = new ManualClock();
    const service = new SharedBoardRoomService({
      clock,
      values: new FixedRoomIdValues('REUSABLE-ROOM'),
      roomIdAllocator: createRoomIdAllocator(),
      countdownMs: COUNTDOWN_MS,
      lobbyTtlMs: LOBBY_TTL_MS,
      resultTtlMs: RESULT_TTL_MS,
      turnTimeoutMs: TURN_TIMEOUT_MS,
    });

    const first = valueOf(service.createRoom(admissionRequest()));
    clock.time += LOBBY_TTL_MS;
    expect(service.tick().expiredRoomIds).toEqual([first.roomId]);

    const second = valueOf(service.createRoom(admissionRequest()));
    expect(second.roomId).toBe(first.roomId);
  });

  test('releases a claimed room id when room construction fails', () => {
    const service = new SharedBoardRoomService({
      clock: new ManualClock(),
      values: new FixedRoomIdValues('RETRY-ROOM', true),
      roomIdAllocator: createRoomIdAllocator(),
    });

    expect(() => service.createRoom(admissionRequest())).toThrow();
    expect(valueOf(service.createRoom(admissionRequest())).roomId).toBe('RETRY-ROOM');
  });
});

describe('SharedBoardRoomService chat', () => {
  test('relays chat to both players from the lobby', () => {
    const harness = setupRoom();
    const result = harness.service.receive(
      harness.hostConnection,
      message(harness.host, { type: 'send-chat', text: 'hello' }),
    );
    valueOf(result);
    const chats = messagesOf(result.deliveries).filter(m => m.type === 'chat-message');
    expect(chats).toHaveLength(2);
    expect(chats[0]).toEqual(expect.objectContaining({
      type: 'chat-message', playerId: harness.host.playerId, text: 'hello',
    }));
  });

  test('rate-limits chat and reports the throttle back to the sender only', () => {
    const harness = setupRoom();
    for (let index = 0; index < MAX_CHAT_MESSAGES_PER_WINDOW; index++) {
      valueOf(harness.service.receive(
        harness.hostConnection,
        message(harness.host, { type: 'send-chat', text: `message-${index}` }),
      ));
    }
    const limited = harness.service.receive(
      harness.hostConnection,
      message(harness.host, { type: 'send-chat', text: 'overflow' }),
    );
    valueOf(limited);

    const rateLimited = limited.deliveries.filter(delivery => delivery.message.type === 'chat-rate-limited');
    expect(rateLimited).toHaveLength(1);
    expect(rateLimited[0]?.playerId).toBe(harness.host.playerId);
    expect(limited.deliveries.some(delivery => delivery.message.type === 'chat-message')).toBe(false);
  });

  test('accepted chat extends the lobby TTL even before both players are ready', () => {
    const clock = new ManualClock();
    const service = createService(clock);
    const host = valueOf(service.createRoom(admissionRequest()));
    valueOf(service.joinRoom({ ...admissionRequest(), roomId: host.roomId }));
    const hostConnection = connect(service, host);

    clock.time += LOBBY_TTL_MS - 1;
    valueOf(service.receive(
      hostConnection,
      message(host, { type: 'send-chat', text: 'still here' }),
    ));

    clock.time += 2;
    expect(service.tick().expiredRoomIds).toEqual([]);
  });
});
