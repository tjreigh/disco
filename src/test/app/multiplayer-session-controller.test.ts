// @vitest-environment happy-dom

import { describe, expect, test, vi } from 'vitest';
import { MultiplayerSessionController } from '../../app/multiplayer-session-controller.js';
import {
  SCORE_RACE_MODE,
} from '../../game/modes/index.js';
import {
  defineMultiplayerMode,
} from '../../game/modes/mode.js';
import type {
  MultiplayerModeDefinition,
} from '../../game/modes/mode.js';
import {
  determineScoreRaceResult,
  multiplayerModeIdentity,
  MULTIPLAYER_PROTOCOL_VERSION,
} from '../../shared/multiplayer-contracts.js';
import type {
  MultiplayerModeIdentity,
  MultiplayerServerMessage,
} from '../../shared/multiplayer-contracts.js';
import { FakeMultiplayerTransport } from '../fakes/multiplayer-transport.js';
import { testMode } from '../helpers.js';

class FakeClock {
  value = 0;
  now(): number {
    return this.value;
  }
}

type WithoutServerEnvelope<T> = T extends MultiplayerServerMessage
  ? Omit<T, 'protocolVersion' | 'roomId' | 'mode'>
  : never;
type ServerPayload = WithoutServerEnvelope<MultiplayerServerMessage>;

function serverMessage(
  message: ServerPayload,
  mode: MultiplayerModeIdentity = multiplayerModeIdentity(SCORE_RACE_MODE),
): MultiplayerServerMessage {
  return {
    protocolVersion: MULTIPLAYER_PROTOCOL_VERSION,
    roomId: 'ROOM1',
    mode,
    ...message,
  } as MultiplayerServerMessage;
}

function createSession(mode: MultiplayerModeDefinition = SCORE_RACE_MODE): {
  clock: FakeClock;
  transport: FakeMultiplayerTransport;
  controller: MultiplayerSessionController;
} {
  const clock = new FakeClock();
  const transport = new FakeMultiplayerTransport();
  const controller = new MultiplayerSessionController({
    roomId: 'ROOM1',
    playerId: 'local-player',
    mode,
    clock,
    transport,
  });
  return { clock, transport, controller };
}

function scoreRaceDurationMs(mode: MultiplayerModeDefinition): number {
  if (mode.session.kind !== 'timed-score-race@1') {
    throw new Error(`Expected a timed-score-race session, got ${mode.session.kind}`);
  }
  return mode.session.durationMs;
}

function startMatch(
  transport: FakeMultiplayerTransport,
  startsAt = 0,
  mode: MultiplayerModeDefinition = SCORE_RACE_MODE,
  matchId = 'match-1',
): void {
  transport.receive(serverMessage({
    type: 'match-countdown',
    matchId,
    startsAt,
    deadline: startsAt + scoreRaceDurationMs(mode),
    seed: 1,
  }, multiplayerModeIdentity(mode)));
}

describe('MultiplayerSessionController lifecycle', () => {
  test('runs a deterministic timed match without solo persistence or real timers', () => {
    const { clock, transport, controller } = createSession();
    expect(controller.view.phase).toBe('lobby');

    controller.setReady(true);
    expect(controller.view.phase).toBe('ready');
    expect(transport.sent.at(-1)).toMatchObject({ type: 'set-ready', ready: true });

    startMatch(transport, 1_000);
    expect(controller.view.phase).toBe('countdown');
    expect(controller.view.remainingMs).toBe(1_000);
    expect(controller.drop(3)).toBeNull();

    clock.value = 1_000;
    controller.tick();
    expect(controller.view.phase).toBe('playing');

    const turn = controller.drop(3);
    expect(turn?.accepted).toBe(true);
    expect(transport.sent.at(-1)).toMatchObject({
      type: 'publish-progress',
      matchId: 'match-1',
      playerId: 'local-player',
      progress: {
        sequence: 1,
        turnsPlayed: 1,
      },
    });

    transport.receive(serverMessage({
      type: 'opponent-progress',
      matchId: 'match-1',
      progress: {
        playerId: 'opponent-player',
        sequence: 1,
        score: 250,
        turnsPlayed: 2,
        finished: false,
      },
    }));
    expect(controller.view.opponent?.score).toBe(250);

    clock.value = 2_000;
    transport.setConnection('disconnected');
    expect(controller.view.phase).toBe('disconnected');
    transport.setConnection('reconnecting');
    expect(controller.view.phase).toBe('reconnecting');
    clock.value = 2_100;
    const sentBeforeReconnect = transport.sent.length;
    transport.setConnection('connected');
    expect(controller.view.phase).toBe('playing');
    expect(transport.sent.slice(sentBeforeReconnect)).toEqual([
      expect.objectContaining({
        type: 'resume-session',
        matchId: 'match-1',
        lastProgressSequence: 1,
      }),
      expect.objectContaining({
        type: 'publish-progress',
        matchId: 'match-1',
        progress: {
          sequence: 1,
          score: controller.view.board.state.score,
          turnsPlayed: controller.view.board.state.dropCount,
        },
      }),
    ]);

    clock.value = 1_000 + scoreRaceDurationMs(SCORE_RACE_MODE);
    controller.tick();
    expect(controller.view.phase).toBe('finished');
    expect(controller.drop(2)).toBeNull();
    expect(transport.sent.at(-1)).toMatchObject({
      type: 'finish-match',
      matchId: 'match-1',
      progress: { sequence: 1, turnsPlayed: 1 },
    });

    transport.setConnection('disconnected');
    transport.setConnection('reconnecting');
    const sentBeforeFinishedReconnect = transport.sent.length;
    transport.setConnection('connected');
    expect(transport.sent.slice(sentBeforeFinishedReconnect)).toEqual([
      expect.objectContaining({
        type: 'resume-session',
        matchId: 'match-1',
        lastProgressSequence: 1,
      }),
      expect.objectContaining({
        type: 'finish-match',
        matchId: 'match-1',
        progress: expect.objectContaining({ sequence: 1, turnsPlayed: 1 }),
      }),
    ]);

    transport.receive(serverMessage({
      type: 'match-finished',
      matchId: 'match-1',
      result: determineScoreRaceResult(
        'local-player',
        500,
        'opponent-player',
        250,
      ),
    }));
    expect(controller.view.result).toEqual({
      outcome: 'win',
      localScore: 500,
      opponentScore: 250,
    });
  });

  test('keeps an authoritative result terminal across disconnect and reconnect', () => {
    const { transport, controller } = createSession();
    startMatch(transport);
    transport.receive(serverMessage({
      type: 'match-finished',
      matchId: 'match-1',
      result: determineScoreRaceResult(
        'local-player',
        100,
        'opponent-player',
        100,
      ),
    }));

    transport.setConnection('disconnected');
    transport.setConnection('reconnecting');
    transport.setConnection('connected');

    expect(controller.view.phase).toBe('finished');
    expect(controller.view.result?.outcome).toBe('tie');
  });

  test('collects rematch readiness and starts a fresh board in the same room', () => {
    const { clock, transport, controller } = createSession();
    startMatch(transport);
    expect(controller.drop(3)?.accepted).toBe(true);
    expect(controller.view.board.state.dropCount).toBe(1);

    transport.receive(serverMessage({
      type: 'match-finished',
      matchId: 'match-1',
      result: determineScoreRaceResult(
        'local-player',
        100,
        'opponent-player',
        50,
      ),
    }));
    expect(controller.view.result?.outcome).toBe('win');
    expect(controller.view.localReady).toBe(false);
    expect(controller.view.opponentReady).toBe(false);

    controller.setReady(true);
    expect(controller.view.localReady).toBe(true);
    expect(transport.sent.at(-1)).toMatchObject({ type: 'set-ready', ready: true });

    transport.receive(serverMessage({
      type: 'room-state',
      localReady: true,
      opponentReady: false,
    }));
    expect(controller.view.result?.outcome).toBe('win');
    expect(controller.view.opponentReady).toBe(false);

    transport.receive(serverMessage({
      type: 'room-state',
      localReady: true,
      opponentReady: true,
    }));
    startMatch(transport, 1_000, SCORE_RACE_MODE, 'match-2');
    expect(controller.view.phase).toBe('countdown');
    expect(controller.view.matchId).toBe('match-2');
    expect(controller.view.result).toBeNull();

    clock.value = 1_000;
    controller.tick();
    expect(controller.view.phase).toBe('playing');
    expect(controller.view.board.state.dropCount).toBe(0);
    expect(controller.view.board.state.score).toBe(0);
  });

  test('finishes instead of publishing progress when reconnecting at the deadline', () => {
    const { clock, transport, controller } = createSession();
    startMatch(transport);
    transport.setConnection('disconnected');
    transport.setConnection('reconnecting');
    clock.value = scoreRaceDurationMs(SCORE_RACE_MODE);
    const sentBeforeReconnect = transport.sent.length;

    transport.setConnection('connected');

    expect(controller.view.phase).toBe('finished');
    expect(transport.sent.slice(sentBeforeReconnect)).toEqual([
      expect.objectContaining({
        type: 'resume-session',
        matchId: 'match-1',
      }),
      expect.objectContaining({
        type: 'finish-match',
        matchId: 'match-1',
      }),
    ]);
  });

  test('keeps compatibility failures terminal when later messages arrive', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { transport, controller } = createSession();
    const identity = multiplayerModeIdentity(SCORE_RACE_MODE);
    const mismatchedMode = {
      ...identity,
      rules: { ...identity.rules, version: identity.rules.version + 1 },
    };

    transport.receive(serverMessage({
      type: 'room-state',
      localReady: false,
      opponentReady: false,
    }, mismatchedMode));
    transport.receive(serverMessage({
      type: 'room-state',
      localReady: false,
      opponentReady: false,
    }));

    expect(controller.view.phase).toBe('finished');
    expect(controller.view.compatibilityError).toBe('rules-mismatch');
    // Regression: a generic "incompatible version" message with no detail
    // logged anywhere made a real parser bug indistinguishable from an
    // actual version mismatch (see docs/fix-shared-duel-phase4-findings.md).
    // The console log is the only place the actual received/expected
    // identities are visible, so it has to fire with real detail.
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('rules-mismatch'),
      expect.objectContaining({ received: mismatchedMode, expected: identity }),
    );
    consoleError.mockRestore();
  });

  test('rejects malformed messages and a duration outside the versioned session contract', () => {
    const malformed = createSession();
    malformed.transport.receive({
      protocolVersion: MULTIPLAYER_PROTOCOL_VERSION,
      roomId: 'ROOM1',
      type: 'match-countdown',
    });
    expect(malformed.controller.view.compatibilityError).toBe('invalid-message');

    const wrongDuration = createSession();
    wrongDuration.transport.receive(serverMessage({
      type: 'match-countdown',
      matchId: 'short-match',
      startsAt: 0,
      deadline: 30_000,
      seed: 1,
    }));
    expect(wrongDuration.controller.view.compatibilityError).toBe('session-mismatch');
  });

  test('finishes immediately when overflow or a full board ends the local run', () => {
    const terminalRules = testMode({
      id: 'terminal-race-test',
      board: { cols: 1, rows: 1 },
      generation: {
        kind: 'history-balanced@1',
        discValueMin: 2,
        discValueMax: 2,
      },
    });
    const terminalMode = defineMultiplayerMode({
      kind: 'multiplayer',
      id: terminalRules.id,
      version: 1,
      name: 'Terminal fixture',
      tagline: 'One turn fixture.',
      rules: terminalRules,
      session: {
        kind: 'timed-score-race@1',
        durationMs: 60_000,
        fairness: { kind: 'identical-sequence' },
        result: { kind: 'highest-score-wins@1', tie: 'tie' },
      },
    });
    const { transport, controller } = createSession(terminalMode);

    startMatch(transport, 0, terminalMode, 'terminal-match');
    const turn = controller.drop(0);

    expect(turn).toMatchObject({ accepted: true, gameOver: true });
    expect(controller.view.phase).toBe('finished');
    expect(transport.sent.at(-1)).toMatchObject({
      type: 'finish-match',
      matchId: 'terminal-match',
      progress: {
        sequence: 1,
        turnsPlayed: 1,
      },
    });
  });
});
