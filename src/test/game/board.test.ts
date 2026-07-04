import { describe, test, expect } from 'vitest';
import {
  makeEmptyBoard, cloneBoard, deepCloneBoard,
  placeDisc, removeDisc,
  countInRow, countInCol,
  countHorizontalRun, countVerticalRun,
  landingRow, isColumnFull,
  applyGravity,
  DEFAULT_BOARD_COLS, DEFAULT_BOARD_ROWS,
} from '../../game/board.js';
import { makeDisc } from '../../game/disc.js';
import { DiscKind } from '../../game/model.js';
import { StepKind } from '../../game/events.js';

// ─── makeEmptyBoard ─────────────────────────────────────────────────────────

describe('makeEmptyBoard', () => {
  test('creates a 7×7 grid of null cells', () => {
    const board = makeEmptyBoard();
    expect(board.length).toBe(DEFAULT_BOARD_ROWS);
    for (const row of board) {
      expect(row.length).toBe(DEFAULT_BOARD_COLS);
      for (const cell of row) {
        expect(cell).toBeNull();
      }
    }
  });
});

// ─── placeDisc / removeDisc ─────────────────────────────────────────────────

describe('placeDisc', () => {
  test('writes disc to the specified cell', () => {
    const board = makeEmptyBoard();
    const disc = makeDisc(3, DiscKind.Numbered);
    placeDisc(board, 3, 2, disc);
    expect(board[3]![2]).toBe(disc);
  });
});

describe('removeDisc', () => {
  test('nulls the specified cell', () => {
    const board = makeEmptyBoard();
    const disc = makeDisc(1, DiscKind.Numbered);
    placeDisc(board, 5, 4, disc);
    removeDisc(board, { row: 5, col: 4 });
    expect(board[5]![4]).toBeNull();
  });
});

// ─── countInRow / countInCol ─────────────────────────────────────────────────

describe('countInRow', () => {
  test('counts non-null cells in a row', () => {
    const board = makeEmptyBoard();
    placeDisc(board, 6, 0, makeDisc(1, DiscKind.Numbered));
    placeDisc(board, 6, 3, makeDisc(2, DiscKind.Numbered));
    placeDisc(board, 6, 6, makeDisc(3, DiscKind.Numbered));
    expect(countInRow(board, 6)).toBe(3);
  });

  test('returns 0 for an empty row', () => {
    expect(countInRow(makeEmptyBoard(), 3)).toBe(0);
  });
});

describe('countInCol', () => {
  test('counts non-null cells in a column', () => {
    const board = makeEmptyBoard();
    placeDisc(board, 4, 4, makeDisc(1, DiscKind.Numbered));
    placeDisc(board, 6, 4, makeDisc(2, DiscKind.Numbered));
    expect(countInCol(board, 4)).toBe(2);
  });

  test('counts cracked discs too', () => {
    const board = makeEmptyBoard();
    placeDisc(board, 5, 1, makeDisc(3, DiscKind.DoubleCracked));
    expect(countInCol(board, 1)).toBe(1);
  });
});

describe('contiguous run counts', () => {
  test('a gap separates horizontal groups', () => {
    const board = makeEmptyBoard();
    placeDisc(board, 6, 0, makeDisc(1, DiscKind.Numbered));
    placeDisc(board, 6, 2, makeDisc(7, DiscKind.Numbered));

    expect(countHorizontalRun(board, 6, 0)).toBe(1);
    expect(countHorizontalRun(board, 6, 2)).toBe(1);
  });

  test('counts the complete vertical group containing the cell', () => {
    const board = makeEmptyBoard();
    placeDisc(board, 4, 3, makeDisc(3, DiscKind.Numbered));
    placeDisc(board, 5, 3, makeDisc(3, DiscKind.SingleCracked));
    placeDisc(board, 6, 3, makeDisc(3, DiscKind.Numbered));

    expect(countVerticalRun(board, 5, 3)).toBe(3);
  });
});

// ─── landingRow ─────────────────────────────────────────────────────────────

describe('landingRow', () => {
  test('empty column → bottom row (6)', () => {
    expect(landingRow(makeEmptyBoard(), 3)).toBe(6);
  });

  test('partially filled column → first empty row above stack', () => {
    const board = makeEmptyBoard();
    placeDisc(board, 5, 2, makeDisc(1, DiscKind.Numbered));
    placeDisc(board, 6, 2, makeDisc(2, DiscKind.Numbered));
    expect(landingRow(board, 2)).toBe(4);
  });

  test('full column → null', () => {
    const board = makeEmptyBoard();
    for (let r = 0; r < DEFAULT_BOARD_ROWS; r++) {
      placeDisc(board, r, 0, makeDisc(1, DiscKind.Numbered));
    }
    expect(landingRow(board, 0)).toBeNull();
  });
});

// ─── isColumnFull ────────────────────────────────────────────────────────────

describe('isColumnFull', () => {
  test('false for empty column', () => {
    expect(isColumnFull(makeEmptyBoard(), 3)).toBe(false);
  });

  test('false when only lower rows are occupied', () => {
    const board = makeEmptyBoard();
    placeDisc(board, 6, 3, makeDisc(1, DiscKind.Numbered));
    expect(isColumnFull(board, 3)).toBe(false);
  });

  test('true when row 0 is occupied', () => {
    const board = makeEmptyBoard();
    placeDisc(board, 0, 3, makeDisc(1, DiscKind.Numbered));
    expect(isColumnFull(board, 3)).toBe(true);
  });
});

// ─── applyGravity ────────────────────────────────────────────────────────────

describe('applyGravity', () => {
  test('compacts a disc to the bottom', () => {
    const board = makeEmptyBoard();
    const disc = makeDisc(4, DiscKind.Numbered);
    placeDisc(board, 2, 0, disc);
    const step = applyGravity(board);
    expect(board[6]![0]).toBe(disc);
    expect(board[2]![0]).toBeNull();
    expect(step.kind).toBe(StepKind.Fall);
    expect(step.moves.length).toBe(1);
    expect(step.moves[0]!.from.row).toBe(2);
    expect(step.moves[0]!.to.row).toBe(6);
  });

  test('no moves when discs are already settled', () => {
    const board = makeEmptyBoard();
    placeDisc(board, 6, 0, makeDisc(1, DiscKind.Numbered));
    const step = applyGravity(board);
    expect(step.moves.length).toBe(0);
  });

  test('multiple discs in same column compact correctly', () => {
    const board = makeEmptyBoard();
    const a = makeDisc(1, DiscKind.Numbered);
    const b = makeDisc(2, DiscKind.Numbered);
    placeDisc(board, 0, 0, a);
    placeDisc(board, 3, 0, b);
    applyGravity(board);
    // b was lower, ends up at row 6; a was higher, ends up at row 5
    expect(board[6]![0]).toBe(b);
    expect(board[5]![0]).toBe(a);
  });
});

// ─── deepCloneBoard ──────────────────────────────────────────────────────────

describe('deepCloneBoard', () => {
  test('mutating original does not affect clone', () => {
    const board = makeEmptyBoard();
    const disc = makeDisc(2, DiscKind.Numbered);
    placeDisc(board, 6, 0, disc);
    const clone = deepCloneBoard(board);
    board[6]![0] = null; // mutate original
    expect(clone[6]![0]).not.toBeNull();
  });

  test('disc objects in clone are independent (kind mutation does not leak)', () => {
    const board = makeEmptyBoard();
    placeDisc(board, 6, 0, makeDisc(3, DiscKind.DoubleCracked));
    const clone = deepCloneBoard(board);
    board[6]![0]!.kind = DiscKind.Numbered; // mutate original's disc
    expect(clone[6]![0]!.kind).toBe(DiscKind.DoubleCracked);
  });

  test('clone has same disc IDs as original', () => {
    const board = makeEmptyBoard();
    const disc = makeDisc(5, DiscKind.Numbered);
    placeDisc(board, 4, 3, disc);
    const clone = deepCloneBoard(board);
    expect(clone[4]![3]!.id).toBe(disc.id);
  });
});

// ─── cloneBoard (shallow) ────────────────────────────────────────────────────

describe('cloneBoard', () => {
  test('row arrays are independent', () => {
    const board = makeEmptyBoard();
    const disc = makeDisc(1, DiscKind.Numbered);
    placeDisc(board, 6, 0, disc);
    const clone = cloneBoard(board);
    board[6]![0] = null;
    expect(clone[6]![0]).toBe(disc); // clone's row still has disc
  });
});
