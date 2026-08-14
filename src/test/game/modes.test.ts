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
  SHARED_DUEL_MODE,
  SHARED_DUEL_RULES,
  SOLO_MODES,
  STACK_MODE,
  STACK_RULES,
  getGameRules,
  getMultiplayerMode,
  getSoloMode,
  validateModeRegistries,
} from '../../game/modes/index.js';
import {
  SCORE_RACE_DURATION_MS,
  SCORE_RACE_MODE_ID,
  SCORE_RACE_MODE_VERSION,
  SCORE_RACE_RULES_VERSION,
  SHARED_DUEL_BOARD_COLS,
  SHARED_DUEL_BOARD_ROWS,
  SHARED_DUEL_DISRUPTION_THRESHOLD,
  SHARED_DUEL_MODE_ID,
  SHARED_DUEL_MODE_VERSION,
  SHARED_DUEL_RULES_VERSION,
  SHARED_DUEL_TURN_TIMEOUT_MS,
} from '../../shared/multiplayer-contracts.js';
import { GAME_OVER_REASONS } from '../../game/turn-types.js';
import { GAME_OVER_REASONS as SHARED_GAME_OVER_REASONS } from '../../shared/game-values.js';
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
    expect(MULTIPLAYER_MODES).toEqual([SCORE_RACE_MODE, SHARED_DUEL_MODE]);
    expect(GAME_RULESETS).toEqual([
      CLASSIC_RULES,
      GRAVITY_RULES,
      STACK_RULES,
      PARADOX_RULES,
      SCORE_RACE_RULES,
      SHARED_DUEL_RULES,
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

  test('shared-board-duel rejects a non-positive turn timeout', () => {
    expect(() => defineMultiplayerMode({
      kind: 'multiplayer',
      id: 'shared-duel',
      version: 1,
      name: 'Invalid duel',
      tagline: 'Invalid turn timeout fixture.',
      rules: SHARED_DUEL_RULES,
      session: {
        kind: 'shared-board-duel@1',
        turnTimeoutMs: 0,
        disruptionThreshold: 3,
        fairness: { kind: 'shared-board-seeded' },
        result: { kind: 'highest-score-wins@1', tie: 'tie' },
      },
    })).toThrow(/turn timeout/i);
  });

  test('shared-board-duel rejects a non-positive disruption threshold', () => {
    expect(() => defineMultiplayerMode({
      kind: 'multiplayer',
      id: 'shared-duel',
      version: 1,
      name: 'Invalid duel',
      tagline: 'Invalid disruption threshold fixture.',
      rules: SHARED_DUEL_RULES,
      session: {
        kind: 'shared-board-duel@1',
        turnTimeoutMs: 15_000,
        disruptionThreshold: 0,
        fairness: { kind: 'shared-board-seeded' },
        result: { kind: 'highest-score-wins@1', tie: 'tie' },
      },
    })).toThrow(/disruption threshold/i);
  });
});

describe('Disco Duel (shared-board-duel) mode definition', () => {
  test('composes Classic-adjacent rules with no Gravity or Paradox', () => {
    expect(SHARED_DUEL_RULES.board).toBe(CLASSIC_RULES.board);
    expect(SHARED_DUEL_RULES.placement).toBe(CLASSIC_RULES.placement);
    expect(SHARED_DUEL_RULES.clearing).toBe(CLASSIC_RULES.clearing);
    expect(SHARED_DUEL_RULES.revealing).toBe(CLASSIC_RULES.revealing);
    expect(SHARED_DUEL_RULES.progression).toBe(CLASSIC_RULES.progression);
    expect(SHARED_DUEL_RULES.failure).toBe(CLASSIC_RULES.failure);
    expect(SHARED_DUEL_RULES.modifiers).toEqual([]);
  });

  test('session rules match the design defaults', () => {
    expect(SHARED_DUEL_MODE.session).toEqual({
      kind: 'shared-board-duel@1',
      turnTimeoutMs: 15_000,
      disruptionThreshold: 3,
      fairness: { kind: 'shared-board-seeded' },
      result: { kind: 'highest-score-wins@1', tie: 'tie' },
    });
  });

  test('mode and rules identities line up with the registry', () => {
    expect(SHARED_DUEL_MODE.id).toBe('shared-duel');
    expect(SHARED_DUEL_MODE.rules).toBe(SHARED_DUEL_RULES);
    expect(getMultiplayerMode('shared-duel')).toBe(SHARED_DUEL_MODE);
  });
});

// src/game/modes/{score-race,shared-duel}.ts can't import
// src/shared/multiplayer-contracts.ts (the API's server-only game-engine
// build excludes src/shared from its compiled subtree), so each mode
// redeclares its own id/version/timing constants locally instead of
// importing the ones the API's room services build wire-protocol mode
// identities from. Nothing but this test keeps the two copies in sync — if
// they drift, sameMultiplayerModeIdentity() starts rejecting a compatible
// client/server pair (or worse, silently accepting an incompatible one).
describe('multiplayer mode identity stays in sync with the wire protocol constants', () => {
  test('Score Race', () => {
    expect(SCORE_RACE_MODE.id).toBe(SCORE_RACE_MODE_ID);
    expect(SCORE_RACE_MODE.version).toBe(SCORE_RACE_MODE_VERSION);
    expect(SCORE_RACE_RULES.version).toBe(SCORE_RACE_RULES_VERSION);
    expect(SCORE_RACE_MODE.session).toMatchObject({ durationMs: SCORE_RACE_DURATION_MS });
  });

  test('Disco Duel', () => {
    expect(SHARED_DUEL_MODE.id).toBe(SHARED_DUEL_MODE_ID);
    expect(SHARED_DUEL_MODE.version).toBe(SHARED_DUEL_MODE_VERSION);
    expect(SHARED_DUEL_RULES.version).toBe(SHARED_DUEL_RULES_VERSION);
    expect(SHARED_DUEL_MODE.session).toMatchObject({
      turnTimeoutMs: SHARED_DUEL_TURN_TIMEOUT_MS,
      disruptionThreshold: SHARED_DUEL_DISRUPTION_THRESHOLD,
    });
  });

  // multiplayer-messages.ts's wire parser validates Disco Duel boards
  // against these fixed dimensions rather than importing SHARED_DUEL_RULES.
  test('Disco Duel board dimensions', () => {
    expect(SHARED_DUEL_RULES.board).toMatchObject({
      rows: SHARED_DUEL_BOARD_ROWS,
      cols: SHARED_DUEL_BOARD_COLS,
    });
  });
});

// Same cross-tree-import constraint as above: src/game/turn-types.ts and
// src/shared/game-values.ts each declare their own GAME_OVER_REASONS rather
// than sharing one, because neither of the API's isolated src/game and
// src/shared builds can import from the other. If they drift, a game-over
// reason the engine can produce would be silently rejected (or a stale one
// silently accepted) by the multiplayer wire parser.
test('game-over reason vocabulary stays in sync between src/game and src/shared', () => {
  expect([...GAME_OVER_REASONS].sort()).toEqual([...SHARED_GAME_OVER_REASONS].sort());
});
