import { describe, expect, test } from 'vitest';
import {
  MULTIPLAYER_PROTOCOL_VERSION,
  SCORE_RACE_DURATION_MS,
} from '../src/multiplayer/contracts.js';
import {
  SCORE_RACE_ROOM_MODE,
  ScoreRaceRoomService,
} from '../src/multiplayer/room-service.js';
import { MAX_CHAT_MESSAGES_PER_WINDOW } from '../src/multiplayer/chat-policy.js';
import { createRoomIdAllocator } from '../src/multiplayer/room-values.js';
import type {
  MultiplayerClientMessage,
  MultiplayerModeIdentity,
  MultiplayerProgress,
} from '../src/multiplayer/contracts.js';
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
  readonly service: ScoreRaceRoomService;
  readonly host: RoomAdmission;
  readonly guest: RoomAdmission;
  readonly hostConnection: RoomConnection;
  readonly guestConnection: RoomConnection;
}

function createService(clock = new ManualClock()): ScoreRaceRoomService {
  return new ScoreRaceRoomService({
    clock,
    values: new DeterministicRoomValues(),
    countdownMs: COUNTDOWN_MS,
    lobbyTtlMs: LOBBY_TTL_MS,
    resultTtlMs: RESULT_TTL_MS,
  });
}

function admissionRequest(mode: MultiplayerModeIdentity = SCORE_RACE_ROOM_MODE) {
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

function deliveriesOf<T>(result: RoomServiceResult<T>): readonly RoomDelivery[] {
  return result.deliveries;
}

function errorOf<T>(result: RoomServiceResult<T>): string {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('Expected room service failure');
  return result.error;
}

function connect(service: ScoreRaceRoomService, admission: RoomAdmission): RoomConnection {
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

function startMatch(harness: RoomHarness) {
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
  expect(countdown?.type).toBe('match-countdown');
  if (!countdown || countdown.type !== 'match-countdown') {
    throw new Error('Expected match countdown');
  }
  return countdown;
}

function progress(
  sequence: number,
  score: number,
  turnsPlayed = sequence,
): MultiplayerProgress {
  return { sequence, score, turnsPlayed };
}

function deliveriesFor(
  deliveries: readonly RoomDelivery[],
  playerId: string,
  type?: RoomDelivery['message']['type'],
): readonly RoomDelivery[] {
  return deliveries.filter(delivery => delivery.playerId === playerId
    && (type === undefined || delivery.message.type === type));
}

describe('ScoreRaceRoomService', () => {
  test('admits exactly two compatible guests and protects reconnect credentials', () => {
    const service = createService();
    expect(errorOf(service.createRoom({
      protocolVersion: 99,
      mode: SCORE_RACE_ROOM_MODE,
    }))).toBe('protocol-mismatch');
    expect(errorOf(service.createRoom(admissionRequest({
      ...SCORE_RACE_ROOM_MODE,
      version: SCORE_RACE_ROOM_MODE.version + 1,
    })))).toBe('mode-mismatch');

    const host = valueOf(service.createRoom(admissionRequest()));
    expect(host).toEqual({
      roomId: 'ROOM-1',
      playerId: 'player-1',
      reconnectCredential: 'credential-1',
      mode: SCORE_RACE_ROOM_MODE,
    });
    expect(errorOf(service.connect({
      roomId: host.roomId,
      playerId: host.playerId,
      reconnectCredential: 'not-the-credential',
    }))).toBe('invalid-credential');
    expect(errorOf(service.joinRoom({
      ...admissionRequest({
        ...SCORE_RACE_ROOM_MODE,
        rules: {
          ...SCORE_RACE_ROOM_MODE.rules,
          version: SCORE_RACE_ROOM_MODE.rules.version + 1,
        },
      }),
      roomId: host.roomId,
    }))).toBe('mode-mismatch');

    const guest = valueOf(service.joinRoom({
      ...admissionRequest(),
      roomId: host.roomId,
    }));
    expect(guest.playerId).not.toBe(host.playerId);
    expect(guest.reconnectCredential).not.toBe(host.reconnectCredential);
    expect(errorOf(service.joinRoom({
      ...admissionRequest(),
      roomId: host.roomId,
    }))).toBe('room-full');
    expect(errorOf(service.joinRoom({
      ...admissionRequest(),
      roomId: 'missing',
    }))).toBe('room-not-found');
  });

  test('broadcasts localized readiness and one authoritative countdown', () => {
    const clock = new ManualClock();
    const service = createService(clock);
    const host = valueOf(service.createRoom(admissionRequest()));
    const hostConnected = service.connect({
      roomId: host.roomId,
      playerId: host.playerId,
      reconnectCredential: host.reconnectCredential,
    });
    const hostConnection = valueOf(hostConnected);
    expect(hostConnected.deliveries).toEqual([{
      playerId: host.playerId,
      message: {
        protocolVersion: MULTIPLAYER_PROTOCOL_VERSION,
        roomId: host.roomId,
        mode: SCORE_RACE_ROOM_MODE,
        type: 'room-state',
        localReady: false,
        opponentReady: false,
        opponentJoined: false,
        opponentConnected: false,
      },
    }]);

    const guest = valueOf(service.joinRoom({
      ...admissionRequest(),
      roomId: host.roomId,
    }));
    const guestConnected = service.connect({
      roomId: guest.roomId,
      playerId: guest.playerId,
      reconnectCredential: guest.reconnectCredential,
    });
    const guestConnection = valueOf(guestConnected);
    expect(guestConnected.deliveries).toHaveLength(2);
    expect(guestConnected.deliveries.map(delivery => delivery.message)).toEqual([
      expect.objectContaining({
        type: 'room-state',
        opponentJoined: true,
        opponentConnected: true,
      }),
      expect.objectContaining({
        type: 'room-state',
        opponentJoined: true,
        opponentConnected: true,
      }),
    ]);

    const hostReady = service.receive(
      hostConnection,
      message(host, { type: 'set-ready', ready: true }),
    );
    valueOf(hostReady);
    expect(hostReady.deliveries.map(delivery => delivery.message)).toEqual([
      expect.objectContaining({
        type: 'room-state',
        localReady: true,
        opponentReady: false,
      }),
      expect.objectContaining({
        type: 'room-state',
        localReady: false,
        opponentReady: true,
      }),
    ]);

    const guestReady = service.receive(
      guestConnection,
      message(guest, { type: 'set-ready', ready: true }),
    );
    valueOf(guestReady);
    const countdowns = guestReady.deliveries.filter(
      delivery => delivery.message.type === 'match-countdown',
    );
    expect(countdowns).toHaveLength(2);
    expect(countdowns[0]?.message).toEqual({
      protocolVersion: MULTIPLAYER_PROTOCOL_VERSION,
      roomId: host.roomId,
      mode: SCORE_RACE_ROOM_MODE,
      type: 'match-countdown',
      matchId: 'match-1',
      startsAt: clock.now() + COUNTDOWN_MS,
      deadline: clock.now() + COUNTDOWN_MS + SCORE_RACE_DURATION_MS,
      seed: 41,
    });
    expect(countdowns[1]?.message).toEqual(countdowns[0]?.message);

    expect(errorOf(service.receive(
      hostConnection,
      message(host, {
        type: 'publish-progress',
        matchId: 'match-1',
        progress: progress(1, 10),
      }),
    ))).toBe('invalid-state');
  });

  test('clears lobby readiness on disconnect without removing the player', () => {
    const harness = setupRoom();
    valueOf(harness.service.receive(
      harness.hostConnection,
      message(harness.host, { type: 'set-ready', ready: true }),
    ));

    const disconnected = harness.service.disconnect(harness.hostConnection);
    expect(disconnected).toEqual([{
      playerId: harness.guest.playerId,
      message: expect.objectContaining({
        type: 'room-state',
        localReady: false,
        opponentReady: false,
        opponentJoined: true,
        opponentConnected: false,
      }),
    }]);

    const reconnected = harness.service.connect({
      roomId: harness.host.roomId,
      playerId: harness.host.playerId,
      reconnectCredential: harness.host.reconnectCredential,
    });
    valueOf(reconnected);
    expect(reconnected.deliveries).toEqual([
      {
        playerId: harness.host.playerId,
        message: expect.objectContaining({
          type: 'room-state',
          localReady: false,
          opponentReady: false,
        }),
      },
      {
        playerId: harness.guest.playerId,
        message: expect.objectContaining({
          type: 'room-state',
          localReady: false,
          opponentReady: false,
        }),
      },
    ]);
  });

  test('accepts only monotonic player-owned progress and makes replay idempotent', () => {
    const harness = setupRoom();
    const countdown = startMatch(harness);
    harness.clock.time = countdown.startsAt;

    expect(errorOf(harness.service.receive(
      harness.hostConnection,
      message(harness.host, {
        type: 'publish-progress',
        matchId: 'not-this-match',
        progress: progress(1, 10),
      }),
    ))).toBe('match-mismatch');

    const first = harness.service.receive(
      harness.hostConnection,
      message(harness.host, {
        type: 'publish-progress',
        matchId: countdown.matchId,
        progress: progress(1, 10),
      }),
    );
    valueOf(first);
    expect(first.deliveries).toEqual([{
      playerId: harness.guest.playerId,
      message: expect.objectContaining({
        type: 'opponent-progress',
        matchId: countdown.matchId,
        progress: {
          playerId: harness.host.playerId,
          sequence: 1,
          score: 10,
          turnsPlayed: 1,
          finished: false,
        },
      }),
    }]);

    const replay = harness.service.receive(
      harness.hostConnection,
      message(harness.host, {
        type: 'publish-progress',
        matchId: countdown.matchId,
        progress: progress(1, 10),
      }),
    );
    valueOf(replay);
    expect(replay.deliveries).toEqual([]);
    expect(errorOf(harness.service.receive(
      harness.hostConnection,
      message(harness.host, {
        type: 'publish-progress',
        matchId: countdown.matchId,
        progress: progress(0, 10),
      }),
    ))).toBe('stale-progress');
    expect(errorOf(harness.service.receive(
      harness.hostConnection,
      message(harness.host, {
        type: 'publish-progress',
        matchId: countdown.matchId,
        progress: progress(1, 11),
      }),
    ))).toBe('conflicting-progress');
    expect(errorOf(harness.service.receive(
      harness.hostConnection,
      message(harness.host, {
        type: 'publish-progress',
        matchId: countdown.matchId,
        progress: progress(2, 9),
      }),
    ))).toBe('non-monotonic-progress');

    expect(errorOf(harness.service.receive(
      harness.hostConnection,
      {
        ...message(harness.host, { type: 'set-ready', ready: false }),
        playerId: harness.guest.playerId,
      },
    ))).toBe('stale-connection');
  });

  test('preserves monotonic progress across a long deterministic update sequence', () => {
    const harness = setupRoom();
    const countdown = startMatch(harness);
    harness.clock.time = countdown.startsAt;
    let score = 0;
    const observed: MultiplayerProgress[] = [];

    for (let sequence = 1; sequence <= 100; sequence++) {
      score += sequence % 7;
      const next = progress(sequence, score);
      const accepted = harness.service.receive(
        harness.hostConnection,
        message(harness.host, {
          type: 'publish-progress',
          matchId: countdown.matchId,
          progress: next,
        }),
      );
      valueOf(accepted);
      const update = accepted.deliveries[0]?.message;
      expect(update?.type).toBe('opponent-progress');
      if (update?.type === 'opponent-progress') observed.push(update.progress);

      const replay = harness.service.receive(
        harness.hostConnection,
        message(harness.host, {
          type: 'publish-progress',
          matchId: countdown.matchId,
          progress: next,
        }),
      );
      valueOf(replay);
      expect(replay.deliveries).toEqual([]);

      if (sequence > 1) {
        expect(errorOf(harness.service.receive(
          harness.hostConnection,
          message(harness.host, {
            type: 'publish-progress',
            matchId: countdown.matchId,
            progress: progress(sequence - 1, score),
          }),
        ))).toBe('stale-progress');
      }
    }

    expect(observed).toHaveLength(100);
    for (let index = 1; index < observed.length; index++) {
      expect(observed[index]?.sequence).toBeGreaterThan(observed[index - 1]?.sequence ?? -1);
      expect(observed[index]?.score).toBeGreaterThanOrEqual(observed[index - 1]?.score ?? -1);
      expect(observed[index]?.turnsPlayed).toBeGreaterThanOrEqual(
        observed[index - 1]?.turnsPlayed ?? -1,
      );
    }
  });

  test('replaces stale connections and restores the current match snapshot', () => {
    const harness = setupRoom();
    const countdown = startMatch(harness);
    harness.clock.time = countdown.startsAt;
    valueOf(harness.service.receive(
      harness.hostConnection,
      message(harness.host, {
        type: 'publish-progress',
        matchId: countdown.matchId,
        progress: progress(2, 50),
      }),
    ));
    valueOf(harness.service.receive(
      harness.guestConnection,
      message(harness.guest, {
        type: 'publish-progress',
        matchId: countdown.matchId,
        progress: progress(2, 80),
      }),
    ));

    harness.service.disconnect(harness.hostConnection);
    expect(errorOf(harness.service.receive(
      harness.hostConnection,
      message(harness.host, {
        type: 'resume-session',
        matchId: countdown.matchId,
        lastProgressSequence: 2,
      }),
    ))).toBe('stale-connection');

    const reconnected = harness.service.connect({
      roomId: harness.host.roomId,
      playerId: harness.host.playerId,
      reconnectCredential: harness.host.reconnectCredential,
    });
    const replacement = valueOf(reconnected);
    expect(reconnected.deliveries.map(delivery => delivery.message)).toEqual([
      expect.objectContaining({
        type: 'match-countdown',
        matchId: countdown.matchId,
      }),
      expect.objectContaining({
        type: 'opponent-progress',
        progress: expect.objectContaining({
          playerId: harness.guest.playerId,
          sequence: 2,
          score: 80,
        }),
      }),
    ]);

    harness.service.disconnect(harness.hostConnection);
    const resumed = harness.service.receive(
      replacement,
      message(harness.host, {
        type: 'resume-session',
        matchId: countdown.matchId,
        lastProgressSequence: 2,
      }),
    );
    valueOf(resumed);
    expect(resumed.deliveries).toHaveLength(2);
    expect(errorOf(harness.service.receive(
      replacement,
      message(harness.host, {
        type: 'resume-session',
        matchId: 'old-match',
        lastProgressSequence: 2,
      }),
    ))).toBe('match-mismatch');

    const newerConnection = connect(harness.service, harness.host);
    expect(errorOf(harness.service.receive(
      replacement,
      message(harness.host, {
        type: 'resume-session',
        matchId: countdown.matchId,
        lastProgressSequence: 2,
      }),
    ))).toBe('stale-connection');
    valueOf(harness.service.receive(
      newerConnection,
      message(harness.host, {
        type: 'resume-session',
        matchId: null,
        lastProgressSequence: 3,
      }),
    ));
    const replayedProgress = harness.service.receive(
      newerConnection,
      message(harness.host, {
        type: 'publish-progress',
        matchId: countdown.matchId,
        progress: progress(3, 70),
      }),
    );
    valueOf(replayedProgress);
    expect(replayedProgress.deliveries).toEqual([{
      playerId: harness.guest.playerId,
      message: expect.objectContaining({
        type: 'opponent-progress',
        progress: expect.objectContaining({
          sequence: 3,
          score: 70,
        }),
      }),
    }]);
    expect(errorOf(harness.service.receive(
      newerConnection,
      message(harness.host, {
        type: 'resume-session',
        matchId: countdown.matchId,
        lastProgressSequence: 1,
      }),
    ))).toBe('stale-progress');
  });

  test('finishes early only after both players finish and broadcasts one canonical result', () => {
    const harness = setupRoom();
    const countdown = startMatch(harness);
    harness.clock.time = countdown.startsAt;

    const hostFinished = harness.service.receive(
      harness.hostConnection,
      message(harness.host, {
        type: 'finish-match',
        matchId: countdown.matchId,
        progress: progress(3, 120),
      }),
    );
    valueOf(hostFinished);
    expect(hostFinished.deliveries).toEqual([{
      playerId: harness.guest.playerId,
      message: expect.objectContaining({
        type: 'opponent-progress',
        progress: expect.objectContaining({
          playerId: harness.host.playerId,
          score: 120,
          finished: true,
        }),
      }),
    }]);
    expect(errorOf(harness.service.receive(
      harness.hostConnection,
      message(harness.host, {
        type: 'publish-progress',
        matchId: countdown.matchId,
        progress: progress(4, 140),
      }),
    ))).toBe('invalid-state');

    const guestFinished = harness.service.receive(
      harness.guestConnection,
      message(harness.guest, {
        type: 'finish-match',
        matchId: countdown.matchId,
        progress: progress(4, 150),
      }),
    );
    valueOf(guestFinished);
    const results = guestFinished.deliveries.filter(
      delivery => delivery.message.type === 'match-finished',
    );
    expect(results).toHaveLength(2);
    expect(results[0]?.message).toEqual({
      protocolVersion: MULTIPLAYER_PROTOCOL_VERSION,
      roomId: harness.host.roomId,
      mode: SCORE_RACE_ROOM_MODE,
      type: 'match-finished',
      matchId: countdown.matchId,
      result: {
        winnerId: harness.guest.playerId,
        scores: [
          { playerId: harness.host.playerId, score: 120 },
          { playerId: harness.guest.playerId, score: 150 },
        ],
        forfeitedBy: null,
      },
    });
    expect(results[1]?.message).toEqual(results[0]?.message);

    const replay = harness.service.receive(
      harness.guestConnection,
      message(harness.guest, {
        type: 'finish-match',
        matchId: countdown.matchId,
        progress: progress(4, 150),
      }),
    );
    valueOf(replay);
    expect(replay.deliveries).toEqual([]);
  });

  test('collects fresh readiness after a result and starts a new match in the same room', () => {
    const harness = setupRoom();
    const firstMatch = startMatch(harness);
    harness.clock.time = firstMatch.startsAt;

    valueOf(harness.service.receive(
      harness.hostConnection,
      message(harness.host, {
        type: 'finish-match',
        matchId: firstMatch.matchId,
        progress: progress(3, 120),
      }),
    ));
    valueOf(harness.service.receive(
      harness.guestConnection,
      message(harness.guest, {
        type: 'finish-match',
        matchId: firstMatch.matchId,
        progress: progress(4, 150),
      }),
    ));

    const hostReady = harness.service.receive(
      harness.hostConnection,
      message(harness.host, { type: 'set-ready', ready: true }),
    );
    valueOf(hostReady);
    expect(hostReady.deliveries).toEqual([
      {
        playerId: harness.host.playerId,
        message: expect.objectContaining({
          type: 'room-state',
          localReady: true,
          opponentReady: false,
        }),
      },
      {
        playerId: harness.guest.playerId,
        message: expect.objectContaining({
          type: 'room-state',
          localReady: false,
          opponentReady: true,
        }),
      },
    ]);

    const guestReady = harness.service.receive(
      harness.guestConnection,
      message(harness.guest, { type: 'set-ready', ready: true }),
    );
    valueOf(guestReady);
    const countdowns = guestReady.deliveries.filter(
      delivery => delivery.message.type === 'match-countdown',
    );
    expect(countdowns).toHaveLength(2);
    const secondMatch = countdowns[0]?.message;
    expect(secondMatch).toEqual(expect.objectContaining({
      type: 'match-countdown',
      matchId: 'match-2',
    }));
    if (!secondMatch || secondMatch.type !== 'match-countdown') {
      throw new Error('Expected rematch countdown');
    }
    expect(secondMatch.matchId).not.toBe(firstMatch.matchId);

    harness.clock.time = secondMatch.startsAt;
    valueOf(harness.service.receive(
      harness.hostConnection,
      message(harness.host, {
        type: 'publish-progress',
        matchId: secondMatch.matchId,
        progress: progress(1, 10),
      }),
    ));
  });

  test('finalizes at the exact deadline and serves the result to a reconnecting player', () => {
    const harness = setupRoom();
    const countdown = startMatch(harness);
    harness.clock.time = countdown.startsAt;
    valueOf(harness.service.receive(
      harness.hostConnection,
      message(harness.host, {
        type: 'publish-progress',
        matchId: countdown.matchId,
        progress: progress(5, 200),
      }),
    ));
    valueOf(harness.service.receive(
      harness.guestConnection,
      message(harness.guest, {
        type: 'publish-progress',
        matchId: countdown.matchId,
        progress: progress(4, 180),
      }),
    ));
    harness.service.disconnect(harness.guestConnection);

    harness.clock.time = countdown.deadline - 1;
    expect(harness.service.tick().deliveries).toEqual([]);
    harness.clock.time = countdown.deadline;
    const deadline = harness.service.tick();
    expect(deadline.expiredRoomIds).toEqual([]);
    expect(deliveriesFor(
      deadline.deliveries,
      harness.host.playerId,
      'match-finished',
    )).toHaveLength(1);
    expect(deliveriesFor(
      deadline.deliveries,
      harness.guest.playerId,
      'match-finished',
    )).toHaveLength(0);

    const guestReconnect = harness.service.connect({
      roomId: harness.guest.roomId,
      playerId: harness.guest.playerId,
      reconnectCredential: harness.guest.reconnectCredential,
    });
    valueOf(guestReconnect);
    expect(guestReconnect.deliveries.map(delivery => delivery.message.type)).toEqual([
      'match-countdown',
      'opponent-progress',
      'match-finished',
      'room-state',
    ]);
    const result = guestReconnect.deliveries.find(
      delivery => delivery.message.type === 'match-finished',
    )?.message;
    expect(result).toEqual(expect.objectContaining({
      type: 'match-finished',
      result: {
        winnerId: harness.host.playerId,
        scores: [
          { playerId: harness.host.playerId, score: 200 },
          { playerId: harness.guest.playerId, score: 180 },
        ],
        forfeitedBy: null,
      },
    }));
    expect(errorOf(harness.service.receive(
      harness.hostConnection,
      message(harness.host, {
        type: 'publish-progress',
        matchId: countdown.matchId,
        progress: progress(6, 220),
      }),
    ))).toBe('invalid-state');
  });

  test('accepts a finish notification racing with authoritative deadline completion', () => {
    const harness = setupRoom();
    const countdown = startMatch(harness);
    harness.clock.time = countdown.startsAt;
    valueOf(harness.service.receive(
      harness.hostConnection,
      message(harness.host, {
        type: 'publish-progress',
        matchId: countdown.matchId,
        progress: progress(5, 200),
      }),
    ));
    valueOf(harness.service.receive(
      harness.guestConnection,
      message(harness.guest, {
        type: 'publish-progress',
        matchId: countdown.matchId,
        progress: progress(4, 180),
      }),
    ));

    harness.clock.time = countdown.deadline;
    const racedFinish = harness.service.receive(
      harness.hostConnection,
      message(harness.host, {
        type: 'finish-match',
        matchId: countdown.matchId,
        progress: progress(5, 200),
      }),
    );

    valueOf(racedFinish);
    expect(deliveriesFor(
      racedFinish.deliveries,
      harness.host.playerId,
      'match-finished',
    )).toHaveLength(1);
    expect(deliveriesFor(
      racedFinish.deliveries,
      harness.guest.playerId,
      'match-finished',
    )).toHaveLength(1);
  });

  test('expires idle lobbies and completed matches with their credentials', () => {
    const lobbyClock = new ManualClock();
    const lobbyService = createService(lobbyClock);
    const waitingHost = valueOf(lobbyService.createRoom(admissionRequest()));
    lobbyClock.time += LOBBY_TTL_MS - 1;
    expect(lobbyService.tick().expiredRoomIds).toEqual([]);
    lobbyClock.time++;
    expect(lobbyService.tick().expiredRoomIds).toEqual([waitingHost.roomId]);
    expect(errorOf(lobbyService.connect({
      roomId: waitingHost.roomId,
      playerId: waitingHost.playerId,
      reconnectCredential: waitingHost.reconnectCredential,
    }))).toBe('room-not-found');

    const harness = setupRoom();
    const countdown = startMatch(harness);
    harness.clock.time = countdown.startsAt;
    valueOf(harness.service.receive(
      harness.hostConnection,
      message(harness.host, {
        type: 'finish-match',
        matchId: countdown.matchId,
        progress: progress(1, 10),
      }),
    ));
    valueOf(harness.service.receive(
      harness.guestConnection,
      message(harness.guest, {
        type: 'finish-match',
        matchId: countdown.matchId,
        progress: progress(1, 10),
      }),
    ));
    harness.clock.time += RESULT_TTL_MS;
    expect(harness.service.tick().expiredRoomIds).toEqual([harness.host.roomId]);
    expect(errorOf(harness.service.connect({
      roomId: harness.host.roomId,
      playerId: harness.host.playerId,
      reconnectCredential: harness.host.reconnectCredential,
    }))).toBe('room-not-found');
  });

  test('releases an expired room id so a later room can reuse it', () => {
    const clock = new ManualClock();
    const service = new ScoreRaceRoomService({
      clock,
      values: new FixedRoomIdValues('REUSABLE-ROOM'),
      roomIdAllocator: createRoomIdAllocator(),
      countdownMs: COUNTDOWN_MS,
      lobbyTtlMs: LOBBY_TTL_MS,
      resultTtlMs: RESULT_TTL_MS,
    });

    const first = valueOf(service.createRoom(admissionRequest()));
    clock.time += LOBBY_TTL_MS;
    expect(service.tick().expiredRoomIds).toEqual([first.roomId]);

    const second = valueOf(service.createRoom(admissionRequest()));
    expect(second.roomId).toBe(first.roomId);
  });

  test('releases a claimed room id when room construction fails', () => {
    const service = new ScoreRaceRoomService({
      clock: new ManualClock(),
      values: new FixedRoomIdValues('RETRY-ROOM', true),
      roomIdAllocator: createRoomIdAllocator(),
    });

    expect(() => service.createRoom(admissionRequest())).toThrow();
    expect(valueOf(service.createRoom(admissionRequest())).roomId).toBe('RETRY-ROOM');
  });
});

describe('ScoreRaceRoomService pause and forfeit', () => {
  test('pause freezes the deadline and rejects gameplay input until the pauser resumes', () => {
    const harness = setupRoom();
    const countdown = startMatch(harness);
    harness.clock.time = countdown.startsAt;

    const paused = harness.service.receive(
      harness.hostConnection,
      message(harness.host, { type: 'set-paused', matchId: countdown.matchId, paused: true }),
    );
    valueOf(paused);
    expect(paused.deliveries).toEqual([
      {
        playerId: harness.host.playerId,
        message: expect.objectContaining({
          type: 'match-paused', paused: true, pausedBy: harness.host.playerId, deadline: countdown.deadline,
        }),
      },
      {
        playerId: harness.guest.playerId,
        message: expect.objectContaining({
          type: 'match-paused', paused: true, pausedBy: harness.host.playerId, deadline: countdown.deadline,
        }),
      },
    ]);

    // Re-pausing while already paused is idempotent — no second broadcast.
    const rePaused = harness.service.receive(
      harness.hostConnection,
      message(harness.host, { type: 'set-paused', matchId: countdown.matchId, paused: true }),
    );
    valueOf(rePaused);
    expect(rePaused.deliveries).toEqual([]);

    // The original deadline passes while paused — ticking must not finalize the match.
    harness.clock.time = countdown.deadline + 1;
    expect(harness.service.tick().deliveries).toEqual([]);

    expect(errorOf(harness.service.receive(
      harness.hostConnection,
      message(harness.host, {
        type: 'publish-progress', matchId: countdown.matchId, progress: progress(1, 10),
      }),
    ))).toBe('invalid-state');

    // Only the player who paused can resume.
    expect(errorOf(harness.service.receive(
      harness.guestConnection,
      message(harness.guest, { type: 'set-paused', matchId: countdown.matchId, paused: false }),
    ))).toBe('invalid-state');

    const pausedDurationMs = harness.clock.time - countdown.startsAt;
    const resumed = harness.service.receive(
      harness.hostConnection,
      message(harness.host, { type: 'set-paused', matchId: countdown.matchId, paused: false }),
    );
    valueOf(resumed);
    const expectedDeadline = countdown.deadline + pausedDurationMs;
    expect(resumed.deliveries).toEqual([
      {
        playerId: harness.host.playerId,
        message: expect.objectContaining({
          type: 'match-paused', paused: false, pausedBy: harness.host.playerId, deadline: expectedDeadline,
        }),
      },
      {
        playerId: harness.guest.playerId,
        message: expect.objectContaining({
          type: 'match-paused', paused: false, pausedBy: harness.host.playerId, deadline: expectedDeadline,
        }),
      },
    ]);

    valueOf(harness.service.receive(
      harness.hostConnection,
      message(harness.host, {
        type: 'publish-progress', matchId: countdown.matchId, progress: progress(1, 10),
      }),
    ));

    // The shifted deadline, not the original, now governs completion.
    harness.clock.time = expectedDeadline - 1;
    expect(harness.service.tick().deliveries).toEqual([]);
    harness.clock.time = expectedDeadline;
    const finished = harness.service.tick();
    expect(deliveriesFor(finished.deliveries, harness.host.playerId, 'match-finished')).toHaveLength(1);
  });

  test('disconnecting the pausing player auto-resumes so the opponent is not soft-locked', () => {
    const harness = setupRoom();
    const countdown = startMatch(harness);
    harness.clock.time = countdown.startsAt;

    valueOf(harness.service.receive(
      harness.hostConnection,
      message(harness.host, { type: 'set-paused', matchId: countdown.matchId, paused: true }),
    ));

    harness.clock.time += 3_000;
    const disconnectDeliveries = harness.service.disconnect(harness.hostConnection);
    expect(disconnectDeliveries).toEqual([
      {
        playerId: harness.guest.playerId,
        message: expect.objectContaining({ type: 'match-paused', paused: false, pausedBy: harness.host.playerId }),
      },
    ]);

    valueOf(harness.service.receive(
      harness.guestConnection,
      message(harness.guest, {
        type: 'publish-progress', matchId: countdown.matchId, progress: progress(1, 5),
      }),
    ));
  });

  test('a reconnecting player receives the current pause state', () => {
    const harness = setupRoom();
    const countdown = startMatch(harness);
    harness.clock.time = countdown.startsAt;

    valueOf(harness.service.receive(
      harness.hostConnection,
      message(harness.host, { type: 'set-paused', matchId: countdown.matchId, paused: true }),
    ));

    harness.service.disconnect(harness.guestConnection);
    const reconnected = harness.service.connect({
      roomId: harness.guest.roomId,
      playerId: harness.guest.playerId,
      reconnectCredential: harness.guest.reconnectCredential,
    });
    valueOf(reconnected);
    const pausedSnapshot = reconnected.deliveries.find(
      delivery => delivery.message.type === 'match-paused',
    )?.message;
    expect(pausedSnapshot).toEqual(expect.objectContaining({
      type: 'match-paused', paused: true, pausedBy: harness.host.playerId,
    }));
  });

  test('forfeit always hands the win to the opponent, even mid-pause and regardless of score', () => {
    const harness = setupRoom();
    const countdown = startMatch(harness);
    harness.clock.time = countdown.startsAt;

    valueOf(harness.service.receive(
      harness.hostConnection,
      message(harness.host, {
        type: 'publish-progress', matchId: countdown.matchId, progress: progress(5, 500),
      }),
    ));
    valueOf(harness.service.receive(
      harness.guestConnection,
      message(harness.guest, {
        type: 'publish-progress', matchId: countdown.matchId, progress: progress(1, 10),
      }),
    ));
    valueOf(harness.service.receive(
      harness.hostConnection,
      message(harness.host, { type: 'set-paused', matchId: countdown.matchId, paused: true }),
    ));

    // The host forfeits despite leading on score — the guest still wins.
    const forfeited = harness.service.receive(
      harness.hostConnection,
      message(harness.host, { type: 'forfeit-match', matchId: countdown.matchId }),
    );
    valueOf(forfeited);
    const results = forfeited.deliveries.filter(delivery => delivery.message.type === 'match-finished');
    expect(results).toHaveLength(2);
    expect(results[0]?.message).toEqual(expect.objectContaining({
      type: 'match-finished',
      result: {
        winnerId: harness.guest.playerId,
        scores: [
          { playerId: harness.host.playerId, score: 500 },
          { playerId: harness.guest.playerId, score: 10 },
        ],
        forfeitedBy: harness.host.playerId,
      },
    }));

    // The pause no longer blocks anything post-forfeit — the match is over.
    harness.clock.time = countdown.deadline + 100;
    expect(harness.service.tick().deliveries).toEqual([]);
  });
});

describe('ScoreRaceRoomService chat', () => {
  test('relays chat to both players from any lifecycle phase', () => {
    const harness = setupRoom();
    const result = harness.service.receive(
      harness.hostConnection,
      message(harness.host, { type: 'send-chat', text: 'hello' }),
    );
    valueOf(result);
    const chats = result.deliveries.filter(delivery => delivery.message.type === 'chat-message');
    expect(chats.map(delivery => delivery.playerId).sort()).toEqual(
      [harness.host.playerId, harness.guest.playerId].sort(),
    );
    expect(chats).toHaveLength(2);
    expect(chats[0]?.message).toEqual(expect.objectContaining({
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

  test('accepted chat counts as room activity and extends the lobby TTL', () => {
    const clock = new ManualClock();
    const service = createService(clock);
    const host = valueOf(service.createRoom(admissionRequest()));
    valueOf(service.joinRoom({ ...admissionRequest(), roomId: host.roomId }));
    const hostConnection = connect(service, host);

    // Advance to just before the lobby would expire, then chat to refresh it.
    clock.time += LOBBY_TTL_MS - 1;
    valueOf(service.receive(
      hostConnection,
      message(host, { type: 'send-chat', text: 'still here' }),
    ));

    // Past the original expiry, still alive only because the chat reset it.
    clock.time += 2;
    expect(service.tick().expiredRoomIds).toEqual([]);
  });
});
