import { describe, test, expect } from 'vitest';
import {
  computeGravityVector, entryEdgeForAngle, isLaneFull,
  entryPositionForLane, offBoardEntryPosition, settleContinuous, gravityRunLengths,
} from '../../game/gravity.js';
import {
  makeEmptyBoard, placeDisc, applyDirectionalGravity, deepCloneBoard,
  countHorizontalRun, countVerticalRun,
} from '../../game/board.js';
import { makeDisc } from '../../game/disc.js';
import { DiscKind } from '../../game/model.js';

// ─── computeGravityVector ────────────────────────────────────────────────────

describe('computeGravityVector', () => {
  test('0deg = straight down', () => {
    expect(computeGravityVector(0)).toEqual({ gx: 0, gy: 1 });
  });

  test('90deg = straight right', () => {
    expect(computeGravityVector(90)).toEqual({ gx: 1, gy: 0 });
  });

  test('180deg = straight up', () => {
    expect(computeGravityVector(180)).toEqual({ gx: 0, gy: -1 });
  });

  test('270deg = straight left', () => {
    expect(computeGravityVector(270)).toEqual({ gx: -1, gy: 0 });
  });
});

// ─── entryEdgeForAngle ───────────────────────────────────────────────────────

describe('entryEdgeForAngle', () => {
  test('gravity down -> enters top', () => {
    expect(entryEdgeForAngle(0)).toBe('top');
  });

  test('gravity right -> enters left', () => {
    expect(entryEdgeForAngle(90)).toBe('left');
  });

  test('gravity up -> enters bottom', () => {
    expect(entryEdgeForAngle(180)).toBe('bottom');
  });

  test('gravity left -> enters right', () => {
    expect(entryEdgeForAngle(270)).toBe('right');
  });

  test('snaps to the nearest cardinal', () => {
    expect(entryEdgeForAngle(44)).toBe('top');
    expect(entryEdgeForAngle(46)).toBe('left');
  });

  test('wraps past 360', () => {
    expect(entryEdgeForAngle(361)).toBe('top');
    expect(entryEdgeForAngle(-1)).toBe('top');
  });
});

// ─── isLaneFull / entryPositionForLane / offBoardEntryPosition ──────────────

describe('lane/edge geometry helpers', () => {
  test('isLaneFull checks the correct cell per edge', () => {
    const board = makeEmptyBoard(5, 5);
    placeDisc(board, 0, 2, makeDisc(1, DiscKind.Numbered));
    placeDisc(board, 3, 4, makeDisc(1, DiscKind.Numbered));
    placeDisc(board, 4, 4, makeDisc(1, DiscKind.Numbered));
    placeDisc(board, 1, 0, makeDisc(1, DiscKind.Numbered));

    expect(isLaneFull(board, 2, 'top')).toBe(true);
    expect(isLaneFull(board, 3, 'top')).toBe(false);
    expect(isLaneFull(board, 3, 'right')).toBe(true);
    expect(isLaneFull(board, 4, 'bottom')).toBe(true);
    expect(isLaneFull(board, 1, 'left')).toBe(true);
    expect(isLaneFull(board, 2, 'left')).toBe(false);
  });

  test('entryPositionForLane places on the correct edge cell', () => {
    expect(entryPositionForLane('top', 2, 5, 5)).toEqual({ row: 0, col: 2 });
    expect(entryPositionForLane('bottom', 2, 5, 5)).toEqual({ row: 4, col: 2 });
    expect(entryPositionForLane('left', 2, 5, 5)).toEqual({ row: 2, col: 0 });
    expect(entryPositionForLane('right', 2, 5, 5)).toEqual({ row: 2, col: 4 });
  });

  test('offBoardEntryPosition is one cell beyond the edge', () => {
    expect(offBoardEntryPosition('top', 2, 5, 5)).toEqual({ row: -1, col: 2 });
    expect(offBoardEntryPosition('bottom', 2, 5, 5)).toEqual({ row: 5, col: 2 });
    expect(offBoardEntryPosition('left', 2, 5, 5)).toEqual({ row: 2, col: -1 });
    expect(offBoardEntryPosition('right', 2, 5, 5)).toEqual({ row: 2, col: 5 });
  });
});

// ─── settleContinuous ────────────────────────────────────────────────────────

describe('settleContinuous', () => {
  test('0deg matches applyDirectionalGravity down', () => {
    const a = makeEmptyBoard();
    const b = makeEmptyBoard();
    placeDisc(a, 0, 3, makeDisc(1, DiscKind.Numbered));
    placeDisc(a, 3, 3, makeDisc(2, DiscKind.Numbered));
    placeDisc(a, 5, 1, makeDisc(3, DiscKind.Numbered));
    for (let r = 0; r < a.length; r++) for (let c = 0; c < a[r]!.length; c++) {
      if (a[r]![c]) placeDisc(b, r, c, { ...a[r]![c]! });
    }

    applyDirectionalGravity(a, 'down');
    settleContinuous(b, 0);
    expect(b).toEqual(a);
  });

  test('90deg matches applyDirectionalGravity right', () => {
    const a = makeEmptyBoard();
    const b = makeEmptyBoard();
    placeDisc(a, 4, 2, makeDisc(1, DiscKind.Numbered));
    placeDisc(a, 4, 5, makeDisc(2, DiscKind.Numbered));
    for (let r = 0; r < a.length; r++) for (let c = 0; c < a[r]!.length; c++) {
      if (a[r]![c]) placeDisc(b, r, c, { ...a[r]![c]! });
    }

    applyDirectionalGravity(a, 'right');
    settleContinuous(b, 90);
    expect(b).toEqual(a);
  });

  test('180deg matches applyDirectionalGravity up', () => {
    const a = makeEmptyBoard();
    const b = makeEmptyBoard();
    placeDisc(a, 3, 3, makeDisc(1, DiscKind.Numbered));
    placeDisc(a, 6, 3, makeDisc(2, DiscKind.Numbered));
    for (let r = 0; r < a.length; r++) for (let c = 0; c < a[r]!.length; c++) {
      if (a[r]![c]) placeDisc(b, r, c, { ...a[r]![c]! });
    }

    applyDirectionalGravity(a, 'up');
    settleContinuous(b, 180);
    expect(b).toEqual(a);
  });

  test('270deg matches applyDirectionalGravity left', () => {
    const a = makeEmptyBoard();
    const b = makeEmptyBoard();
    placeDisc(a, 4, 2, makeDisc(1, DiscKind.Numbered));
    placeDisc(a, 4, 5, makeDisc(2, DiscKind.Numbered));
    for (let r = 0; r < a.length; r++) for (let c = 0; c < a[r]!.length; c++) {
      if (a[r]![c]) placeDisc(b, r, c, { ...a[r]![c]! });
    }

    applyDirectionalGravity(a, 'left');
    settleContinuous(b, 270);
    expect(b).toEqual(a);
  });

  test('45deg on a 3x3 board slides a corner disc to the opposite corner', () => {
    const board = makeEmptyBoard(3, 3);
    const disc = makeDisc(1, DiscKind.Numbered);
    placeDisc(board, 0, 0, disc);

    const step = settleContinuous(board, 45);

    expect(board[2]![2]).toBe(disc);
    expect(board[0]![0]).toBeNull();
    expect(step.moves).toEqual([
      {
        from: { row: 0, col: 0 }, to: { row: 2, col: 2 }, disc: { ...disc },
        path: [{ row: 0, col: 0 }, { row: 2, col: 2 }],
      },
    ]);
  });

  test('45deg stacks two diagonal discs without overlapping', () => {
    const board = makeEmptyBoard(3, 3);
    const trailing = makeDisc(1, DiscKind.Numbered);
    const leading = makeDisc(2, DiscKind.Numbered);
    placeDisc(board, 0, 0, trailing);
    placeDisc(board, 1, 1, leading);

    settleContinuous(board, 45);

    expect(board[2]![2]).toBe(leading);
    expect(board[1]![1]).toBe(trailing);
    expect(board[0]![0]).toBeNull();
  });

  test('is deterministic for a fixed board and angle', () => {
    const board = makeEmptyBoard(6, 6);
    placeDisc(board, 0, 1, makeDisc(1, DiscKind.Numbered));
    placeDisc(board, 2, 4, makeDisc(2, DiscKind.Numbered));
    placeDisc(board, 5, 0, makeDisc(3, DiscKind.Numbered));
    placeDisc(board, 3, 3, makeDisc(4, DiscKind.Numbered));
    const a = deepCloneBoard(board);
    const b = deepCloneBoard(board);
    settleContinuous(a, 33);
    settleContinuous(b, 33);
    expect(a).toEqual(b);
  });

  test('small angle changes can produce different results (genuinely continuous, not 8-bucket)', () => {
    const board = makeEmptyBoard(6, 6);
    placeDisc(board, 0, 0, makeDisc(1, DiscKind.Numbered));
    placeDisc(board, 0, 5, makeDisc(2, DiscKind.Numbered));
    placeDisc(board, 2, 2, makeDisc(3, DiscKind.Numbered));
    placeDisc(board, 2, 3, makeDisc(4, DiscKind.Numbered));
    placeDisc(board, 5, 0, makeDisc(5, DiscKind.Numbered));
    placeDisc(board, 5, 5, makeDisc(6, DiscKind.Numbered));
    const a = deepCloneBoard(board);
    const b = deepCloneBoard(board);
    settleContinuous(a, 40);
    settleContinuous(b, 50);
    expect(a).not.toEqual(b);
  });

  test('never overlaps discs and preserves the disc count, across several angles', () => {
    const build = () => {
      const board = makeEmptyBoard(6, 6);
      placeDisc(board, 0, 0, makeDisc(1, DiscKind.Numbered));
      placeDisc(board, 0, 3, makeDisc(2, DiscKind.Numbered));
      placeDisc(board, 1, 5, makeDisc(3, DiscKind.Numbered));
      placeDisc(board, 3, 1, makeDisc(4, DiscKind.Numbered));
      placeDisc(board, 4, 4, makeDisc(5, DiscKind.Numbered));
      placeDisc(board, 5, 2, makeDisc(6, DiscKind.Numbered));
      return board;
    };

    for (const angle of [0, 15, 33, 47.5, 90, 123, 200, 289, 359]) {
      const board = build();
      settleContinuous(board, angle);
      const occupied = board.flat().filter((c): c is NonNullable<typeof c> => c !== null);
      expect(occupied).toHaveLength(6);
      expect(new Set(occupied.map(d => d.id)).size).toBe(6);
    }
  });

  test('every disc ends at depth >= its starting depth along the gravity vector', () => {
    const board = makeEmptyBoard(6, 6);
    placeDisc(board, 0, 0, makeDisc(1, DiscKind.Numbered));
    placeDisc(board, 2, 4, makeDisc(2, DiscKind.Numbered));
    placeDisc(board, 5, 1, makeDisc(3, DiscKind.Numbered));
    placeDisc(board, 3, 3, makeDisc(4, DiscKind.Numbered));

    const before = deepCloneBoard(board);
    const angle = 62;
    const { gx, gy } = computeGravityVector(angle);
    const depth = (row: number, col: number) => col * gx + row * gy;

    const startDepths = new Map<number, number>();
    for (let r = 0; r < before.length; r++) for (let c = 0; c < before[r]!.length; c++) {
      const disc = before[r]![c];
      if (disc) startDepths.set(disc.id, depth(r, c));
    }

    settleContinuous(board, angle);

    for (let r = 0; r < board.length; r++) for (let c = 0; c < board[r]!.length; c++) {
      const disc = board[r]![c];
      if (disc) expect(depth(r, c)).toBeGreaterThanOrEqual(startDepths.get(disc.id)! - 1e-6);
    }
  });

  // Regression: the ray-march used to resolve each disc's final cell in a
  // single pass, but two discs on nearly-the-same ray can round to the same
  // intermediate cell — whichever is processed first "claims" it and blocks
  // the other prematurely, even though it goes on to move further away later
  // in that same pass. That left a disc's true resting cell to only be
  // reached by a second, unrelated settle() call — invisible in gameplay
  // until a later, unrelated turn nudged already-placed discs with no player
  // action to explain it. Confirmed via fuzz testing that ~76% of angles hit
  // this on a 10x7 board. settleContinuous must fully converge in one call.
  test('a single call reaches the true fixed point — settling again produces no further moves', () => {
    for (const angle of [4, 20, 24, 88, 130, 208, 288, 352]) {
      const board = makeEmptyBoard(7, 10);
      placeDisc(board, 7, 0, makeDisc(1, DiscKind.Numbered));
      placeDisc(board, 7, 3, makeDisc(2, DiscKind.Numbered));
      placeDisc(board, 7, 6, makeDisc(3, DiscKind.Numbered));
      placeDisc(board, 2, 1, makeDisc(4, DiscKind.Numbered));
      placeDisc(board, 4, 5, makeDisc(5, DiscKind.Numbered));

      settleContinuous(board, angle);
      const second = settleContinuous(deepCloneBoard(board), angle);
      expect(second.moves).toEqual([]);
    }
  });

  // A disc reaching its true resting cell across multiple convergence passes
  // (see the regression above) doesn't travel in a straight line to get
  // there — it routes around whatever's in its way pass by pass. `path`
  // should record that actual bent route, not just [from, to], so the UI can
  // animate the real motion instead of a straight line that visually cuts
  // through discs the mover never really passed.
  test('path records the actual multi-hop route around a pile, not a straight line', () => {
    const board = makeEmptyBoard(7, 7);
    placeDisc(board, 6, 0, makeDisc(1, DiscKind.Numbered));
    placeDisc(board, 6, 1, makeDisc(2, DiscKind.Numbered));
    placeDisc(board, 5, 1, makeDisc(3, DiscKind.Numbered));
    placeDisc(board, 6, 2, makeDisc(4, DiscKind.Numbered));
    placeDisc(board, 5, 2, makeDisc(5, DiscKind.Numbered));
    const mover = makeDisc(6, DiscKind.Numbered);
    placeDisc(board, 4, 2, mover);
    placeDisc(board, 6, 3, makeDisc(7, DiscKind.Numbered));

    const step = settleContinuous(board, 30);

    const move = step.moves.find(m => m.disc.id === mover.id)!;
    expect(move.from).toEqual({ row: 4, col: 2 });
    expect(move.to).toEqual({ row: 6, col: 4 });
    // The straight-line path would be just [from, to]; the real one bends
    // through an intermediate cell where the first pass left it blocked.
    expect(move.path).toEqual([
      { row: 4, col: 2 }, { row: 5, col: 3 }, { row: 6, col: 4 },
    ]);
  });
});

// ─── gravityRunLengths ───────────────────────────────────────────────────────

describe('gravityRunLengths', () => {
  test('0deg (along-gravity vertical, cross-gravity horizontal) matches classic run counts', () => {
    const board = makeEmptyBoard(7, 7);
    placeDisc(board, 4, 2, makeDisc(1, DiscKind.Numbered));
    placeDisc(board, 5, 2, makeDisc(2, DiscKind.Numbered));
    placeDisc(board, 6, 2, makeDisc(3, DiscKind.Numbered));
    placeDisc(board, 6, 3, makeDisc(4, DiscKind.Numbered));
    placeDisc(board, 6, 4, makeDisc(5, DiscKind.Numbered));

    for (const [row, col] of [[4, 2], [5, 2], [6, 2], [6, 3], [6, 4]]) {
      const { alongGravity, crossGravity } = gravityRunLengths(board, row!, col!, 0);
      expect(alongGravity).toBe(countVerticalRun(board, row!, col!));
      expect(crossGravity).toBe(countHorizontalRun(board, row!, col!));
    }
  });

  test.each([0, 90, 180, 270])('%ideg matches classic run counts (order of along/cross swaps, set does not)', (angle) => {
    const board = makeEmptyBoard(7, 7);
    placeDisc(board, 2, 3, makeDisc(1, DiscKind.Numbered));
    placeDisc(board, 3, 3, makeDisc(2, DiscKind.Numbered));
    placeDisc(board, 3, 4, makeDisc(3, DiscKind.Numbered));

    for (const [row, col] of [[2, 3], [3, 3], [3, 4]]) {
      const { alongGravity, crossGravity } = gravityRunLengths(board, row!, col!, angle);
      const classicPair = [countVerticalRun(board, row!, col!), countHorizontalRun(board, row!, col!)].sort();
      expect([alongGravity, crossGravity].sort()).toEqual(classicPair);
    }
  });

  // The whole point of this generalization: a diagonal line of discs, which
  // grid-aligned countHorizontalRun/countVerticalRun would each see as
  // isolated singletons (run length 1), reads as a real run of 3 once the
  // gravity angle actually points along that diagonal — matching how
  // settleContinuous would have packed a pile at that same angle.
  test('a 45deg diagonal line of discs is a run of 3 along gravity at 45deg, not 3 isolated singletons', () => {
    const board = makeEmptyBoard(7, 7);
    placeDisc(board, 2, 2, makeDisc(1, DiscKind.Numbered));
    placeDisc(board, 3, 3, makeDisc(2, DiscKind.Numbered));
    placeDisc(board, 4, 4, makeDisc(3, DiscKind.Numbered));

    // Grid-aligned (classic) view: each disc is alone in its row and column.
    expect(countHorizontalRun(board, 3, 3)).toBe(1);
    expect(countVerticalRun(board, 3, 3)).toBe(1);

    // Gravity-aware view at 45deg: the middle disc sees a run of 3 along gravity.
    const { alongGravity } = gravityRunLengths(board, 3, 3, 45);
    expect(alongGravity).toBe(3);
  });
});
