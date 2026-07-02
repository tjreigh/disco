import { describe, expect, test } from 'vitest';
import { GameEngine } from './engine.js';
import { makeEmptyBoard, placeDisc } from './board.js';
import { makeDisc } from './disc.js';
import { DiscKind, GamePhase, StepKind } from './types.js';

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

  test('uses an injected factory for a deterministic seventh-turn push', () => {
    const engine = new GameEngine({
      dropCount: 6,
      discFactory: numberedFactory(7, 6, 5, 4),
      crackedDiscFactory: () => makeDisc(2, DiscKind.DoubleCracked),
    });

    const result = engine.drop(0);
    const push = result.steps.find(step => step.kind === StepKind.Push);

    expect(push?.kind).toBe(StepKind.Push);
    if (push?.kind === StepKind.Push) {
      expect(push.newRow).toHaveLength(7);
      expect(push.newRow.every(d => d.value === 2 && d.kind === DiscKind.DoubleCracked)).toBe(true);
    }
    expect(engine.state.board[6]!.every(Boolean)).toBe(true);
  });

  test('resolves a match created by a push during the same turn', () => {
    const board = makeEmptyBoard();
    // This 2 has a column count of 1 before the turn. The push adds a cracked
    // disc below it, increasing the column count to 2 and making it eligible.
    placeDisc(board, 5, 2, makeDisc(2, DiscKind.Numbered));
    const engine = new GameEngine({
      board,
      dropCount: 6,
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
      cleared: [{ row: 4, col: 2 }],
    });
    expect(result.scoreAwarded).toBe(7);
    expect(engine.state.score).toBe(7);
    expect(engine.state.board[4]![2]).toBeNull();
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

  test('restart resets all gameplay state and refills the queue', () => {
    const engine = new GameEngine({ discFactory: numberedFactory(7, 6, 5, 4, 3, 2, 1) });
    engine.drop(0);

    engine.restart();

    expect(engine.state).toMatchObject({
      phase: GamePhase.WaitingForDrop,
      score: 0,
      dropCount: 0,
      level: 1,
      cursorCol: 3,
    });
    expect(engine.state.board).toEqual(makeEmptyBoard());
    expect(engine.state.currentDisc.value).toBe(3);
    expect(engine.state.nextDisc.value).toBe(2);
  });
});
