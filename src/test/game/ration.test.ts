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
  rationForecast,
  rationLaneOutcome,
  rationPassBonus,
  rationLevelJudgment,
} from '../../game/modes/mode.js';
import { defineGameRules } from '../../game/modes/mode.js';
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
    | 'streakStep'
    | 'streakCap'
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
      streakStep: 0,
      streakCap: 2_500,
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
        streakStep: 0,
        streakCap: 2_500,
        rollingWindowDrops: 1,
        checkpointDrops: 1,
        purgeScorePenalty: 250,
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
});

describe('Ration next-check forecast', () => {
  const ration = RATION_RULES.ration!; // window 12, check every 6, band 12-19

  test('counts drops to the next check, building the window first', () => {
    expect(rationForecast(ration, 1, [], 0).dropsUntilCheck).toBe(12);
    expect(rationForecast(ration, 1, Array(5).fill(1), 5).dropsUntilCheck).toBe(7);
    expect(rationForecast(ration, 1, Array(11).fill(1), 11).dropsUntilCheck).toBe(1);
    expect(rationForecast(ration, 1, Array(12).fill(1), 12).dropsUntilCheck).toBe(6);
    expect(rationForecast(ration, 1, Array(12).fill(1), 13).dropsUntilCheck).toBe(5);
    expect(rationForecast(ration, 1, Array(12).fill(1), 17).dropsUntilCheck).toBe(1);
    expect(rationForecast(ration, 1, [], 0).building).toBe(true);
    expect(rationForecast(ration, 1, Array(12).fill(1), 12).building).toBe(false);
  });

  test('splits the window into breaks that stay and breaks that roll off', () => {
    const history = [3, 0, 1, 2, 0, 0, 4, 1, 0, 2, 2, 1]; // total 16
    const forecast = rationForecast(ration, 1, history, 12);
    // 6 drops to the check: only the newest 6 entries (4+1+0+2+2+1) stay.
    expect(forecast.locked).toBe(10);
    expect(forecast.leaving).toBe(6);
    expect(forecast.need).toEqual({ min: 2, max: 9 });
    expect(forecast.doomed).toBe(false);
    // One drop before the check, 11 entries stay.
    const next = rationForecast(ration, 1, history, 17);
    expect(next.dropsUntilCheck).toBe(1);
    expect(next.locked).toBe(16 - 3);
  });

  test('a filling window locks everything it holds, and a lost check is doomed', () => {
    const filling = rationForecast(ration, 1, [2, 2, 2], 3);
    expect(filling.locked).toBe(6);
    expect(filling.leaving).toBe(0);
    expect(filling.need).toEqual({ min: 6, max: 13 });
    const doomed = rationForecast(ration, 1, [5, 5, 5, 5], 4);
    expect(doomed.need.max).toBe(-1);
    expect(doomed.doomed).toBe(true);
    expect(rationForecast(ration, 1, [], 0).need.min).toBe(12);
  });

  test('mid-interval drops hold entropy and only flag lanes that can no longer pass', () => {
    const forecast = rationForecast(ration, 1, Array(12).fill(1), 12); // locked 6, need 6-13
    expect(rationLaneOutcome(ration, forecast, 0, 3, 0)).toEqual({ kind: 'open', entropyAfter: 3, endsRun: false, pointsAwarded: 0, streakAfter: 0 });
    expect(rationLaneOutcome(ration, forecast, 13, 3, 0).kind).toBe('open');
    expect(rationLaneOutcome(ration, forecast, 14, 3, 2)).toEqual({ kind: 'doomed', entropyAfter: 3, endsRun: false, pointsAwarded: 0, streakAfter: 2 });
  });

  test('the checking drop passes, or misses high or low, against the rules entropy figures', () => {
    const forecast = rationForecast(ration, 1, Array(12).fill(1), 17); // 1 drop left, locked 11, need 1-8
    expect(forecast.dropsUntilCheck).toBe(1);
    expect(rationLaneOutcome(ration, forecast, 1, 5, 0)).toEqual({
      kind: 'pass', entropyAfter: 3, endsRun: false, pointsAwarded: 750, streakAfter: 1,
    });
    expect(rationLaneOutcome(ration, forecast, 8, 1, 2)).toEqual({
      kind: 'pass', entropyAfter: 0, endsRun: false, pointsAwarded: 2_250, streakAfter: 3,
    });
    expect(rationLaneOutcome(ration, forecast, 0, 0, 3)).toEqual({
      kind: 'miss-low', entropyAfter: 1, endsRun: false, pointsAwarded: 0, streakAfter: 0,
    });
    expect(rationLaneOutcome(ration, forecast, 9, 2, 0)).toEqual({
      kind: 'miss-high', entropyAfter: 3, endsRun: false, pointsAwarded: 0, streakAfter: 0,
    });
    const last = ration.entropyThreshold - 1;
    expect(rationLaneOutcome(ration, forecast, 0, last, 0)).toEqual({
      kind: 'miss-low', entropyAfter: ration.entropyThreshold, endsRun: true, pointsAwarded: 0, streakAfter: 0,
    });
    expect(rationLaneOutcome(ration, forecast, 0, ration.entropyThreshold, 0).entropyAfter).toBe(ration.entropyThreshold);
  });

  test('predicts the engine exactly: whether a check ran, its result, and the entropy change', () => {
    let checks = 0;
    let passes = 0;
    let misses = 0;
    let doomedLanes = 0;
    let longestStreak = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const engine = new GameEngine({ rules: RATION_RULES, seed });
      for (let turn = 0; turn < 80 && engine.state.phase === GamePhase.WaitingForDrop; turn++) {
        const open = [...Array(RATION_RULES.board.cols).keys()]
          .filter(lane => engine.previewRationBreaks(lane) !== null);
        if (open.length === 0) break;
        const lane = open[(seed * 7 + turn * 3) % open.length]!;
        const breaks = engine.previewRationBreaks(lane)!;
        const forecast = rationForecast(ration, engine.state.level, engine.state.rationBreakHistory, engine.state.dropCount);
        const entropyBefore = engine.state.entropy;
        const balancedBefore = engine.state.balancedLevels;
        const streakBefore = engine.state.balancedStreak;
        const outcome = rationLaneOutcome(ration, forecast, breaks, entropyBefore, streakBefore);
        const result = engine.drop(lane);
        expect(result.accepted).toBe(true);
        if (result.gameOverReason === 'push-overflow') break; // no check runs; see design doc §7
        if (forecast.dropsUntilCheck > 1) {
          expect(engine.state.entropy).toBe(entropyBefore);
          expect(engine.state.balancedLevels).toBe(balancedBefore);
          // A doomed lane stays doomed: the next forecast cannot be recoverable.
          if (outcome.kind === 'doomed') {
            doomedLanes++;
            const after = rationForecast(ration, engine.state.level, engine.state.rationBreakHistory, engine.state.dropCount);
            expect(after.need.max).toBeLessThan(0);
          }
          continue;
        }
        checks++;
        expect(engine.state.entropy).toBe(outcome.entropyAfter);
        const passed = engine.state.balancedLevels === balancedBefore + 1;
        expect(passed).toBe(outcome.kind === 'pass');
        expect(engine.state.balancedStreak).toBe(outcome.streakAfter);
        const bonusPoints = result.steps.reduce(
          (total, step) => total + (
            step.kind === StepKind.Bonus && (step.bonusKind === 'balanced' || step.bonusKind === 'streak')
              ? step.pointsAwarded : 0
          ),
          0,
        );
        expect(bonusPoints).toBe(outcome.pointsAwarded);
        if (outcome.streakAfter > longestStreak) longestStreak = outcome.streakAfter;
        if (passed) passes++; else misses++;
        const endedByImbalance = result.gameOverReason === 'imbalance';
        if (!result.gameOverReason || endedByImbalance) expect(endedByImbalance).toBe(outcome.endsRun);
        if (result.gameOverReason) break;
      }
    }
    expect(checks).toBeGreaterThan(40);
    expect(passes).toBeGreaterThan(5);
    expect(misses).toBeGreaterThan(5);
    expect(doomedLanes).toBeGreaterThan(0);
    expect(longestStreak).toBeGreaterThan(1);
  });
});

describe('Ration balanced streak bonus', () => {
  const ration = RATION_RULES.ration!;

  test('the first pass pays the base bonus and each further pass adds a step up to the cap', () => {
    expect(ration.streakStep).toBe(750);
    expect(ration.streakCap).toBe(3_500);
    const paid = [1, 2, 3, 4, 5, 6, 40].map(streak => {
      const { base, extra } = rationPassBonus(ration, streak);
      return base + extra;
    });
    expect(paid).toEqual([750, 1_500, 2_250, 3_000, 3_500, 3_500, 3_500]);
    expect(rationPassBonus(ration, 1)).toEqual({ base: 750, extra: 0 });
    expect(rationPassBonus(ration, 0)).toEqual({ base: 750, extra: 0 });
  });

  test('rejects a cap below the base bonus', () => {
    expect(() => defineGameRules({ ...RATION_RULES, ration: { ...ration, streakCap: ration.balancedLevelBonus - 1 } }))
      .toThrow(/streak cap/);
  });

  /** One drop that is a check which a single break passes, entered with a given streak. */
  function playPassingCheck(streak: number) {
    const rules = rationTestMode({
      budget: 10,
      band: { center: 0.75, halfWidth: 0.25 },
      entropy: { balancedLevelBonus: 750, streakStep: 750, streakCap: 3_500 },
    });
    const engine = new GameEngine({ rules });
    const board = makeEmptyBoard();
    placeDisc(board, 5, 6, makeDisc(9, DiscKind.DoubleCracked));
    engine.loadScriptedState({
      rules,
      board,
      currentDisc: makeDisc(1, DiscKind.Numbered),
      nextDisc: makeDisc(7, DiscKind.Numbered),
      balancedStreak: streak,
      crackedDiscFactory: quietCrackedFactory(),
    });
    return { engine, result: engine.drop(0) };
  }

  test('a pass pays the base bonus alone at streak 0 and a separate streak step after that', () => {
    const first = playPassingCheck(0);
    expect(first.engine.state.balancedStreak).toBe(1);
    expect(first.result.steps.filter(step => step.kind === StepKind.Bonus))
      .toEqual([{ kind: StepKind.Bonus, bonusKind: 'balanced', pointsAwarded: 750 }]);

    const fourth = playPassingCheck(3);
    expect(fourth.engine.state.balancedStreak).toBe(4);
    expect(fourth.result.steps).toContainEqual({ kind: StepKind.Bonus, bonusKind: 'balanced', pointsAwarded: 750 });
    expect(fourth.result.steps).toContainEqual({ kind: StepKind.Bonus, bonusKind: 'streak', pointsAwarded: 2_250 });
    expect(fourth.result.scoreAwarded).toBe(7 + 750 + 2_250);
  });

  test('the total stops growing at the cap', () => {
    const capped = playPassingCheck(9);
    expect(capped.engine.state.balancedStreak).toBe(10);
    expect(capped.result.steps).toContainEqual({ kind: StepKind.Bonus, bonusKind: 'streak', pointsAwarded: 2_750 });
    expect(capped.result.scoreAwarded).toBe(7 + 3_500);
  });

  test('a missed check resets the streak', () => {
    const rules = rationTestMode({
      budget: 10,
      band: { center: 0.75, halfWidth: 0.25 },
      entropy: { balancedLevelBonus: 750, streakStep: 750, streakCap: 3_500 },
    });
    const engine = new GameEngine({
      rules,
      discFactory: numberedFactory(7, 7, 7, 7),
      crackedDiscFactory: quietCrackedFactory(),
    });
    engine.state.balancedStreak = 4;
    const result = engine.drop(0);
    expect(result.steps.some(step => step.kind === StepKind.Bonus && step.bonusKind === 'streak')).toBe(false);
    expect(engine.state.balancedStreak).toBe(0);
  });

  test('a streak survives save and load, and a save without one starts at 0', () => {
    const engine = new GameEngine({ rules: RATION_RULES, seed: 7 });
    engine.state.balancedStreak = 3;
    const save = engine.exportSave({ savedAt: 1 });
    expect(save.state.balancedStreak).toBe(3);
    const restored = new GameEngine({ rules: RATION_RULES, seed: 1 });
    restored.loadSave(save, RATION_RULES);
    expect(restored.state.balancedStreak).toBe(3);

    delete save.state.balancedStreak;
    const legacy = new GameEngine({ rules: RATION_RULES, seed: 1 });
    legacy.loadSave(save, RATION_RULES);
    expect(legacy.state.balancedStreak).toBe(0);
  });

  test('a new game starts without a streak', () => {
    const engine = new GameEngine({ rules: RATION_RULES, seed: 7 });
    engine.state.balancedStreak = 5;
    engine.reconfigure(RATION_RULES);
    expect(engine.state.balancedStreak).toBe(0);
  });
});
