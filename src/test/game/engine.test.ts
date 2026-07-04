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
    expect(result.scoreAwarded).toBe(7);
    expect(engine.state.score).toBe(7);
    expect(engine.state.board[5]![2]).toBeNull();
  });

  test('rejects invalid columns without changing turn state', () => {
    const engine = new GameEngine({ discFactory: numberedFactory(7, 6, 5) });

    const result = engine.drop(7);

    expect(result).toMatchObject({ accepted: false, reason: 'invalid-column', gameOver: false });
    expect(engine.state.dropCount).toBe(0);
    expect(engine.state.board).toEqual(makeEmptyBoard());
  });

  test('a drop into a full column ends the game without consuming the disc', () => {
    const board = makeEmptyBoard();
    for (let row = 0; row < 7; row++) {
      placeDisc(board, row, 1, makeDisc(7, DiscKind.DoubleCracked));
    }
    const engine = new GameEngine({ board, discFactory: numberedFactory(4, 5, 6) });
    const currentId = engine.state.currentDisc.id;

    const result = engine.drop(1);

    expect(result).toMatchObject({ accepted: false, reason: 'full-column', gameOver: true });
    expect(engine.state.phase).toBe(GamePhase.GameOver);
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
    expect(engine.state.score).toBe(0);
    expect(engine.state.board[6]![0]).not.toBeNull();
    expect(engine.state.board[6]![1]).not.toBeNull();
  });

  test('a game-ending drop freezes the level and turn budget instead of rolling over', () => {
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

    expect(result.gameOver).toBe(true);
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
