// @vitest-environment happy-dom

import { describe, expect, test } from 'vitest';
import {
  FakeMultiplayerTransport,
  MultiplayerSessionController,
} from '../../app/multiplayer-session-controller.js';
import {
  SCORE_RACE_MODE,
  SCORE_RACE_RULES,
} from '../../game/modes/index.js';
import {
  MULTIPLAYER_PROTOCOL_VERSION,
  rulesIdentity,
} from '../../shared/multiplayer-contracts.js';
import type {
  MultiplayerModeIdentity,
  MultiplayerServerMessage,
} from '../../shared/multiplayer-contracts.js';
import type { GameRulesConfig } from '../../game/modes/mode.js';
import { testMode } from '../helpers.js';

class FakeClock {
  value = 0;
  now(): number {
    return this.value;
  }
}

const mode: MultiplayerModeIdentity = {
  modeId: SCORE_RACE_MODE.id,
  rules: rulesIdentity(SCORE_RACE_RULES),
};

function serverMessage<T extends Omit<
  MultiplayerServerMessage,
  'protocolVersion' | 'roomId' | 'mode'
>>(message: T, messageMode = mode): T & {
  protocolVersion: typeof MULTIPLAYER_PROTOCOL_VERSION;
  roomId: string;
  mode: MultiplayerModeIdentity;
} {
  return {
    protocolVersion: MULTIPLAYER_PROTOCOL_VERSION,
    roomId: 'ROOM1',
    mode: messageMode,
    ...message,
  };
}

function createSession(
  rules: GameRulesConfig = SCORE_RACE_RULES,
  modeId = SCORE_RACE_MODE.id,
): {
  clock: FakeClock;
  transport: FakeMultiplayerTransport;
  controller: MultiplayerSessionController;
} {
  const clock = new FakeClock();
  const transport = new FakeMultiplayerTransport();
  const controller = new MultiplayerSessionController({
    roomId: 'ROOM1',
    playerId: 'local-player',
    modeId,
    rules,
    clock,
    transport,
  });
  return { clock, transport, controller };
}

describe('MultiplayerSessionController', () => {
  test('runs a deterministic timed match without solo persistence or real timers', () => {
    const { clock, transport, controller } = createSession();
    expect(controller.view.phase).toBe('lobby');

    controller.setReady(true);
    expect(controller.view.phase).toBe('ready');
    expect(transport.sent.at(-1)).toMatchObject({ type: 'set-ready', ready: true });

    transport.receive(serverMessage({
      type: 'match-countdown',
      matchId: 'match-1',
      startsAt: 1_000,
      deadline: 1_000 + SCORE_RACE_MODE.session.durationMs,
      seed: 1,
    }));
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
      progress: {
        playerId: 'local-player',
        sequence: 1,
        turnsPlayed: 1,
        finished: false,
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
    transport.setConnection('connected');
    expect(controller.view.phase).toBe('playing');
    expect(transport.sent.at(-1)).toMatchObject({
      type: 'resume-session',
      matchId: 'match-1',
      lastProgressSequence: 1,
    });

    clock.value = 1_000 + SCORE_RACE_MODE.session.durationMs;
    controller.tick();
    expect(controller.view.phase).toBe('finished');
    expect(controller.drop(2)).toBeNull();
    expect(transport.sent.at(-1)).toMatchObject({
      type: 'finish-match',
      matchId: 'match-1',
      progress: { turnsPlayed: 1, finished: true },
    });

    transport.receive(serverMessage({
      type: 'match-finished',
      matchId: 'match-1',
      result: {
        outcome: 'win',
        winnerId: 'local-player',
        localScore: 500,
        opponentScore: 250,
      },
    }));
    expect(controller.view.result).toEqual({
      outcome: 'win',
      winnerId: 'local-player',
      localScore: 500,
      opponentScore: 250,
    });
  });

  test('rejects a server rules identity that differs from the local board', () => {
    const { transport, controller } = createSession();

    transport.receive({
      ...serverMessage({
        type: 'room-state',
        localReady: false,
        opponentReady: false,
      }),
      mode: {
        ...mode,
        rules: { ...mode.rules, version: mode.rules.version + 1 },
      },
    });

    expect(controller.view.phase).toBe('finished');
    expect(controller.view.compatibilityError).toBe('rules-mismatch');
  });

  test('finishes immediately when overflow or a full board ends the local run', () => {
    const terminalRules = testMode({
      id: 'terminal-race-test',
      board: { cols: 1, rows: 1 },
      generation: {
        kind: 'history-balanced@1',
        discValueMin: 2,
        discValueMax: 2,
        boardAdaptive: false,
        boardPressureStrength: 0,
        boardRelevanceStrength: 0,
      },
    });
    const terminalMode: MultiplayerModeIdentity = {
      modeId: terminalRules.id,
      rules: rulesIdentity(terminalRules),
    };
    const { transport, controller } = createSession(terminalRules, terminalRules.id);

    transport.receive(serverMessage({
      type: 'match-countdown',
      matchId: 'terminal-match',
      startsAt: 0,
      deadline: 60_000,
      seed: 42,
    }, terminalMode));
    const turn = controller.drop(0);

    expect(turn).toMatchObject({ accepted: true, gameOver: true });
    expect(controller.view.phase).toBe('finished');
    expect(transport.sent.at(-1)).toMatchObject({
      type: 'finish-match',
      matchId: 'terminal-match',
      progress: {
        sequence: 1,
        turnsPlayed: 1,
        finished: true,
      },
    });
  });
});
