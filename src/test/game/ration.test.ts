import { describe, expect, test } from 'vitest';
import { GameEngine } from '../../game/engine.js';
import { makeEmptyBoard, placeDisc } from '../../game/board.js';
import { makeDisc } from '../../game/disc.js';
import { DiscKind } from '../../game/model.js';
import { StepKind } from '../../game/events.js';
import { GamePhase } from '../../game/state.js';
import { RATION_RULES, RATION_MODE } from '../../game/modes/index.js';
import {
  rationBandForLevel,
  rationBreakBand,
  rationEntropyGain,
  rationLaneProjection,
  rationLevelJudgment,
} from '../../game/modes/mode.js';
import type { RationRules } from '../../game/modes/mode.js';
import { doubleCrackedFactory, testMode } from '../helpers.js';

function numberedFactory(...values: number[]): () => ReturnType<typeof makeDisc> {
  let index = 0;
  return () => makeDisc(values[index++ % values.length]!, DiscKind.Numbered);
}

// Cracked-disc values of 9 never match a run (counts stay within 1..7), so a
// reveal can never trigger an accidental clear in these scenarios.
function quietCrackedFactory() {
  return () => makeDisc(9, DiscKind.DoubleCracked);
}

/** Constant-budget Ration test mode with a fixed band and classic entropy tuning. */
function rationTestMode(overrides: {
  budget?: number;
  rollingWindowDrops?: number;
  checkpointDrops?: number;
  band?: { center: number; halfWidth: number };
  entropy?: Partial<Pick<RationRules,
    | 'entropyThreshold'
    | 'entropyRecoveryPerLevel'
    | 'entropyMissBase'
    | 'entropyPerDeviationUnit'
    | 'maxEntropyGainPerLevel'
    | 'balancedLevelBonus'
  >>;
} = {}) {
  const budget = overrides.budget ?? 1;
  const rollingWindowDrops = overrides.rollingWindowDrops ?? 1;
  const checkpointDrops = overrides.checkpointDrops ?? 1;
  const center = overrides.band?.center ?? 0.75;
  const halfWidth = overrides.band?.halfWidth ?? 0.25;
  return testMode({
    id: 'ration-test',
    progression: { initialTurnsPerLevel: budget, turnsPerLevelStep: 0, minTurnsPerLevel: budget },
    ration: {
      kind: 'ration-band@1',
      initialBandCenter: center,
      bandCenterLevelStep: 0,
      minBandCenter: center,
      bandHalfWidth: halfWidth,
      rollingWindowDrops,
      checkpointDrops,
      entropyThreshold: 4,
      entropyRecoveryPerLevel: 1,
      entropyMissBase: 1,
      entropyPerDeviationUnit: 0.1,
      maxEntropyGainPerLevel: 3,
      balancedLevelBonus: 2_500,
      purgeScorePenalty: 250,
      ...overrides.entropy,
    },
  }, RATION_RULES);
}

describe('Ration band math', () => {
  const ration = RATION_RULES.ration!;

  // A descending band is still supported by the rules even though production
  // Ration ships a flat one, so exercise the descent against a fixture.
  const descending: RationRules = {
    ...ration,
    initialBandCenter: 0.85,
    bandCenterLevelStep: 0.03,
    minBandCenter: 0.65,
    bandHalfWidth: 0.2,
  };

  test('the shipped band is flat at 1.3 breaks per drop ±0.3', () => {
    for (const level of [1, 2, 10, 100]) {
      expect(rationBandForLevel(ration, level)).toMatchObject({
        minBreaksPerDrop: expect.closeTo(1.0),
        maxBreaksPerDrop: expect.closeTo(1.6),
      });
    }
    expect(rationBreakBand(ration, 1, ration.rollingWindowDrops)).toEqual({ minBreaks: 12, maxBreaks: 19 });
  });

  test('the band center descends each level and floors at minBandCenter', () => {
    expect(rationBandForLevel(descending, 1)).toEqual({
      minBreaksPerDrop: 0.85 - 0.2,
      maxBreaksPerDrop: 0.85 + 0.2,
    });
    expect(rationBandForLevel(descending, 2)).toEqual({
      minBreaksPerDrop: 0.82 - 0.2,
      maxBreaksPerDrop: 0.82 + 0.2,
    });
    expect(rationBandForLevel(descending, 7)).toMatchObject({
      minBreaksPerDrop: expect.closeTo(0.47),
      maxBreaksPerDrop: expect.closeTo(0.87),
    });
    expect(rationBandForLevel(descending, 8)).toEqual({
      minBreaksPerDrop: 0.65 - 0.2,
      maxBreaksPerDrop: 0.65 + 0.2,
    });
    expect(rationBandForLevel(descending, 100)).toEqual({
      minBreaksPerDrop: 0.65 - 0.2,
      maxBreaksPerDrop: 0.65 + 0.2,
    });
  });

  test('the integer break range exactly matches the ratio judgment', () => {
    expect(rationBreakBand(descending, 2, 29)).toEqual({ minBreaks: 18, maxBreaks: 29 });
    // Both edges of the rounded range are balanced; one break outside either
    // edge falls out of band.
    expect(rationLevelJudgment(descending, 2, 18, 29)).toMatchObject({ balanced: true, deviation: 0 });
    expect(rationLevelJudgment(descending, 2, 29, 29)).toMatchObject({ balanced: true, deviation: 0 });
    expect(rationLevelJudgment(descending, 2, 17, 29)).toMatchObject({ balanced: false });
    expect(rationLevelJudgment(descending, 2, 30, 29)).toMatchObject({ balanced: false });
  });

  test('the upper bound is not clamped to the turn budget (carry-over clears)', () => {
    const narrow = testMode({
      id: 'ration-tight-upper',
      ration: {
        kind: 'ration-band@1',
        initialBandCenter: 1.2,
        bandCenterLevelStep: 0,
        minBandCenter: 1.2,
        bandHalfWidth: 0.1,
        entropyThreshold: 4,
        entropyRecoveryPerLevel: 1,
        entropyMissBase: 1,
        entropyPerDeviationUnit: 0.1,
        maxEntropyGainPerLevel: 3,
        balancedLevelBonus: 2_500,
      },
    }, RATION_RULES).ration!;
    expect(rationBreakBand(narrow, 1, 30)).toEqual({ minBreaks: 33, maxBreaks: 39 });
  });

  test('the rolling band permits carry-over clears above one break per drop', () => {
    expect(rationBreakBand(ration, 1, 30).maxBreaks).toBeGreaterThan(30);
  });

  test('entropy gain scales with deviation and caps per level', () => {
    const scaled: RationRules = { ...ration, maxEntropyGainPerLevel: 2 };
    expect(rationEntropyGain(scaled, 0)).toBe(0);
    expect(rationEntropyGain(scaled, 0.05)).toBe(1);
    expect(rationEntropyGain(scaled, 0.5)).toBe(2); // capped at 2
    expect(rationEntropyGain(scaled, 2.5)).toBe(2);
  });

  test('the shipped entropy tuning caps a single miss at one point', () => {
    expect(rationEntropyGain(ration, 0)).toBe(0);
    expect(rationEntropyGain(ration, 0.05)).toBe(1);
    expect(rationEntropyGain(ration, 2.5)).toBe(1);
  });
});

describe('Ration level judgment in the engine', () => {
  test('breaks accumulate across a level and reset at the level boundary', () => {
    const rules = rationTestMode({ budget: 3, band: { center: 1, halfWidth: 1 } });
    const engine = new GameEngine({
      rules,
      discFactory: numberedFactory(1, 1, 1, 1),
      crackedDiscFactory: quietCrackedFactory(),
    });

    engine.drop(0);
    expect(engine.state.breaksThisLevel).toBe(1);

    engine.drop(1);
    expect(engine.state.breaksThisLevel).toBe(2);

    const result = engine.drop(2);
    expect(engine.state.breaksThisLevel).toBe(0);
    expect(engine.state.level).toBe(2);
    expect(engine.state.balancedLevels).toBe(3);
    expect(result.steps).toContainEqual({
      kind: StepKind.Bonus,
      bonusKind: 'level',
      pointsAwarded: 7_000,
    });
    expect(result.steps).toContainEqual({
      kind: StepKind.Bonus,
      bonusKind: 'balanced',
      pointsAwarded: 2_500,
    });
  });

  test('a balanced level awards both bonuses and recovers entropy', () => {
    const rules = rationTestMode({ budget: 1, band: { center: 0.75, halfWidth: 0.25 } });
    const engine = new GameEngine({ rules });
    const board = makeEmptyBoard();
    // A non-matching cracked disc keeps the clear from emptying the board, so
    // no board-clear bonus distorts the score assertion.
    placeDisc(board, 5, 6, makeDisc(9, DiscKind.DoubleCracked));
    engine.loadScriptedState({
      rules,
      board,
      currentDisc: makeDisc(1, DiscKind.Numbered),
      nextDisc: makeDisc(7, DiscKind.Numbered),
      turnsRemaining: 1,
      entropy: 2,
      crackedDiscFactory: quietCrackedFactory(),
    });

    const result = engine.drop(0);

    expect(result.scoreAwarded).toBe(7 + 7_000 + 2_500);
    expect(engine.state.entropy).toBe(1);
    expect(engine.state.balancedLevels).toBe(1);
    expect(engine.state.level).toBe(2);
  });

  test('a missed checkpoint keeps the normal level bonus but adds entropy', () => {
    const rules = rationTestMode({ budget: 1, band: { center: 0.75, halfWidth: 0.25 } });
    const engine = new GameEngine({
      rules,
      discFactory: numberedFactory(7, 7, 7, 7),
      crackedDiscFactory: quietCrackedFactory(),
    });

    const result = engine.drop(0);

    expect(engine.state.breaksThisLevel).toBe(0);
    expect(result.steps.some(step => step.kind === StepKind.Bonus && step.bonusKind === 'level')).toBe(true);
    expect(result.scoreAwarded).toBe(7_000);
    expect(engine.state.entropy).toBe(3); // 1 + floor(0.5 / 0.1), capped at 3
    expect(engine.state.balancedLevels).toBe(0);
    expect(engine.state.level).toBe(2);
  });

  test('an over-band clear also counts as a miss', () => {
    const rules = rationTestMode({ budget: 1, band: { center: 0.25, halfWidth: 0.25 } });
    const board = makeEmptyBoard();
    placeDisc(board, 6, 0, makeDisc(3, DiscKind.Numbered));
    placeDisc(board, 6, 1, makeDisc(3, DiscKind.Numbered));
    const engine = new GameEngine({ rules });
    engine.loadScriptedState({
      rules,
      board,
      currentDisc: makeDisc(3, DiscKind.Numbered),
      nextDisc: makeDisc(7, DiscKind.Numbered),
      turnsRemaining: 1,
      crackedDiscFactory: quietCrackedFactory(),
    });

    const result = engine.drop(2);

    expect(result.stackSize).toBe(3);
    expect(result.steps.some(step => step.kind === StepKind.Bonus && step.bonusKind === 'level')).toBe(true);
    expect(engine.state.entropy).toBe(3);
  });

  test('judges a full rolling ledger at checkpoints instead of level boundaries', () => {
    const rules = rationTestMode({
      budget: 10,
      rollingWindowDrops: 3,
      checkpointDrops: 3,
      band: { center: 1, halfWidth: 0.01 },
    });
    const engine = new GameEngine({
      rules,
      discFactory: numberedFactory(1, 1, 1, 1),
      crackedDiscFactory: quietCrackedFactory(),
    });

    engine.drop(0);
    engine.drop(1);
    expect(engine.state.entropy).toBe(0);
    expect(engine.state.balancedLevels).toBe(0);

    const checkpoint = engine.drop(2);
    expect(engine.state.rationBreakHistory).toEqual([1, 1, 1]);
    expect(engine.state.balancedLevels).toBe(1);
    expect(checkpoint.steps).toContainEqual({
      kind: StepKind.Bonus,
      bonusKind: 'balanced',
      pointsAwarded: 2_500,
    });
  });

  test('Purging an exposed lane disc costs score without changing the ledger or consuming a drop', () => {
    const rules = rationTestMode({ budget: 10 });
    const board = makeEmptyBoard();
    placeDisc(board, 5, 3, makeDisc(6, DiscKind.Numbered));
    const engine = new GameEngine({ rules });
    engine.loadScriptedState({
      rules,
      board,
      currentDisc: makeDisc(2, DiscKind.Numbered),
      score: 2_500,
      rationBreakHistory: [1, 0],
    });

    expect(engine.canPurge(3)).toBe(true);
    expect(engine.purge(3)).toEqual({ row: 5, col: 3 });
    expect(engine.state.board[5]![3]).toBeNull();
    expect(engine.state.score).toBe(2_250);
    expect(engine.state.dropCount).toBe(0);
    expect(engine.state.rationBreakHistory).toEqual([1, 0]);
    expect(engine.canPurge(3)).toBe(false);
  });

  test('repeated misses fill the entropy meter and end the run with imbalance', () => {
    const rules = rationTestMode({ budget: 1, band: { center: 0.75, halfWidth: 0.25 } });
    const engine = new GameEngine({
      rules,
      discFactory: numberedFactory(7, 7, 7, 7),
      crackedDiscFactory: quietCrackedFactory(),
    });

    engine.drop(0);
    expect(engine.state.entropy).toBe(3);
    expect(engine.state.phase).toBe(GamePhase.WaitingForDrop);

    const result = engine.drop(1);

    expect(engine.state.entropy).toBe(4);
    expect(engine.state.phase).toBe(GamePhase.GameOver);
    expect(result.gameOver).toBe(true);
    expect(result.gameOverReason).toBe('imbalance');
    expect(engine.state.level).toBe(2); // no level-up on game over
  });

  test('a balanced level recovers previously accumulated entropy', () => {
    const rules = rationTestMode({ budget: 1, band: { center: 0.75, halfWidth: 0.25 } });
    const engine = new GameEngine({
      rules,
      discFactory: numberedFactory(7, 1, 7, 7),
      crackedDiscFactory: quietCrackedFactory(),
    });

    engine.drop(0); // miss, entropy 3
    expect(engine.state.entropy).toBe(3);

    // Column 6 is far from the value-7 disc left over from level 1, so the 1
    // matches only its own row run and clears exactly one disc → in band.
    engine.drop(6);
    expect(engine.state.entropy).toBe(2);
    expect(engine.state.balancedLevels).toBe(1);
  });

  test('restart resets entropy, level breaks, and balanced level count', () => {
    const rules = rationTestMode({ budget: 1, band: { center: 0.75, halfWidth: 0.25 } });
    const engine = new GameEngine({
      rules,
      discFactory: numberedFactory(7, 7, 7, 7),
      crackedDiscFactory: quietCrackedFactory(),
    });

    engine.drop(0);
    expect(engine.state.entropy).toBe(3);
    engine.restart();

    expect(engine.state.entropy).toBe(0);
    expect(engine.state.breaksThisLevel).toBe(0);
    expect(engine.state.balancedLevels).toBe(0);
    expect(engine.state.level).toBe(1);
  });
});

describe('Ration save and reload', () => {
  test('persists and restores level breaks, entropy, and balanced levels', () => {
    const rules = rationTestMode({ budget: 1, band: { center: 0.75, halfWidth: 0.25 } });
    const source = new GameEngine({ rules });
    source.loadScriptedState({
      rules,
      board: makeEmptyBoard(),
      currentDisc: makeDisc(7, DiscKind.Numbered),
      nextDisc: makeDisc(1, DiscKind.Numbered),
      score: 12_345,
      level: 4,
      turnsRemaining: 1,
      breaksThisLevel: 5,
      rationBreakHistory: [0, 1, 3],
      rationPurgeUsed: true,
      entropy: 2,
      balancedLevels: 3,
      crackedDiscFactory: quietCrackedFactory(),
    });
    // Scripted states use injected generation, which exportSave rejects; hand
    // control back to a seeded queue (the progress and Ration counters stay).
    source.resumeSeededGeneration(42);

    const save = source.exportSave({ savedAt: 42 });
    const restored = new GameEngine({ rules, seed: 99 });
    restored.loadSave(save, rules);

    expect(restored.state.breaksThisLevel).toBe(5);
    expect(restored.state.rationBreakHistory).toEqual([0, 1, 3]);
    expect(restored.state.rationPurgeUsed).toBe(true);
    expect(restored.state.entropy).toBe(2);
    expect(restored.state.balancedLevels).toBe(3);
    expect(restored.state.level).toBe(4);
    expect(restored.state.score).toBe(12_345);
  });

  test('a save without ration fields loads as a fresh level (legacy compatibility)', () => {
    const rules = rationTestMode({ budget: 1, band: { center: 0.75, halfWidth: 0.25 } });
    const source = new GameEngine({ rules });
    const save = source.exportSave({ savedAt: 42 });
    // Simulate a save produced before the Ration counters existed: the optional
    // keys are absent rather than present-but-zero.
    delete save.state.breaksThisLevel;
    delete save.state.rationBreakHistory;
    delete save.state.rationPurgeUsed;
    delete save.state.entropy;
    delete save.state.balancedLevels;
    const restored = new GameEngine({ rules, seed: 7 });
    restored.loadSave(save, rules);

    expect(restored.state.breaksThisLevel).toBe(0);
    expect(restored.state.rationBreakHistory).toEqual([]);
    expect(restored.state.rationPurgeUsed).toBe(false);
    expect(restored.state.entropy).toBe(0);
    expect(restored.state.balancedLevels).toBe(0);
  });

  test('a loaded mid-level save continues to judge the same band outcomes', () => {
    const rules = rationTestMode({ budget: 1, band: { center: 0.75, halfWidth: 0.25 } });
    const seed = 0x12345678;
    const firstPlays = [3, 0, 6];
    const restPlays = [5, 1, 2, 4, 6, 0, 3];

    const source = new GameEngine({ rules, seed });
    for (const lane of firstPlays) source.drop(lane);
    const restored = new GameEngine({ rules, seed: 99 });
    restored.loadSave(source.exportSave({ savedAt: 7 }), rules);

    // A never-saved twin plays the whole sequence so the resumed engine can be
    // compared turn by turn against the identical original trajectory.
    const live = new GameEngine({ rules, seed });
    for (const lane of firstPlays) live.drop(lane);

    for (const lane of restPlays) {
      const fromSave = restored.drop(lane);
      const fromLive = live.drop(lane);
      expect(fromSave.scoreAwarded).toBe(fromLive.scoreAwarded);
      expect(fromSave.gameOver).toBe(fromLive.gameOver);
    }
    expect(restored.state.entropy).toBe(live.state.entropy);
    expect(restored.state.balancedLevels).toBe(live.state.balancedLevels);
    expect(restored.state.level).toBe(live.state.level);
    expect(restored.state.score).toBe(live.state.score);
  });
});

describe('Ration mode registration', () => {
  test('ships with stats and autosave enabled and no tutorial yet', () => {
    expect(RATION_MODE).toMatchObject({
      kind: 'solo',
      id: 'ration',
      name: 'Ration',
      hasTutorial: false,
      rules: RATION_RULES,
      persistence: { kind: 'solo-autosave@1', enabled: true },
      stats: { kind: 'solo-account-stats@1', enabled: true, leaderboardEligible: true },
    });
  });
});

describe('Ration lane preview', () => {
  const SAVED_AT = 1;

  test('previews exactly the breaks a real drop produces, including level pushes', () => {
    let pushTurns = 0;
    let comparedDrops = 0;
    for (let seed = 1; seed <= 25; seed++) {
      const engine = new GameEngine({ rules: RATION_RULES, seed });
      for (let turn = 0; turn < 60 && engine.state.phase === GamePhase.WaitingForDrop; turn++) {
        const open = [...Array(RATION_RULES.board.cols).keys()]
          .filter(lane => engine.previewRationBreaks(lane) !== null);
        if (open.length === 0) break;
        // Pick lanes that vary with the seed and turn so many shapes are covered.
        const lane = open[(seed * 7 + turn * 3) % open.length]!;
        const previewed = engine.previewRationBreaks(lane);
        const completesLevel = engine.state.turnsRemaining <= 1;
        const result = engine.drop(lane);
        expect(result.accepted).toBe(true);
        // A push that overflows ends the run without resolving, so only the
        // non-fatal outcome is comparable.
        if (!(completesLevel && result.gameOverReason === 'push-overflow')) {
          expect(previewed).toBe(result.stackSize);
          comparedDrops++;
        }
        if (completesLevel) pushTurns++;
      }
    }
    expect(comparedDrops).toBeGreaterThan(300);
    expect(pushTurns).toBeGreaterThan(20);
  });

  test('previewing every lane never changes the game or its generation', () => {
    for (const seed of [3, 11, 29]) {
      const engine = new GameEngine({ rules: RATION_RULES, seed });
      for (let turn = 0; turn < 40 && engine.state.phase === GamePhase.WaitingForDrop; turn++) {
        const before = JSON.stringify(engine.exportSave({ savedAt: SAVED_AT }));
        const boardBefore = JSON.stringify(engine.state.board);
        for (let lane = 0; lane < RATION_RULES.board.cols; lane++) engine.previewRationBreaks(lane);
        expect(JSON.stringify(engine.state.board)).toBe(boardBefore);
        expect(JSON.stringify(engine.exportSave({ savedAt: SAVED_AT }))).toBe(before);
        const lane = [...Array(RATION_RULES.board.cols).keys()]
          .find(candidate => engine.previewRationBreaks(candidate) !== null);
        if (lane === undefined) break;
        engine.drop(lane);
      }
    }
  });

  test('previews nothing for full lanes, other modes, or outside the waiting phase', () => {
    const ration = new GameEngine({ rules: RATION_RULES, seed: 5 });
    expect(ration.previewRationBreaks(-1)).toBeNull();
    expect(ration.previewRationBreaks(RATION_RULES.board.cols)).toBeNull();
    expect(ration.previewRationBreaks(0)).not.toBeNull();
    ration.state.phase = GamePhase.Animating;
    expect(ration.previewRationBreaks(0)).toBeNull();

    const classic = new GameEngine({ seed: 5 });
    expect(classic.previewRationBreaks(0)).toBeNull();

    const full = new GameEngine({ rules: RATION_RULES, seed: 5 });
    for (let row = 0; row < RATION_RULES.board.rows; row++) {
      full.state.board[row]![0] = makeDisc(9, DiscKind.DoubleCracked);
    }
    expect(full.previewRationBreaks(0)).toBeNull();
    expect(full.previewRationBreaks(1)).not.toBeNull();
  });

  test('projects the rolling window and classifies it against the band', () => {
    const ration = RATION_RULES.ration!;
    // A full window drops its oldest entry: 12 + 4 - 1 = 15, inside 12-19.
    expect(rationLaneProjection(ration, 1, Array(12).fill(1), 4)).toEqual({
      breaks: 4, projectedTotal: 15, status: 'in-band',
    });
    expect(rationLaneProjection(ration, 1, Array(11).fill(1), 0).status).toBe('under');
    expect(rationLaneProjection(ration, 1, Array(12).fill(2), 4).status).toBe('over');
  });

  test('a window that is still filling is pro-rated, and only too much is called out', () => {
    const ration = RATION_RULES.ration!;
    // Two drops in: 1 + 1 = 2 against a pro-rated band of 2-3.
    expect(rationLaneProjection(ration, 1, [1], 1).status).toBe('in-band');
    expect(rationLaneProjection(ration, 1, [1], 5).status).toBe('over');
    // Falling short this early can still be made up, so it is not "under".
    expect(rationLaneProjection(ration, 1, [1], 0).status).toBe('pending');
    expect(rationLaneProjection(ration, 1, [], 0).status).toBe('pending');
    expect(rationLaneProjection(ration, 1, [], 1).status).toBe('in-band');
  });
});
