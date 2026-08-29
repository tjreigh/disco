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
      entropyThreshold: 4,
      entropyRecoveryPerLevel: 1,
      entropyMissBase: 1,
      entropyPerDeviationUnit: 0.1,
      maxEntropyGainPerLevel: 3,
      balancedLevelBonus: 2_500,
      ...overrides.entropy,
    },
  }, RATION_RULES);
}

describe('Ration band math', () => {
  const ration = RATION_RULES.ration!;

  test('the band center descends each level and floors at minBandCenter', () => {
    expect(rationBandForLevel(ration, 1)).toEqual({
      minBreaksPerDrop: 0.92 - 0.11,
      maxBreaksPerDrop: 0.92 + 0.11,
    });
    expect(rationBandForLevel(ration, 2)).toEqual({
      minBreaksPerDrop: 0.87 - 0.11,
      maxBreaksPerDrop: 0.87 + 0.11,
    });
    expect(rationBandForLevel(ration, 7)).toEqual({
      minBreaksPerDrop: 0.62 - 0.11,
      maxBreaksPerDrop: 0.62 + 0.11,
    });
    expect(rationBandForLevel(ration, 8)).toEqual({
      minBreaksPerDrop: 0.6 - 0.11,
      maxBreaksPerDrop: 0.6 + 0.11,
    });
    expect(rationBandForLevel(ration, 100)).toEqual({
      minBreaksPerDrop: 0.6 - 0.11,
      maxBreaksPerDrop: 0.6 + 0.11,
    });
  });

  test('the integer break range exactly matches the ratio judgment', () => {
    expect(rationBreakBand(ration, 2, 29)).toEqual({ minBreaks: 23, maxBreaks: 28 });
    // Both edges of the rounded range are balanced; one break outside either
    // edge falls out of band.
    expect(rationLevelJudgment(ration, 2, 23, 29)).toMatchObject({ balanced: true, deviation: 0 });
    expect(rationLevelJudgment(ration, 2, 28, 29)).toMatchObject({ balanced: true, deviation: 0 });
    expect(rationLevelJudgment(ration, 2, 22, 29)).toMatchObject({ balanced: false });
    expect(rationLevelJudgment(ration, 2, 29, 29)).toMatchObject({ balanced: false });
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

  test('a fresh level cannot overshoot because the board starts empty', () => {
    expect(rationBreakBand(ration, 1, 30).maxBreaks).toBeLessThanOrEqual(30);
  });

  test('entropy gain scales with deviation and caps per level', () => {
    expect(rationEntropyGain(ration, 0)).toBe(0);
    expect(rationEntropyGain(ration, 0.05)).toBe(1);
    expect(rationEntropyGain(ration, 0.5)).toBe(3); // 1 + 5, capped at 3
    expect(rationEntropyGain(ration, 2.5)).toBe(3);
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
    expect(engine.state.balancedLevels).toBe(1);
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

  test('a missed level forfeits the level bonus and adds entropy', () => {
    const rules = rationTestMode({ budget: 1, band: { center: 0.75, halfWidth: 0.25 } });
    const engine = new GameEngine({
      rules,
      discFactory: numberedFactory(7, 7, 7, 7),
      crackedDiscFactory: quietCrackedFactory(),
    });

    const result = engine.drop(0);

    expect(engine.state.breaksThisLevel).toBe(0);
    expect(result.steps.some(step => step.kind === StepKind.Bonus && step.bonusKind === 'level')).toBe(false);
    expect(result.scoreAwarded).toBe(0);
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
    expect(result.steps.some(step => step.kind === StepKind.Bonus && step.bonusKind === 'level')).toBe(false);
    expect(engine.state.entropy).toBe(3);
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
    delete save.state.entropy;
    delete save.state.balancedLevels;
    const restored = new GameEngine({ rules, seed: 7 });
    restored.loadSave(save, rules);

    expect(restored.state.breaksThisLevel).toBe(0);
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
    for (const lane of [...firstPlays, ...restPlays]) live.drop(lane);

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
