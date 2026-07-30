import { describe, expect, test } from 'vitest';
import { makeEmptyBoard, placeDisc } from '../../game/board.js';
import { makeDisc } from '../../game/disc.js';
import { DiscKind } from '../../game/model.js';
import {
  CLASSIC_MODE,
  CLASSIC_RULES,
  GAME_RULESETS,
  GRAVITY_MODE,
  GRAVITY_RULES,
  MULTIPLAYER_MODES,
  PARADOX_MODE,
  PARADOX_RULES,
  SCORE_RACE_MODE,
  SCORE_RACE_RULES,
  SOLO_MODES,
  STACK_MODE,
  STACK_RULES,
  getGameRules,
  getMultiplayerMode,
  getSoloMode,
  validateModeRegistries,
} from '../../game/modes/index.js';
import {
  capabilitiesForRules,
  defineGameRules,
  defineMultiplayerMode,
  rewindModifier,
  temporalEchoProbability,
  turnsForLevel,
  unnumberedProbabilityForLevel,
} from '../../game/modes/mode.js';
import { testMode } from '../helpers.js';

describe('composed solo rules', () => {
  test('Classic explicitly selects the shipped rule modules', () => {
    expect(CLASSIC_RULES).toMatchObject({
      id: 'classic',
      version: 1,
      board: { kind: 'rectangular-grid@1', cols: 7, rows: 7 },
      placement: { kind: 'downward-drop@1' },
      clearing: { kind: 'orthogonal-count-match@1' },
      revealing: { kind: 'adjacent-crack-reveal@1' },
      generation: {
        kind: 'adaptive-history@1',
        discValueMin: 1,
        discValueMax: 7,
        initialUnnumberedProbability: 0.2,
        maxUnnumberedProbability: 0.4,
      },
      scoring: {
        kind: 'chain-score@1',
        pointsPerDisc: 7,
        chainExponent: 2.5,
        levelBonus: 7_000,
        boardClearBonus: 70_000,
      },
      progression: {
        kind: 'level-pressure@1',
        initialTurnsPerLevel: 30,
        turnsPerLevelStep: 1,
        minTurnsPerLevel: 8,
      },
      failure: { kind: 'overflow-or-full-board-ends-run@1' },
      modifiers: [],
    });
  });

  test('Stack explicitly changes generation, scoring, and progression modules', () => {
    expect(STACK_RULES.board).toBe(CLASSIC_RULES.board);
    expect(STACK_RULES.placement).toBe(CLASSIC_RULES.placement);
    expect(STACK_RULES.clearing).toBe(CLASSIC_RULES.clearing);
    expect(STACK_RULES.revealing).toBe(CLASSIC_RULES.revealing);
    expect(STACK_RULES.failure).toBe(CLASSIC_RULES.failure);
    expect(STACK_RULES.generation).not.toBe(CLASSIC_RULES.generation);
    expect(STACK_RULES.scoring).toMatchObject({
      kind: 'stack-score@1',
      pointsPerStackUnit: 10,
    });
    expect(STACK_RULES.progression.initialTurnsPerLevel).toBe(22);
    expect(unnumberedProbabilityForLevel(STACK_RULES.generation, 100)).toBe(0);
  });

  test('Gravity is represented by placement and clearing modules', () => {
    expect(GRAVITY_RULES.placement).toEqual({
      kind: 'stage-and-tilt@1',
      initialAngleDeg: 0,
      maxTiltDeltaDeg: 90,
    });
    expect(GRAVITY_RULES.clearing.kind).toBe('gravity-aligned-count-match@1');
    expect(GRAVITY_RULES.failure).toBe(CLASSIC_RULES.failure);
    expect(GRAVITY_RULES.generation).toBe(CLASSIC_RULES.generation);
    expect(GRAVITY_RULES.scoring).toBe(CLASSIC_RULES.scoring);
    expect(capabilitiesForRules(GRAVITY_RULES)).toEqual({ canTilt: true, canRewind: false });
  });

  test('Paradox adds rewind as an orthogonal modifier', () => {
    expect(PARADOX_RULES.board).toBe(CLASSIC_RULES.board);
    expect(PARADOX_RULES.placement).toBe(CLASSIC_RULES.placement);
    expect(rewindModifier(PARADOX_RULES)).toMatchObject({
      kind: 'rewind-instability@1',
      historyDepth: 5,
      criticalInstability: 5,
      pressureStepInstability: 3,
      maxTurnCost: 3,
    });
    expect(capabilitiesForRules(PARADOX_RULES)).toEqual({ canTilt: false, canRewind: true });
    expect(temporalEchoProbability(PARADOX_RULES, 5)).toBe(0.1);
    expect(temporalEchoProbability(PARADOX_RULES, 9)).toBe(0.3);
  });

  test('Score Race composes familiar play with board-independent generation', () => {
    expect(SCORE_RACE_RULES).toMatchObject({
      id: 'score-race',
      version: 1,
      generation: {
        kind: 'history-balanced@1',
      },
      modifiers: [],
    });
    expect(SCORE_RACE_MODE.version).toBe(1);
    expect(SCORE_RACE_RULES.board).toBe(CLASSIC_RULES.board);
    expect(SCORE_RACE_RULES.placement).toBe(CLASSIC_RULES.placement);
    expect(SCORE_RACE_RULES.clearing).toBe(CLASSIC_RULES.clearing);
    expect(SCORE_RACE_RULES.revealing).toBe(CLASSIC_RULES.revealing);
    expect(SCORE_RACE_RULES.scoring).toBe(CLASSIC_RULES.scoring);
    expect(SCORE_RACE_RULES.progression).toBe(CLASSIC_RULES.progression);
    expect(SCORE_RACE_RULES.failure).toBe(CLASSIC_RULES.failure);
    expect(SCORE_RACE_MODE.session).toEqual({
      kind: 'timed-score-race@1',
      durationMs: 180_000,
      fairness: { kind: 'identical-sequence' },
      result: { kind: 'highest-score-wins@1', tie: 'tie' },
    });
  });

  test('shared clear/reveal/failure behavior remains intact', () => {
    const board = makeEmptyBoard();
    placeDisc(board, 6, 0, makeDisc(1, DiscKind.Numbered));
    expect(CLASSIC_RULES.clearing.isClearable(board, 6, 0, board[6]![0]!)).toBe(true);

    placeDisc(board, 6, 1, makeDisc(5, DiscKind.DoubleCracked));
    CLASSIC_RULES.revealing.revealAdjacent(board, [{ row: 6, col: 0 }]);
    expect(board[6]![1]!.kind).toBe(DiscKind.SingleCracked);

    const topEdge = makeEmptyBoard();
    placeDisc(topEdge, 0, 3, makeDisc(7, DiscKind.DoubleCracked));
    expect(CLASSIC_RULES.failure.isTerminalBoard(topEdge)).toBe(false);
    expect(CLASSIC_RULES.failure.gameOverReason(true, topEdge)).toBe('push-overflow');
  });

  test('level and generation progression retain their shipped cadence', () => {
    expect([1, 5, 23, 100].map(level => turnsForLevel(CLASSIC_RULES.progression, level)))
      .toEqual([30, 26, 8, 8]);
    expect([1, 2, 21, 100].map(level =>
      unnumberedProbabilityForLevel(CLASSIC_RULES.generation, level)))
      .toEqual([0.2, 0.21000000000000002, 0.4, 0.4]);
  });
});

describe('mode definitions and registries', () => {
  test('keeps catalog and solo policy outside engine rules', () => {
    expect(CLASSIC_MODE).toMatchObject({
      kind: 'solo',
      id: 'classic',
      name: 'Classic',
      hasTutorial: true,
      rules: CLASSIC_RULES,
      persistence: { kind: 'solo-autosave@1', enabled: true },
      stats: {
        kind: 'solo-account-stats@1',
        enabled: true,
        leaderboardEligible: true,
      },
    });
    expect(PARADOX_MODE.hasTutorial).toBe(false);
    expect(SOLO_MODES).toEqual([
      CLASSIC_MODE,
      GRAVITY_MODE,
      STACK_MODE,
      PARADOX_MODE,
    ]);
    expect(MULTIPLAYER_MODES).toEqual([SCORE_RACE_MODE]);
    expect(GAME_RULESETS).toEqual([
      CLASSIC_RULES,
      GRAVITY_RULES,
      STACK_RULES,
      PARADOX_RULES,
      SCORE_RACE_RULES,
    ]);
  });

  test('lookups reject unsupported identities explicitly', () => {
    expect(getSoloMode('classic')).toBe(CLASSIC_MODE);
    expect(getMultiplayerMode('score-race')).toBe(SCORE_RACE_MODE);
    expect(getGameRules('classic', 1)).toBe(CLASSIC_RULES);
    expect(() => getSoloMode('unknown')).toThrow(/unsupported solo mode/i);
    expect(() => getMultiplayerMode('unknown')).toThrow(/unsupported multiplayer mode/i);
    expect(() => getGameRules('classic', 99)).toThrow(/unsupported game rules/i);
  });

  test('registry validation rejects duplicate mode and rules identities', () => {
    expect(() => validateModeRegistries(
      [CLASSIC_MODE, CLASSIC_MODE],
      [],
      [CLASSIC_RULES],
    )).toThrow(/duplicate mode id/i);
    expect(() => validateModeRegistries(
      [CLASSIC_MODE],
      [],
      [CLASSIC_RULES, CLASSIC_RULES],
    )).toThrow(/duplicate rules identity/i);
  });
});

describe('rule definition validation', () => {
  test('deep-freezes complete rulesets and their shared modules', () => {
    expect(Object.isFrozen(CLASSIC_RULES)).toBe(true);
    expect(Object.isFrozen(CLASSIC_RULES.board)).toBe(true);
    expect(Object.isFrozen(CLASSIC_RULES.modifiers)).toBe(true);
  });

  test('rejects incompatible Gravity placement/clearing combinations', () => {
    const invalid = testMode({
      id: 'invalid-gravity',
      placement: {
        kind: 'stage-and-tilt@1',
        initialAngleDeg: 0,
        maxTiltDeltaDeg: 90,
      },
    });
    expect(() => defineGameRules(invalid)).toThrow(/must pair stage-and-tilt/i);
  });

  test('rejects duplicate modifiers', () => {
    const rewind = PARADOX_RULES.modifiers[0]!;
    expect(() => defineGameRules(testMode({
      id: 'duplicate-rewind',
      modifiers: [rewind, rewind],
    }))).toThrow(/repeat modifier/i);
  });

  test('identical-sequence multiplayer rejects board-adaptive generation', () => {
    expect(() => defineMultiplayerMode({
      kind: 'multiplayer',
      id: 'classic',
      version: 1,
      name: 'Invalid race',
      tagline: 'Invalid adaptive fairness fixture.',
      rules: CLASSIC_RULES,
      session: {
        kind: 'timed-score-race@1',
        durationMs: 60_000,
        fairness: { kind: 'identical-sequence' },
        result: { kind: 'highest-score-wins@1', tie: 'tie' },
      },
    })).toThrow(/board-adaptive generator/i);
  });
});
