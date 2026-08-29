import { describe, expect, test } from 'vitest';
import { makeEmptyBoard, placeDisc } from '../../game/board.js';
import { makeDisc } from '../../game/disc.js';
import { GameEngine, type TurnResult } from '../../game/engine.js';
import { StepKind } from '../../game/events.js';
import { DiscKind } from '../../game/model.js';
import {
  CLASSIC_MODE,
  SOLO_MODES,
  GRAVITY_MODE,
  PARADOX_MODE,
  STACK_MODE,
} from '../../game/modes/index.js';
import type { GameRulesConfig } from '../../game/modes/mode.js';
import { rewindModifier } from '../../game/modes/mode.js';
import { GamePhase } from '../../game/state.js';
import { doubleCrackedFactory, testMode } from '../helpers.js';

const SEED = 0x1234_5678;

const SHIPPED_MODES = [
  {
    mode: CLASSIC_MODE,
    initialTurns: 30,
    levelTwoTurns: 29,
    minimumTurns: 8,
    queue: [
      { value: 2, kind: DiscKind.Numbered },
      { value: 7, kind: DiscKind.DoubleCracked },
      { value: 4, kind: DiscKind.Numbered },
    ],
    capabilities: { canDrop: true, canTilt: false, canRewind: false },
    singleClearScore: 70_007,
  },
  {
    mode: GRAVITY_MODE,
    initialTurns: 30,
    levelTwoTurns: 29,
    minimumTurns: 8,
    queue: [
      { value: 2, kind: DiscKind.Numbered },
      { value: 7, kind: DiscKind.DoubleCracked },
      { value: 4, kind: DiscKind.Numbered },
    ],
    capabilities: { canDrop: false, canTilt: true, canRewind: false },
    singleClearScore: 70_007,
  },
  {
    mode: STACK_MODE,
    initialTurns: 22,
    levelTwoTurns: 21,
    minimumTurns: 8,
    queue: [
      { value: 2, kind: DiscKind.Numbered },
      { value: 6, kind: DiscKind.Numbered },
      { value: 7, kind: DiscKind.Numbered },
    ],
    capabilities: { canDrop: true, canTilt: false, canRewind: false },
    singleClearScore: 70_010,
  },
  {
    mode: PARADOX_MODE,
    initialTurns: 30,
    levelTwoTurns: 29,
    minimumTurns: 8,
    queue: [
      { value: 2, kind: DiscKind.Numbered },
      { value: 7, kind: DiscKind.DoubleCracked },
      { value: 4, kind: DiscKind.Numbered },
    ],
    capabilities: { canDrop: true, canTilt: false, canRewind: true },
    singleClearScore: 70_007,
  },
] as const;

function acceptTurn(engine: GameEngine, mode: GameRulesConfig, lane = 3): TurnResult {
  if (mode.placement.kind !== 'stage-and-tilt@1') return engine.drop(lane);

  expect(engine.stageGravityDrop(lane)).toBeUndefined();
  engine.tiltGravity(45);
  return engine.commitTilt();
}

describe('shipped solo mode behavior manifest', () => {
  test('records the intentional mode IDs and current save-rules compatibility version', () => {
    expect(SOLO_MODES.map(mode => ({
      modeId: mode.id,
      rulesVersion: mode.rules.version,
    }))).toEqual([
      { modeId: 'classic', rulesVersion: 1 },
      { modeId: 'gravity', rulesVersion: 1 },
      { modeId: 'stack', rulesVersion: 1 },
      { modeId: 'paradox', rulesVersion: 1 },
      { modeId: 'ration', rulesVersion: 1 },
    ]);
  });

  test.each(SHIPPED_MODES)('$mode.name initial state and fixed-seed queue stay stable', ({
    mode,
    initialTurns,
    queue,
  }) => {
    const engine = new GameEngine({ rules: mode.rules, seed: SEED });
    const save = engine.exportSave({ savedAt: 0 });

    expect(engine.state).toMatchObject({
      generationSeed: SEED,
      generationSource: 'seeded',
      phase: GamePhase.WaitingForDrop,
      cursorCol: 3,
      score: 0,
      dropCount: 0,
      level: 1,
      turnsPerLevel: initialTurns,
      turnsRemaining: initialTurns,
    });
    expect(engine.state.board).toEqual(makeEmptyBoard(7, 7));
    expect(engine.state.gravity).toEqual(
      mode.rules.placement.kind === 'stage-and-tilt@1'
        ? { angle: 0, turnStartAngle: 0, maxTiltDelta: 90 }
        : undefined,
    );
    expect(engine.state.paradox).toEqual(
      rewindModifier(mode.rules) ? { instability: 0 } : undefined,
    );
    expect(save.generation.queue).toEqual(queue);
    expect(save.generation.queue.slice(0, 2)).toEqual([
      { value: engine.state.currentDisc.value, kind: engine.state.currentDisc.kind },
      { value: engine.state.nextDisc.value, kind: engine.state.nextDisc.kind },
    ]);
  });

  test.each(SHIPPED_MODES)('$mode.name generation snapshots retain the resumable shape', ({
    mode,
    queue,
  }) => {
    const save = new GameEngine({ rules: mode.rules, seed: SEED }).exportSave({ savedAt: 0 });

    expect(save.generation).toEqual({
      source: 'seeded',
      seed: SEED,
      queue,
      playableGenerator: {
        recentValues: queue.map(disc => disc.value),
        recentKinds: queue.map(disc => disc.kind),
      },
      random: {
        playableState: expect.any(Number),
        pushState: expect.any(Number),
        echoState: expect.any(Number),
      },
    });
  });

  test.each(SHIPPED_MODES)('$mode.name consumes the final turn, pushes, and advances its level cadence', ({
    mode,
    levelTwoTurns,
  }) => {
    const engine = new GameEngine({ rules: mode.rules, seed: SEED });
    engine.loadScriptedState({
      rules: mode.rules,
      board: makeEmptyBoard(7, 7),
      currentDisc: makeDisc(7, DiscKind.Numbered),
      nextDisc: makeDisc(7, DiscKind.Numbered),
      turnsRemaining: 1,
      crackedDiscFactory: doubleCrackedFactory(),
    });

    const result = acceptTurn(engine, mode.rules);

    expect(result).toMatchObject({ accepted: true, gameOver: false, scoreAwarded: 7_000 });
    expect(result.steps).toContainEqual(expect.objectContaining({ kind: StepKind.Push }));
    expect(result.steps).toContainEqual({
      kind: StepKind.Bonus,
      bonusKind: 'level',
      pointsAwarded: 7_000,
    });
    expect(engine.state).toMatchObject({
      level: 2,
      turnsPerLevel: levelTwoTurns,
      turnsRemaining: levelTwoTurns,
    });
  });

  test.each(SHIPPED_MODES)('$mode.name retains its single-clear scoring behavior', ({
    mode,
    singleClearScore,
  }) => {
    const engine = new GameEngine({ rules: mode.rules, seed: SEED });
    engine.loadScriptedState({
      rules: mode.rules,
      board: makeEmptyBoard(7, 7),
      currentDisc: makeDisc(1, DiscKind.Numbered),
      nextDisc: makeDisc(7, DiscKind.Numbered),
    });

    const result = acceptTurn(engine, mode.rules);

    expect(result).toMatchObject({
      accepted: true,
      gameOver: false,
      scoreAwarded: singleClearScore,
      stackSize: 1,
    });
    expect(result.steps).toContainEqual(expect.objectContaining({
      kind: StepKind.Clear,
      cleared: expect.any(Array),
    }));
    expect(result.steps).toContainEqual({
      kind: StepKind.Bonus,
      bonusKind: 'board-clear',
      pointsAwarded: 70_000,
    });
    if (mode.rules.scoring.kind === 'stack-score@1') {
      expect(result.steps).toContainEqual({
        kind: StepKind.Bonus,
        bonusKind: 'stack',
        pointsAwarded: 10,
      });
    }
  });

  test.each(SHIPPED_MODES)('$mode.name retains its terminal-board behavior', ({ mode }) => {
    const topEdgeBoard = makeEmptyBoard(7, 7);
    placeDisc(topEdgeBoard, 0, 0, makeDisc(7, DiscKind.DoubleCracked));

    const fullBoard = makeEmptyBoard(7, 7);
    for (let row = 0; row < 7; row++) {
      for (let col = 0; col < 7; col++) {
        placeDisc(fullBoard, row, col, makeDisc(7, DiscKind.DoubleCracked));
      }
    }

    expect(mode.rules.failure.isTerminalBoard(makeEmptyBoard(7, 7))).toBe(false);
    expect(mode.rules.failure.isTerminalBoard(topEdgeBoard)).toBe(false);
    expect(mode.rules.failure.isTerminalBoard(fullBoard)).toBe(true);
    expect(mode.rules.failure.gameOverReason(true, topEdgeBoard)).toBe('push-overflow');

    const engine = new GameEngine({ rules: mode.rules, seed: SEED, board: fullBoard });
    expect(engine.state.phase).toBe(GamePhase.GameOver);
    expect(engine.drop(0)).toMatchObject({
      accepted: false,
      reason: 'game-over',
      gameOver: true,
    });
  });

  test.each(SHIPPED_MODES)('$mode.name retains its accepted-intent capabilities', ({
    mode,
    capabilities,
  }) => {
    const engine = new GameEngine({ rules: mode.rules, seed: SEED });

    const directDrop = engine.drop(3);
    if (capabilities.canTilt) {
      expect(directDrop).toMatchObject({ accepted: false, reason: 'tilt-required' });
    } else {
      expect(directDrop.accepted).toBe(true);
    }

    const accepted = capabilities.canTilt ? acceptTurn(engine, mode.rules) : directDrop;
    expect(accepted.accepted).toBe(true);
    expect(mode.rules.placement.kind === 'stage-and-tilt@1').toBe(capabilities.canTilt);
    expect(rewindModifier(mode.rules) !== undefined).toBe(capabilities.canRewind);
    expect(engine.canRewind()).toBe(capabilities.canRewind);
  });
});

describe('testMode', () => {
  test('applies focused nested overrides without sharing mutable configuration objects', () => {
    const mode = testMode({
      id: 'three-column-test',
      board: { cols: 3 },
      generation: { maxSameValueRun: 1 },
    });

    expect(mode.board).toEqual({ kind: 'rectangular-grid@1', cols: 3, rows: 7 });
    expect(mode.generation.maxSameValueRun).toBe(1);
    expect(mode.board).not.toBe(CLASSIC_MODE.rules.board);
    expect(mode.generation).not.toBe(CLASSIC_MODE.rules.generation);
    expect(mode.scoring).not.toBe(CLASSIC_MODE.rules.scoring);
  });

  test('clones modifier configuration from a chosen shipped-rules base', () => {
    const paradox = testMode({ id: 'short-paradox-test' }, PARADOX_MODE.rules);
    const gravity = testMode(
      { id: 'wide-gravity-test', board: { cols: 9 } },
      GRAVITY_MODE.rules,
    );

    expect(paradox.modifiers).toEqual(PARADOX_MODE.rules.modifiers);
    expect(paradox.modifiers).not.toBe(PARADOX_MODE.rules.modifiers);
    expect(paradox.modifiers[0]?.temporalEcho.tiers)
      .not.toBe(PARADOX_MODE.rules.modifiers[0]?.temporalEcho.tiers);
    expect(gravity.placement).toEqual(GRAVITY_MODE.rules.placement);
    expect(gravity.placement).toBe(GRAVITY_MODE.rules.placement);
  });
});
