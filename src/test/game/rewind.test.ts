import { describe, expect, test } from 'vitest';
import { makeEmptyBoard, placeDisc } from '../../game/board.js';
import { makeDisc } from '../../game/disc.js';
import { GameEngine } from '../../game/engine.js';
import { StepKind } from '../../game/events.js';
import { DiscKind } from '../../game/model.js';
import { CLASSIC_MODE, PARADOX_MODE } from '../../game/modes/index.js';
import type { GameModeConfig } from '../../game/modes/mode.js';
import { GamePhase } from '../../game/state.js';

const SEED = 0x1357_2468;

function stableSave(engine: GameEngine) {
  return engine.exportSave({ savedAt: 0 });
}

describe('Paradox one-turn rewind foundation', () => {
  test('restores an exact pre-turn state in place and consumes the checkpoint', () => {
    const engine = new GameEngine({ mode: PARADOX_MODE, seed: SEED });
    const stateReference = engine.state;
    const before = stableSave(engine);

    const turn = engine.drop(2);
    expect(turn.accepted).toBe(true);
    expect(engine.canRewind()).toBe(true);

    const rewind = engine.commitRewind();

    expect(rewind).not.toBeNull();
    expect(engine.state).toBe(stateReference);
    const afterRewind = stableSave(engine);
    expect(afterRewind).toMatchObject({
      state: before.state,
      generation: before.generation,
      paradox: { instability: 1 },
    });
    expect(engine.canRewind()).toBe(false);
    expect(engine.previewRewind()).toBeNull();
    expect(engine.commitRewind()).toBeNull();
  });

  test('preview is pure, independent, and reports the erased drop anchor', () => {
    const engine = new GameEngine({ mode: PARADOX_MODE, seed: SEED });
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

  test('rewinds generator history and both random streams', () => {
    const pushEveryTurn: GameModeConfig = {
      ...PARADOX_MODE,
      id: 'paradox-push-every-turn-test',
      initialTurnsPerLevel: 1,
      turnsPerLevelStep: 0,
      minTurnsPerLevel: 1,
    };
    const rewound = new GameEngine({ mode: pushEveryTurn, seed: SEED });
    rewound.drop(0);
    rewound.commitRewind();
    rewound.drop(5);

    const control = new GameEngine({ mode: pushEveryTurn, seed: SEED });
    control.drop(5);

    const rewoundSave = stableSave(rewound);
    const controlSave = stableSave(control);
    expect(rewoundSave.state).toEqual(controlSave.state);
    expect(rewoundSave.generation).toEqual(controlSave.generation);
  });

  test('a rejected drop neither creates nor replaces a checkpoint', () => {
    const engine = new GameEngine({ mode: PARADOX_MODE, seed: SEED });
    expect(engine.drop(-1)).toMatchObject({ accepted: false, reason: 'invalid-column' });
    expect(engine.canRewind()).toBe(false);

    engine.drop(1);
    const preview = engine.previewRewind();
    expect(engine.drop(99)).toMatchObject({ accepted: false, reason: 'invalid-column' });
    expect(engine.previewRewind()).toEqual(preview);
  });

  test('a newer accepted turn replaces the older one-turn checkpoint', () => {
    const engine = new GameEngine({ mode: PARADOX_MODE, seed: SEED });
    engine.drop(0);
    const afterFirstTurn = stableSave(engine);

    engine.drop(1);
    expect(engine.commitRewind()).not.toBeNull();

    const restored = stableSave(engine);
    expect(restored.state).toEqual(afterFirstTurn.state);
    expect(restored.generation).toEqual(afterFirstTurn.generation);
    expect(restored.paradox).toEqual({ instability: 1 });
    expect(engine.state.dropCount).toBe(1);
  });

  test('animation phases temporarily suppress an otherwise valid checkpoint', () => {
    const engine = new GameEngine({ mode: PARADOX_MODE, seed: SEED });
    engine.drop(0);
    engine.state.phase = GamePhase.Animating;
    expect(engine.canRewind()).toBe(false);
    expect(engine.previewRewind()).toBeNull();

    engine.state.phase = GamePhase.WaitingForDrop;
    expect(engine.canRewind()).toBe(true);
  });

  test('a fatal turn remains rewindable and restores a playable phase', () => {
    const fatalMode: GameModeConfig = {
      ...PARADOX_MODE,
      id: 'paradox-fatal-test',
      isClearable: () => false,
    };
    const almostFull = makeEmptyBoard();
    for (let row = 0; row < almostFull.length; row++) {
      for (let col = 0; col < almostFull[row]!.length; col++) {
        if (row !== 0 || col !== 0) {
          placeDisc(almostFull, row, col, makeDisc(7, DiscKind.DoubleCracked));
        }
      }
    }
    const engine = new GameEngine({ mode: fatalMode, seed: SEED, board: almostFull });

    const turn = engine.drop(0);
    expect(turn).toMatchObject({ accepted: true, gameOver: true });
    expect(engine.state.phase).toBe(GamePhase.GameOver);
    expect(engine.previewRewind()?.rescuesGameOver).toBe(true);

    engine.commitRewind();
    expect(engine.state.phase).toBe(GamePhase.WaitingForDrop);
    expect(engine.state.dropCount).toBe(0);
  });

  test('modes without the capability and injected generation do not capture rewind state', () => {
    const classic = new GameEngine({ mode: CLASSIC_MODE, seed: SEED });
    classic.drop(0);
    expect(classic.canRewind()).toBe(false);

    const injected = new GameEngine({
      mode: PARADOX_MODE,
      discFactory: () => makeDisc(7, DiscKind.Numbered),
    });
    injected.drop(0);
    expect(injected.canRewind()).toBe(false);
    expect(injected.previewRewind()).toBeNull();
  });

  test('restart, reconfigure, and scripted state clear checkpoints while save loading restores one', () => {
    const engine = new GameEngine({ mode: PARADOX_MODE, seed: SEED });
    engine.drop(0);
    expect(engine.canRewind()).toBe(true);
    engine.restart();
    expect(engine.canRewind()).toBe(false);

    engine.drop(0);
    engine.reconfigure(PARADOX_MODE, SEED);
    expect(engine.canRewind()).toBe(false);

    engine.drop(0);
    const save = stableSave(engine);
    expect(engine.canRewind()).toBe(true);
    engine.loadSave(save, PARADOX_MODE);
    expect(engine.canRewind()).toBe(true);
    expect(engine.previewRewind()).toEqual(expect.objectContaining({
      anchor: save.paradox!.rewind!.anchor,
    }));

    engine.drop(0);
    const board = makeEmptyBoard();
    placeDisc(board, 6, 3, makeDisc(4, DiscKind.Numbered));
    engine.loadScriptedState({
      mode: PARADOX_MODE,
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
      { before: 4, kind: DiscKind.DoubleCracked, count: 2 },
    ] as const) {
      const engine = new GameEngine({ mode: PARADOX_MODE, seed: SEED, board: makeBoard() });
      engine.state.paradox!.instability = scenario.before;
      const turn = engine.drop(6);
      expect(turn.accepted).toBe(true);
      const preview = engine.previewRewind()!;
      expect(preview.instabilityAfter).toBe(scenario.before + 1);
      expect(preview.fractures).toHaveLength(scenario.count);
      expect(preview.fractures.every(target => target.resultingKind === scenario.kind)).toBe(true);
      expect(preview.fractures[0]!.position).toEqual({ row: 5, col: 5 });
      expect(preview.fractures[0]).toMatchObject({ discValue: 7 });
      expect(preview.board[5]![5]).toMatchObject({ kind: DiscKind.Numbered, value: 7 });

      engine.commitRewind();
      for (const target of preview.fractures) {
        expect(engine.state.board[target.position.row]![target.position.col]).toMatchObject({
          kind: scenario.kind,
          temporalFracture: { createdAtInstability: scenario.before + 1 },
        });
      }
    }
  });

  test('fully repairing a temporal fracture lowers instability by one', () => {
    const board = makeEmptyBoard();
    const temporal = makeDisc(7, DiscKind.SingleCracked);
    temporal.temporalFracture = { createdAtInstability: 3 };
    placeDisc(board, 6, 0, temporal);
    placeDisc(board, 6, 1, makeDisc(3, DiscKind.Numbered));
    const engine = new GameEngine({
      mode: PARADOX_MODE,
      board,
      discFactory: () => makeDisc(3, DiscKind.Numbered),
    });
    engine.state.paradox!.instability = 3;

    const turn = engine.drop(2);

    expect(turn.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: StepKind.Reveal, temporalRepairs: [{ row: 6, col: 0 }] }),
    ]));
    expect(engine.state.paradox!.instability).toBe(2);
    expect(engine.state.board[6]![0]).toMatchObject({ kind: DiscKind.Numbered });
    expect(engine.state.board[6]![0]).not.toHaveProperty('temporalFracture');
  });

  test('save loading restores the exact rewind checkpoint and controller session metadata', () => {
    const source = new GameEngine({ mode: PARADOX_MODE, seed: SEED });
    source.drop(4);
    const save = source.exportSave({ longestStreak: 5, rewindLongestStreak: 2, savedAt: 10 });
    const restored = new GameEngine({ mode: PARADOX_MODE, seed: 1 });

    const loaded = restored.loadSave(save, PARADOX_MODE);

    expect(loaded.paradox!.rewind!.session.longestStreak).toBe(2);
    expect(restored.previewRewind()).toEqual(source.previewRewind());
    restored.commitRewind();
    source.commitRewind();
    expect(restored.exportSave({ savedAt: 20 })).toEqual(source.exportSave({ savedAt: 20 }));
  });
});
