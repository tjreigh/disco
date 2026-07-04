import { describe, expect, test } from 'vitest';
import { GameEngine } from '../../game/engine.js';
import { makeEmptyBoard, placeDisc } from '../../game/board.js';
import { makeDisc } from '../../game/disc.js';
import { DiscKind } from '../../game/model.js';
import { GamePhase } from '../../game/state.js';
import { StepKind } from '../../game/events.js';
import type { GameModeConfig } from '../../game/modes/mode.js';
import { CLASSIC_MODE } from '../../game/modes/index.js';

function numberedFactory(...values: number[]): () => ReturnType<typeof makeDisc> {
  let index = 0;
  return () => makeDisc(values[index++ % values.length]!, DiscKind.Numbered);
}

describe('GameEngine', () => {
  test('an explicit seed reproduces the built-in playable sequence', () => {
    const startingBoard = makeEmptyBoard();
    placeDisc(startingBoard, 6, 6, makeDisc(7, DiscKind.DoubleCracked));
    const first = new GameEngine({ seed: 0x12345678, board: startingBoard });
    const second = new GameEngine({ seed: 0x12345678, board: startingBoard });
    const signature = (engine: GameEngine) => ({
      current: { value: engine.state.currentDisc.value, kind: engine.state.currentDisc.kind },
      next: { value: engine.state.nextDisc.value, kind: engine.state.nextDisc.kind },
    });

    expect(first.state.generationSeed).toBe(0x12345678);
    expect(signature(first)).toEqual(signature(second));
    for (let turn = 0; turn < 20; turn++) {
      expect(signature(first)).toEqual(signature(second));
      expect(first.drop(turn % 7).steps.map(step => step.kind)).toEqual(
        second.drop(turn % 7).steps.map(step => step.kind),
      );
    }
  });

  test('uses an injected starting board when prefilling the built-in queue', () => {
    const highBoard = makeEmptyBoard();
    for (let row = 1; row < highBoard.length; row++) {
      placeDisc(highBoard, row, 6, makeDisc(7, DiscKind.DoubleCracked));
    }

    const empty = new GameEngine({ seed: 1 });
    const high = new GameEngine({ seed: 1, board: highBoard });
    const values = (engine: GameEngine) => [engine.state.currentDisc.value, engine.state.nextDisc.value];

    expect(values(empty)).toEqual([6, 7]);
    expect(values(high)).toEqual([5, 6]);
  });

  test('rejected drops do not advance built-in generation', () => {
    const startingBoard = makeEmptyBoard();
    for (let row = 0; row < startingBoard.length; row++) {
      placeDisc(startingBoard, row, 0, makeDisc(7, DiscKind.DoubleCracked));
    }
    const uninterrupted = new GameEngine({ seed: 0xabcdef01, board: startingBoard });
    const withRejections = new GameEngine({ seed: 0xabcdef01, board: startingBoard });
    const signature = (engine: GameEngine) => [
      engine.state.currentDisc.value,
      engine.state.currentDisc.kind,
      engine.state.nextDisc.value,
      engine.state.nextDisc.kind,
    ];

    expect(withRejections.drop(-1)).toMatchObject({ accepted: false, reason: 'invalid-column' });
    expect(withRejections.drop(0)).toMatchObject({ accepted: false, reason: 'full-column' });
    expect(signature(withRejections)).toEqual(signature(uninterrupted));

    for (const col of [1, 2, 3, 4]) {
      expect(withRejections.drop(col).accepted).toBe(true);
      expect(uninterrupted.drop(col).accepted).toBe(true);
      expect(signature(withRejections)).toEqual(signature(uninterrupted));
    }
  });

  test('plays a complete turn without browser dependencies', () => {
    const engine = new GameEngine({ discFactory: numberedFactory(7, 6, 5, 4) });

    const result = engine.drop(3);

    expect(result.accepted).toBe(true);
    expect(result.steps[0]).toMatchObject({ kind: StepKind.Drop, col: 3, toLandRow: 6 });
    expect(result.boardBefore[6]![3]).toBeNull();
    expect(engine.state.board[6]![3]).toMatchObject({ value: 7, kind: DiscKind.Numbered });
    expect(engine.state.currentDisc.value).toBe(6);
    expect(engine.state.nextDisc.value).toBe(5);
    expect(engine.state.dropCount).toBe(1);
    expect(engine.state.phase).toBe(GamePhase.WaitingForDrop);
  });

  test('integrates clears and scoring into the turn result', () => {
    const board = makeEmptyBoard();
    placeDisc(board, 6, 0, makeDisc(5, DiscKind.Numbered));
    placeDisc(board, 6, 1, makeDisc(4, DiscKind.Numbered));
    const engine = new GameEngine({ board, discFactory: numberedFactory(3, 7, 7, 7) });

    const result = engine.drop(2);

    expect(result.scoreAwarded).toBe(7);
    expect(engine.state.score).toBe(7);
    expect(result.steps).toContainEqual(expect.objectContaining({
      kind: StepKind.Clear,
      pointsAwarded: 7,
    }));
    expect(result.trace.scans[0]?.checks).toContainEqual(expect.objectContaining({
      value: 3,
      rowCount: 3,
      clearsByRow: true,
    }));
    expect(result.trace.frames.map(frame => frame.label)).toEqual([
      expect.stringMatching(/^Drop /),
      expect.stringMatching(/^Clear /),
    ]);
  });

  test('awards 70,000 points when a clear empties the board', () => {
    const engine = new GameEngine({ discFactory: numberedFactory(1, 7, 7, 7) });

    const result = engine.drop(3);

    expect(result.scoreAwarded).toBe(70_007);
    expect(engine.state.score).toBe(70_007);
    expect(result.steps).toContainEqual({
      kind: StepKind.Bonus,
      bonusKind: 'board-clear',
      pointsAwarded: 70_000,
    });
  });

  test('a push occurs when the level\'s turn budget is exhausted', () => {
    const oneTurnMode: GameModeConfig = {
      ...CLASSIC_MODE,
      id: 'one-turn-test-mode',
      initialTurnsPerLevel: 1,
      turnsPerLevelStep: 1,
      minTurnsPerLevel: 1,
    };
    const engine = new GameEngine({
      mode: oneTurnMode,
      discFactory: numberedFactory(7, 6, 5, 4),
      crackedDiscFactory: () => makeDisc(2, DiscKind.DoubleCracked),
    });
    const previewedNext = engine.state.nextDisc;

    const result = engine.drop(0);
    const push = result.steps.find(step => step.kind === StepKind.Push);

    expect(push?.kind).toBe(StepKind.Push);
    if (push?.kind === StepKind.Push) {
      expect(push.newRow).toHaveLength(7);
      expect(push.newRow.every(d => d.value === 2 && d.kind === DiscKind.DoubleCracked)).toBe(true);
    }
    expect(engine.state.board[6]!.every(Boolean)).toBe(true);
    expect(engine.state.level).toBe(2);
    expect(engine.state.currentDisc).toBe(previewedNext);
    expect(result.scoreAwarded).toBe(7_000);
    expect(result.steps).toContainEqual({
      kind: StepKind.Bonus,
      bonusKind: 'level',
      pointsAwarded: 7_000,
    });
  });

  test('resolves a match created by a push during the same turn', () => {
    const board = makeEmptyBoard();
    // This 2 sits at the bottom row (contiguous column count 1) before the
    // turn. The push shifts it up to row 5 and inserts a fully-filled cracked
    // row at row 6 directly below it, raising its column count to 2 and
    // making it eligible.
    placeDisc(board, 6, 2, makeDisc(2, DiscKind.Numbered));
    const oneTurnMode: GameModeConfig = {
      ...CLASSIC_MODE,
      id: 'one-turn-test-mode-2',
      initialTurnsPerLevel: 1,
      turnsPerLevelStep: 1,
      minTurnsPerLevel: 1,
    };
    const engine = new GameEngine({
      board,
      mode: oneTurnMode,
      discFactory: numberedFactory(7, 6, 5, 4),
      crackedDiscFactory: () => makeDisc(7, DiscKind.DoubleCracked),
    });

    const result = engine.drop(0);
    const pushIndex = result.steps.findIndex(step => step.kind === StepKind.Push);
    const clearIndex = result.steps.findIndex((step, index) =>
      index > pushIndex && step.kind === StepKind.Clear
    );

    expect(pushIndex).toBeGreaterThanOrEqual(0);
    expect(clearIndex).toBeGreaterThan(pushIndex);
    expect(result.steps[clearIndex]).toMatchObject({
      kind: StepKind.Clear,
      cleared: [{ row: 5, col: 2 }],
    });
    expect(result.scoreAwarded).toBe(7_007);
    expect(engine.state.score).toBe(7_007);
    expect(engine.state.board[5]![2]).toBeNull();
  });

  test('rejects invalid columns without changing turn state', () => {
    const engine = new GameEngine({ discFactory: numberedFactory(7, 6, 5) });

    const result = engine.drop(7);

    expect(result).toMatchObject({ accepted: false, reason: 'invalid-column', gameOver: false });
    expect(engine.state.dropCount).toBe(0);
    expect(engine.state.board).toEqual(makeEmptyBoard());
  });

  test('a drop into a full column is rejected without ending the game or consuming the disc', () => {
    const board = makeEmptyBoard();
    for (let row = 0; row < 7; row++) {
      placeDisc(board, row, 1, makeDisc(7, DiscKind.DoubleCracked));
    }
    const engine = new GameEngine({ board, discFactory: numberedFactory(4, 5, 6) });
    const currentId = engine.state.currentDisc.id;

    const result = engine.drop(1);

    expect(result).toMatchObject({ accepted: false, reason: 'full-column', gameOver: false });
    expect(engine.state.phase).toBe(GamePhase.WaitingForDrop);
    expect(engine.state.currentDisc.id).toBe(currentId);
    expect(engine.state.dropCount).toBe(0);
  });

  test('a disc resting in the top row through normal stacking does not end the game', () => {
    const board = makeEmptyBoard();
    // Fill rows 1-6 of column 2 with non-matching cracked discs so nothing clears
    // once the drop lands at row 0 (cracked discs never clear directly).
    for (let row = 1; row < 7; row++) {
      placeDisc(board, row, 2, makeDisc(9, DiscKind.DoubleCracked));
    }
    // value 3 matches neither the row-0 run (1) nor the column run (7) after landing.
    const engine = new GameEngine({ board, discFactory: numberedFactory(3, 4, 5) });

    const result = engine.drop(2);

    expect(result.accepted).toBe(true);
    expect(result.gameOver).toBe(false);
    expect(engine.state.phase).not.toBe(GamePhase.GameOver);
    expect(engine.state.board[0]![2]).not.toBeNull();
  });

  test('restart resets all gameplay state and refills the queue', () => {
    const engine = new GameEngine({ discFactory: numberedFactory(7, 6, 5, 4, 3, 2, 1) });
    engine.drop(0);

    engine.restart();

    expect(engine.state).toMatchObject({
      phase: GamePhase.WaitingForDrop,
      score: 0,
      dropCount: 0,
      level: 1,
      turnsPerLevel: 30,
      turnsRemaining: 30,
      cursorCol: 3,
    });
    expect(engine.state.board).toEqual(makeEmptyBoard());
    expect(engine.state.currentDisc.value).toBe(3);
    expect(engine.state.nextDisc.value).toBe(2);
  });

  test('a non-default mode drives board size, cursor start, and push cadence', () => {
    const smallMode: GameModeConfig = {
      ...CLASSIC_MODE,
      id: 'small-test-mode',
      board: { cols: 3, rows: 3 },
      initialTurnsPerLevel: 2,
      turnsPerLevelStep: 1,
      minTurnsPerLevel: 1,
    };
    const engine = new GameEngine({ mode: smallMode, discFactory: numberedFactory(1, 1, 1, 1) });

    expect(engine.state.board.length).toBe(3);
    expect(engine.state.board[0]!.length).toBe(3);
    expect(engine.state.cursorCol).toBe(1); // floor(3 / 2)

    engine.drop(0);
    const result = engine.drop(1);
    const push = result.steps.find(step => step.kind === StepKind.Push);
    expect(push?.kind).toBe(StepKind.Push);
    if (push?.kind === StepKind.Push) expect(push.newRow).toHaveLength(3);
  });

  test('turn budget exhaustion advances the level and resets the budget without wiping board/score', () => {
    const smallBudgetMode: GameModeConfig = {
      ...CLASSIC_MODE,
      id: 'small-budget-test-mode',
      initialTurnsPerLevel: 2,
      turnsPerLevelStep: 1,
      minTurnsPerLevel: 1,
    };
    // value 7 never matches a run length of 1, so these drops don't clear.
    const engine = new GameEngine({ mode: smallBudgetMode, discFactory: numberedFactory(7, 7, 7, 7) });

    expect(engine.state.level).toBe(1);
    expect(engine.state.turnsPerLevel).toBe(2);
    expect(engine.state.turnsRemaining).toBe(2);

    engine.drop(0);
    expect(engine.state.level).toBe(1);
    expect(engine.state.turnsRemaining).toBe(1);

    engine.drop(1);

    expect(engine.state.level).toBe(2);
    expect(engine.state.turnsPerLevel).toBe(1); // turnsForLevel(mode, 2) = max(1, 2 - 1)
    expect(engine.state.turnsRemaining).toBe(1);
    expect(engine.state.score).toBe(7_000);
    expect(engine.state.board[6]![0]).not.toBeNull();
    expect(engine.state.board[6]![1]).not.toBeNull();
  });

  test('a rejected full-column drop leaves the level and turn budget unchanged', () => {
    const board = makeEmptyBoard();
    for (let row = 0; row < 7; row++) {
      placeDisc(board, row, 1, makeDisc(7, DiscKind.DoubleCracked));
    }
    const smallBudgetMode: GameModeConfig = {
      ...CLASSIC_MODE,
      id: 'small-budget-game-over-test-mode',
      initialTurnsPerLevel: 1,
      turnsPerLevelStep: 1,
      minTurnsPerLevel: 1,
    };
    const engine = new GameEngine({ mode: smallBudgetMode, board, discFactory: numberedFactory(4, 5, 6) });

    const result = engine.drop(1);

    expect(result).toMatchObject({ accepted: false, reason: 'full-column', gameOver: false });
    expect(engine.state.level).toBe(1);
    expect(engine.state.turnsRemaining).toBe(1);
  });

  test('reconfigure() switches modes without replacing the state object', () => {
    const engine = new GameEngine({ mode: CLASSIC_MODE });
    const stateRef = engine.state;

    const smallMode: GameModeConfig = { ...CLASSIC_MODE, id: 'small-test-mode', board: { cols: 3, rows: 3 } };
    engine.reconfigure(smallMode);

    expect(engine.state).toBe(stateRef); // same object reference, mutated in place
    expect(engine.state.board.length).toBe(3);
    expect(engine.state.phase).toBe(GamePhase.WaitingForDrop);
  });
});
