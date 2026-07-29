import { describe, expect, test } from 'vitest';
import { applyStepToVisualBoard } from '../../app/visual-board.js';
import { CLASSIC_RULES } from '../../game/modes/index.js';
import { GameEngine } from '../../game/engine.js';
import type { TurnResult } from '../../game/engine.js';
import { GamePhase } from '../../game/state.js';
import { deepCloneBoard, applyDirectionalGravity, makeEmptyBoard, placeDisc } from '../../game/board.js';
import type { GravityDirection } from '../../game/board.js';
import { StepKind } from '../../game/events.js';
import { makeDisc } from '../../game/disc.js';
import { DiscKind } from '../../game/model.js';

describe('visual board playback', () => {
  test('clears the source cell for same-row movement', () => {
    const disc = makeDisc(4, DiscKind.Numbered);
    const board = [
      [null, disc, null],
      [null, null, null],
      [null, null, null],
    ];

    applyStepToVisualBoard(board, {
      kind: StepKind.Fall,
      moves: [{ from: { row: 0, col: 1 }, to: { row: 0, col: 2 }, disc }],
    });

    expect(board[0]![1]).toBeNull();
    expect(board[0]![2]).toBe(disc);
  });

  // Regression: a single Fall step's moves can chain — one disc's `to` is
  // another disc's `from` (e.g. the disc above falls into the cell the disc
  // below is simultaneously vacating). Applying moves one at a time used to
  // overwrite the second disc's source cell before ever reading it: it
  // vanished, and the first disc's data got duplicated onto its cell —
  // visible in gravity mode as discs disappearing/reappearing on a tilt that
  // rearranges more than one disc along the same ray at once.
  test('applies a chained Fall step (one move\'s "to" is another\'s "from") without losing a disc', () => {
    const leading = makeDisc(1, DiscKind.Numbered);
    const trailing = makeDisc(2, DiscKind.Numbered);
    const board = [
      [null, leading, null],
      [null, trailing, null],
      [null, null, null],
    ];

    applyStepToVisualBoard(board, {
      kind: StepKind.Fall,
      moves: [
        { from: { row: 0, col: 1 }, to: { row: 1, col: 1 }, disc: leading },
        { from: { row: 1, col: 1 }, to: { row: 2, col: 1 }, disc: trailing },
      ],
    });

    expect(board[0]![1]).toBeNull();
    expect(board[1]![1]).toBe(leading);
    expect(board[2]![1]).toBe(trailing);
  });

  test.each<GravityDirection>(['down', 'up', 'left', 'right'])(
    'replaying a %s FallStep reproduces the directly-computed board',
    (direction) => {
      const board = makeEmptyBoard();
      placeDisc(board, 1, 1, makeDisc(1, DiscKind.Numbered));
      placeDisc(board, 3, 1, makeDisc(2, DiscKind.Numbered));
      placeDisc(board, 4, 4, makeDisc(3, DiscKind.Numbered));
      placeDisc(board, 5, 2, makeDisc(4, DiscKind.Numbered));

      const replay = deepCloneBoard(board);
      const step = applyDirectionalGravity(board, direction);
      applyStepToVisualBoard(replay, step);

      expect(replay).toEqual(board);
    }
  );

  test('replays step logs back to the engine board across several seeded runs', () => {
    const seenKinds = new Set<StepKind>();
    const seeds = [1, 7, 13, 21, 34, 55];

    for (const seed of seeds) {
      const engine = new GameEngine({ rules: CLASSIC_RULES, seed });

      for (let turn = 0; turn < 60 && engine.state.phase !== GamePhase.GameOver; turn++) {
        const startCol = (seed + turn) % CLASSIC_RULES.board.cols;
        let result: TurnResult | null = null;

        for (let offset = 0; offset < CLASSIC_RULES.board.cols; offset++) {
          const col = (startCol + offset) % CLASSIC_RULES.board.cols;
          const attempt = engine.drop(col);
          if (attempt.accepted || attempt.gameOver) {
            result = attempt;
            break;
          }
        }

        if (!result) throw new Error('expected a drop result');
        if (!result.accepted) {
          expect(result.gameOver).toBe(true);
          break;
        }

        const replay = deepCloneBoard(result.boardBefore);
        for (const step of result.steps) {
          seenKinds.add(step.kind);
          applyStepToVisualBoard(replay, step);
        }

        expect(replay).toEqual(engine.state.board);

        if (result.gameOver) break;
      }
    }

    expect(Array.from(seenKinds).sort()).toEqual([
      StepKind.Bonus,
      StepKind.Clear,
      StepKind.Drop,
      StepKind.Fall,
      StepKind.Push,
      StepKind.Reveal,
    ].sort());
  });

  // Push steps enter new discs from step.edge (the edge gravity currently pulls
  // toward) and shift the rest of the board toward the opposite edge, which
  // drops whatever was sitting at that opposite edge. Each case below hand-
  // constructs the step and checks the shift direction, the insertion edge,
  // and the drop edge directly, rather than only observing Push indirectly
  // through an engine replay.
  test('applies a bottom-edge Push: rows shift up, new discs enter at the last row', () => {
    const a = makeDisc(1, DiscKind.Numbered);
    const b = makeDisc(2, DiscKind.Numbered);
    const c = makeDisc(3, DiscKind.Numbered);
    const d = makeDisc(4, DiscKind.Numbered);
    const e = makeDisc(5, DiscKind.Numbered);
    const f = makeDisc(6, DiscKind.Numbered);
    const n0 = makeDisc(7, DiscKind.Numbered);
    const n1 = makeDisc(8, DiscKind.Numbered);
    const board = [
      [a, b],
      [c, d],
      [e, f],
    ];

    applyStepToVisualBoard(board, {
      kind: StepKind.Push,
      edge: 'bottom',
      newDiscs: [n0, n1],
    });

    expect(board).toEqual([
      [c, d],
      [e, f],
      [n0, n1],
    ]);
  });

  test('applies a top-edge Push: rows shift down, new discs enter at row 0', () => {
    const a = makeDisc(1, DiscKind.Numbered);
    const b = makeDisc(2, DiscKind.Numbered);
    const c = makeDisc(3, DiscKind.Numbered);
    const d = makeDisc(4, DiscKind.Numbered);
    const e = makeDisc(5, DiscKind.Numbered);
    const f = makeDisc(6, DiscKind.Numbered);
    const n0 = makeDisc(7, DiscKind.Numbered);
    const n1 = makeDisc(8, DiscKind.Numbered);
    const board = [
      [a, b],
      [c, d],
      [e, f],
    ];

    applyStepToVisualBoard(board, {
      kind: StepKind.Push,
      edge: 'top',
      newDiscs: [n0, n1],
    });

    expect(board).toEqual([
      [n0, n1],
      [a, b],
      [c, d],
    ]);
  });

  test('applies a right-edge Push: columns shift left per row, new discs enter at the last column', () => {
    const a = makeDisc(1, DiscKind.Numbered);
    const b = makeDisc(2, DiscKind.Numbered);
    const c = makeDisc(3, DiscKind.Numbered);
    const d = makeDisc(4, DiscKind.Numbered);
    const e = makeDisc(5, DiscKind.Numbered);
    const f = makeDisc(6, DiscKind.Numbered);
    const n0 = makeDisc(7, DiscKind.Numbered);
    const n1 = makeDisc(8, DiscKind.Numbered);
    const board = [
      [a, b, c],
      [d, e, f],
    ];

    applyStepToVisualBoard(board, {
      kind: StepKind.Push,
      edge: 'right',
      newDiscs: [n0, n1],
    });

    expect(board).toEqual([
      [b, c, n0],
      [e, f, n1],
    ]);
  });

  test('applies a left-edge Push: columns shift right per row, new discs enter at column 0', () => {
    const a = makeDisc(1, DiscKind.Numbered);
    const b = makeDisc(2, DiscKind.Numbered);
    const c = makeDisc(3, DiscKind.Numbered);
    const d = makeDisc(4, DiscKind.Numbered);
    const e = makeDisc(5, DiscKind.Numbered);
    const f = makeDisc(6, DiscKind.Numbered);
    const n0 = makeDisc(7, DiscKind.Numbered);
    const n1 = makeDisc(8, DiscKind.Numbered);
    const board = [
      [a, b, c],
      [d, e, f],
    ];

    applyStepToVisualBoard(board, {
      kind: StepKind.Push,
      edge: 'left',
      newDiscs: [n0, n1],
    });

    expect(board).toEqual([
      [n0, a, b],
      [n1, d, e],
    ]);
  });
});
