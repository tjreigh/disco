import { describe, expect, test } from 'vitest';
import { makeEmptyBoard, placeDisc } from '../../game/board.js';
import { makeDisc } from '../../game/disc.js';
import { GameEngine } from '../../game/engine.js';
import { StepKind } from '../../game/events.js';
import { DiscKind } from '../../game/model.js';
import { CLASSIC_RULES, PARADOX_RULES } from '../../game/modes/index.js';
import { testMode } from '../helpers.js';
import { GamePhase } from '../../game/state.js';

const SEED = 0x1357_2468;

function stableSave(engine: GameEngine) {
  return engine.exportSave({ savedAt: 0 });
}

describe('Paradox rewind history', () => {
  test('restores pre-turn progress in place and materializes missing fracture debt', () => {
    const engine = new GameEngine({ rules: PARADOX_RULES, seed: SEED });
    const stateReference = engine.state;
    const before = stableSave(engine);

    const turn = engine.drop(2);
    expect(turn.accepted).toBe(true);
    expect(engine.canRewind()).toBe(true);

    const rewind = engine.commitRewind();

    expect(rewind).not.toBeNull();
    expect(rewind!.fractures).toEqual([
      expect.objectContaining({
        materialized: true,
        instabilityDebt: 1,
        instabilityAdded: 1,
      }),
    ]);
    expect(engine.state).toBe(stateReference);
    const afterRewind = stableSave(engine);
    expect(afterRewind.state).toMatchObject({
      ...before.state,
      board: expect.any(Array),
    });
    expect(afterRewind.generation).toEqual(before.generation);
    expect(afterRewind.paradox).toEqual({ instability: 1 });
    const remnant = engine.state.board.flat().find(disc => disc?.temporalFracture);
    expect(remnant).toMatchObject({
      kind: DiscKind.SingleCracked,
      temporalFracture: { createdAtInstability: 1, instabilityDebt: 1 },
    });
    expect(engine.canRewind()).toBe(false);
    expect(engine.previewRewind()).toBeNull();
    expect(engine.commitRewind()).toBeNull();
  });

  test('preview is pure, independent, and reports the erased drop anchor', () => {
    const engine = new GameEngine({ rules: PARADOX_RULES, seed: SEED });
    const before = stableSave(engine);
    const turn = engine.drop(4);
    const drop = turn.steps.find(step => step.kind === StepKind.Drop);
    expect(drop?.kind).toBe(StepKind.Drop);
    const afterTurn = stableSave(engine);

    const first = engine.previewRewind()!;
    expect(first.score).toBe(before.state.score);
    expect(first.dropCount).toBe(before.state.dropCount);
    expect(first.turnsRemaining).toBe(before.state.turnsRemaining);
    expect(first.currentDisc).toEqual(before.generation.queue[0]);
    expect(first.nextDisc).toEqual(before.generation.queue[1]);
    expect(first.anchor).toEqual(drop?.kind === StepKind.Drop ? drop.landPos : undefined);
    expect(first.rescuesGameOver).toBe(false);

    first.board[0]![0] = makeDisc(7, DiscKind.DoubleCracked);
    const second = engine.previewRewind()!;
    expect(second.board[0]![0]).toBeNull();
    expect(second).not.toBe(first);
    expect(stableSave(engine)).toEqual(afterTurn);
    expect(engine.canRewind()).toBe(true);
  });

  test('rewinds generator history and all random streams', () => {
    const pushEveryTurn = testMode({
      id: 'paradox-push-every-turn-test',
      progression: { initialTurnsPerLevel: 1, turnsPerLevelStep: 0, minTurnsPerLevel: 1 },
    }, PARADOX_RULES);
    const rewound = new GameEngine({ rules: pushEveryTurn, seed: SEED });
    rewound.drop(0);
    rewound.commitRewind();
    rewound.drop(5);

    const control = new GameEngine({ rules: pushEveryTurn, seed: SEED });
    control.drop(5);

    const rewoundSave = stableSave(rewound);
    const controlSave = stableSave(control);
    expect(rewoundSave.generation).toEqual(controlSave.generation);
  });

  test('a rejected drop neither creates nor replaces a checkpoint', () => {
    const engine = new GameEngine({ rules: PARADOX_RULES, seed: SEED });
    expect(engine.drop(-1)).toMatchObject({ accepted: false, reason: 'invalid-column' });
    expect(engine.canRewind()).toBe(false);

    engine.drop(1);
    const preview = engine.previewRewind();
    expect(engine.drop(99)).toMatchObject({ accepted: false, reason: 'invalid-column' });
    expect(engine.previewRewind()).toEqual(preview);
  });

  test('defaults to the newest checkpoint when no depth is supplied', () => {
    const engine = new GameEngine({ rules: PARADOX_RULES, seed: SEED });
    engine.drop(0);
    const afterFirstTurn = stableSave(engine);

    engine.drop(1);
    expect(engine.commitRewind()).not.toBeNull();

    const restored = stableSave(engine);
    expect(restored.state).toMatchObject({ ...afterFirstTurn.state, board: expect.any(Array) });
    expect(restored.generation).toEqual(afterFirstTurn.generation);
    expect(restored.paradox).toEqual({ instability: 1 });
    expect(engine.state.dropCount).toBe(1);
  });

  test('previews and restores any turn in the five-turn rolling window', () => {
    const engine = new GameEngine({ rules: PARADOX_RULES, seed: SEED });
    const initial = stableSave(engine);
    engine.drop(0);
    const afterOne = stableSave(engine);
    engine.drop(1);
    engine.drop(2);

    expect(engine.previewRewind(1)).toMatchObject({
      dropCount: 2, turnsRewound: 1, historyAvailable: 3,
      instabilityBefore: 0, instabilityAfter: 1,
      turnCostBefore: 1, turnCostAfter: 1,
    });
    expect(engine.previewRewind(3)).toMatchObject({
      dropCount: 0, turnsRewound: 3, historyAvailable: 3,
      instabilityBefore: 0, instabilityAfter: 3,
      turnCostBefore: 1, turnCostAfter: 2,
    });
    expect(engine.previewRewind(4)).toBeNull();

    const rewind = engine.commitRewind(2);
    expect(rewind).toMatchObject({ turnsRewound: 2, instabilityAfter: 2 });
    const restored = stableSave(engine);
    expect(restored.state).toMatchObject({ ...afterOne.state, board: expect.any(Array) });
    expect(restored.generation).toEqual(afterOne.generation);
    expect(restored.state).not.toEqual(initial.state);
    expect(restored.paradox).toEqual({ instability: 2 });
    expect(engine.canRewind()).toBe(false);
  });

  test('caps retained history at the configured depth', () => {
    const engine = new GameEngine({ rules: PARADOX_RULES, seed: SEED });
    for (let turn = 0; turn < 6; turn++) {
      expect(engine.drop(turn).accepted).toBe(true);
    }

    expect(engine.previewRewind(5)).toMatchObject({
      dropCount: 1, turnsRewound: 5, historyAvailable: 5,
    });
    expect(engine.canRewind(6)).toBe(false);
  });

  test('farther rewinds add one instability and one fracture target per erased turn', () => {
    const board = makeEmptyBoard();
    for (const [row, col] of [[6, 0], [5, 2], [6, 2], [4, 4], [6, 6]] as const) {
      placeDisc(board, row, col, makeDisc(7, DiscKind.Numbered));
    }
    const engine = new GameEngine({ rules: PARADOX_RULES, seed: SEED, board });
    engine.drop(1);
    engine.drop(3);
    engine.drop(5);

    expect(engine.previewRewind(1)).toMatchObject({
      instabilityAfter: 1,
      fractures: [expect.objectContaining({ resultingKind: DiscKind.SingleCracked })],
    });
    const deep = engine.previewRewind(3)!;
    expect(deep.instabilityAfter).toBe(3);
    expect(deep.fractures).toHaveLength(3);
    expect(deep.fractures.every(target => target.resultingKind === DiscKind.DoubleCracked)).toBe(true);
  });

  test('materializes erased discs when the restored board lacks enough fracture targets', () => {
    const board = makeEmptyBoard();
    placeDisc(board, 6, 0, makeDisc(7, DiscKind.Numbered));
    const engine = new GameEngine({ rules: PARADOX_RULES, seed: SEED, board });
    engine.drop(2);
    engine.drop(4);

    const preview = engine.previewRewind(2)!;

    expect(preview.fractures).toHaveLength(2);
    expect(preview.fractures.filter(target => target.materialized)).toHaveLength(1);
    expect(preview.fractures.reduce(
      (total, target) => total + target.instabilityAdded,
      0,
    )).toBe(2);
    const remnantTarget = preview.fractures.find(target => target.materialized)!;
    expect(preview.board[remnantTarget.position.row]![remnantTarget.position.col])
      .toMatchObject({ value: remnantTarget.discValue, kind: DiscKind.Numbered });

    engine.commitRewind(2);
    const temporalDebt = engine.state.board.flat().reduce(
      (total, disc) => total + (disc?.temporalFracture?.instabilityDebt ?? 0),
      0,
    );
    expect(temporalDebt).toBe(2);
    expect(engine.state.paradox!.instability).toBe(2);
  });

  test.each([
    { instability: 0, cost: 1 },
    { instability: 3, cost: 2 },
    { instability: 6, cost: 3 },
    { instability: 12, cost: 3 },
  ])('instability $instability consumes $cost turn pips per move', ({ instability, cost }) => {
    const engine = new GameEngine({ rules: PARADOX_RULES, seed: SEED });
    engine.state.paradox!.instability = instability;
    const before = engine.state.turnsRemaining;

    expect(engine.drop(0).accepted).toBe(true);

    expect(engine.state.turnsRemaining).toBe(before - cost);
  });

  test('accelerated pressure triggers the existing level push when it exhausts the clock', () => {
    const engine = new GameEngine({ rules: PARADOX_RULES, seed: SEED });
    engine.state.paradox!.instability = 3;
    engine.state.turnsRemaining = 2;

    const turn = engine.drop(0);

    expect(turn.steps.some(step => step.kind === StepKind.Push)).toBe(true);
    expect(engine.state.level).toBe(2);
  });

  test('animation phases temporarily suppress an otherwise valid checkpoint', () => {
    const engine = new GameEngine({ rules: PARADOX_RULES, seed: SEED });
    engine.drop(0);
    engine.state.phase = GamePhase.Animating;
    expect(engine.canRewind()).toBe(false);
    expect(engine.previewRewind()).toBeNull();

    engine.state.phase = GamePhase.WaitingForDrop;
    expect(engine.canRewind()).toBe(true);
  });

  test('a fatal turn remains rewindable and restores a playable phase', () => {
    const fatalMode = testMode({
      id: 'paradox-fatal-test',
      clearing: {
        ...PARADOX_RULES.clearing,
        isClearable: () => false,
      },
    }, PARADOX_RULES);
    const almostFull = makeEmptyBoard();
    for (let row = 0; row < almostFull.length; row++) {
      for (let col = 0; col < almostFull[row]!.length; col++) {
        if (row !== 0 || col !== 0) {
          placeDisc(almostFull, row, col, makeDisc(7, DiscKind.DoubleCracked));
        }
      }
    }
    const engine = new GameEngine({ rules: fatalMode, seed: SEED, board: almostFull });

    const turn = engine.drop(0);
    expect(turn).toMatchObject({ accepted: true, gameOver: true });
    expect(engine.state.phase).toBe(GamePhase.GameOver);
    expect(engine.previewRewind()?.rescuesGameOver).toBe(true);

    engine.commitRewind();
    expect(engine.state.phase).toBe(GamePhase.WaitingForDrop);
    expect(engine.state.dropCount).toBe(0);
  });

  test('modes without the capability and injected generation do not capture rewind state', () => {
    const classic = new GameEngine({ rules: CLASSIC_RULES, seed: SEED });
    classic.drop(0);
    expect(classic.canRewind()).toBe(false);

    const injected = new GameEngine({
      rules: PARADOX_RULES,
      discFactory: () => makeDisc(7, DiscKind.Numbered),
    });
    injected.drop(0);
    expect(injected.canRewind()).toBe(false);
    expect(injected.previewRewind()).toBeNull();
  });

  test('restart, reconfigure, and scripted state clear checkpoints while save loading restores one', () => {
    const engine = new GameEngine({ rules: PARADOX_RULES, seed: SEED });
    engine.drop(0);
    expect(engine.canRewind()).toBe(true);
    engine.restart();
    expect(engine.canRewind()).toBe(false);

    engine.drop(0);
    engine.reconfigure(PARADOX_RULES, SEED);
    expect(engine.canRewind()).toBe(false);

    engine.drop(0);
    const save = stableSave(engine);
    expect(engine.canRewind()).toBe(true);
    engine.loadSave(save, PARADOX_RULES);
    expect(engine.canRewind()).toBe(true);
    expect(engine.previewRewind()).toEqual(expect.objectContaining({
      anchor: save.paradox!.rewinds!.at(-1)!.anchor,
    }));

    engine.drop(0);
    const board = makeEmptyBoard();
    placeDisc(board, 6, 3, makeDisc(4, DiscKind.Numbered));
    engine.loadScriptedState({
      rules: PARADOX_RULES,
      board,
      currentDisc: makeDisc(2, DiscKind.Numbered),
    });
    expect(engine.canRewind()).toBe(false);
  });

  test('fractures deterministic targets at each instability tier', () => {
    const makeBoard = () => {
      const board = makeEmptyBoard();
      placeDisc(board, 6, 0, makeDisc(7, DiscKind.Numbered));
      placeDisc(board, 6, 3, makeDisc(7, DiscKind.Numbered));
      placeDisc(board, 5, 5, makeDisc(7, DiscKind.Numbered));
      return board;
    };

    for (const scenario of [
      { before: 0, kind: DiscKind.SingleCracked, count: 1 },
      { before: 2, kind: DiscKind.DoubleCracked, count: 1 },
      { before: 4, kind: DiscKind.DoubleCracked, count: 1 },
    ] as const) {
      const engine = new GameEngine({ rules: PARADOX_RULES, seed: SEED, board: makeBoard() });
      engine.state.paradox!.instability = scenario.before;
      const turn = engine.drop(6);
      expect(turn.accepted).toBe(true);
      const preview = engine.previewRewind()!;
      expect(preview.instabilityAfter).toBe(scenario.before + 1);
      expect(preview.fractures).toHaveLength(scenario.count);
      expect(preview.fractures.every(target => target.resultingKind === scenario.kind)).toBe(true);
      expect(preview.fractures.reduce((total, target) => total + target.instabilityAdded, 0)).toBe(1);
      expect(preview.fractures[0]!.position).toEqual({ row: 5, col: 5 });
      expect(preview.fractures[0]).toMatchObject({ discValue: 7 });
      expect(preview.board[5]![5]).toMatchObject({ kind: DiscKind.Numbered, value: 7 });

      engine.commitRewind();
      for (const target of preview.fractures) {
        expect(engine.state.board[target.position.row]![target.position.col]).toMatchObject({
          kind: scenario.kind,
          temporalFracture: {
            createdAtInstability: scenario.before + 1,
            instabilityDebt: 1,
          },
        });
      }
    }
  });

  test('fully repairing a temporal fracture lowers instability by one', () => {
    const board = makeEmptyBoard();
    const temporal = makeDisc(7, DiscKind.SingleCracked);
    temporal.temporalFracture = { createdAtInstability: 3, instabilityDebt: 1 };
    placeDisc(board, 6, 0, temporal);
    placeDisc(board, 6, 1, makeDisc(3, DiscKind.Numbered));
    const engine = new GameEngine({
      rules: PARADOX_RULES,
      board,
      discFactory: () => makeDisc(3, DiscKind.Numbered),
    });
    engine.state.paradox!.instability = 3;

    const turn = engine.drop(2);

    expect(turn.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: StepKind.Reveal,
        temporalRepairs: [{ row: 6, col: 0 }],
        instabilityRecovered: 1,
      }),
    ]));
    expect(engine.state.paradox!.instability).toBe(2);
    expect(engine.state.board[6]![0]).toMatchObject({ kind: DiscKind.Numbered });
    expect(engine.state.board[6]![0]).not.toHaveProperty('temporalFracture');
  });

  test('repairing a stacked temporal fracture recovers all debt it carries', () => {
    const board = makeEmptyBoard();
    const temporal = makeDisc(7, DiscKind.SingleCracked);
    temporal.temporalFracture = { createdAtInstability: 3, instabilityDebt: 3 };
    placeDisc(board, 6, 0, temporal);
    placeDisc(board, 6, 1, makeDisc(3, DiscKind.Numbered));
    const engine = new GameEngine({
      rules: PARADOX_RULES,
      board,
      discFactory: () => makeDisc(3, DiscKind.Numbered),
    });
    engine.state.paradox!.instability = 3;

    const turn = engine.drop(2);

    expect(turn.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: StepKind.Reveal, instabilityRecovered: 3 }),
    ]));
    expect(engine.state.paradox!.instability).toBe(0);
  });

  test('an ordinary clear does not recover instability without repairing a temporal fracture', () => {
    const engine = new GameEngine({
      rules: PARADOX_RULES,
      discFactory: () => makeDisc(1, DiscKind.Numbered),
    });
    engine.state.paradox!.instability = 3;

    const turn = engine.drop(2);

    expect(turn.steps.some(step => step.kind === StepKind.Clear)).toBe(true);
    expect(engine.state.paradox!.instability).toBe(3);
  });

  test('loading an old save materializes repair debt for orphaned instability', () => {
    const source = new GameEngine({ rules: PARADOX_RULES, seed: SEED });
    const legacy = source.exportSave({ savedAt: 0 });
    legacy.paradox!.instability = 2;
    const restored = new GameEngine({ rules: PARADOX_RULES, seed: 1 });

    restored.loadSave(legacy, PARADOX_RULES);

    const temporalDiscs = restored.state.board.flat().filter(disc => disc?.temporalFracture);
    expect(temporalDiscs).toHaveLength(2);
    expect(temporalDiscs.reduce(
      (total, disc) => total + (disc?.temporalFracture?.instabilityDebt ?? 0),
      0,
    )).toBe(2);
    expect(restored.state.paradox!.instability).toBe(2);
  });

  test('loading a saturated board stacks orphaned debt instead of leaving instability stuck', () => {
    const source = new GameEngine({ rules: PARADOX_RULES, seed: SEED });
    const legacy = source.exportSave({ savedAt: 0 });
    legacy.paradox!.instability = 50;
    legacy.state.board = legacy.state.board.map((row, rowIndex) => row.map((_cell, colIndex) => (
      rowIndex === 0 && colIndex === 0
        ? null
        : {
            value: 7,
            kind: DiscKind.DoubleCracked,
            temporalFracture: { createdAtInstability: 48, instabilityDebt: 1 },
          }
    )));
    const restored = new GameEngine({ rules: PARADOX_RULES, seed: 1 });

    restored.loadSave(legacy, PARADOX_RULES);

    const temporalDiscs = restored.state.board.flat().filter(disc => disc?.temporalFracture);
    expect(restored.state.board.flat().filter(disc => disc === null)).toHaveLength(1);
    expect(temporalDiscs.reduce(
      (total, disc) => total + (disc?.temporalFracture?.instabilityDebt ?? 0),
      0,
    )).toBe(50);
    expect(Math.max(...temporalDiscs.map(
      disc => disc?.temporalFracture?.instabilityDebt ?? 0,
    ))).toBe(3);
  });

  test('save loading restores exact rewind history and controller session metadata', () => {
    const source = new GameEngine({ rules: PARADOX_RULES, seed: SEED });
    source.drop(4);
    source.drop(5);
    source.drop(6);
    const save = source.exportSave({ longestStreak: 5, rewindLongestStreaks: [1, 2, 3], savedAt: 10 });
    const restored = new GameEngine({ rules: PARADOX_RULES, seed: 1 });

    const loaded = restored.loadSave(save, PARADOX_RULES);

    expect(loaded.paradox!.rewinds!.map(rewind => rewind.session.longestStreak)).toEqual([1, 2, 3]);
    expect(restored.previewRewind(3)).toEqual(source.previewRewind(3));
    restored.commitRewind(3);
    source.commitRewind(3);
    expect(restored.exportSave({ savedAt: 20 })).toEqual(source.exportSave({ savedAt: 20 }));
  });
});
