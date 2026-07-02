import { Board, Cell, Disc, FallStep, GridPos, StepKind } from './types.js';
import { GRID_COLS, GRID_ROWS } from './constants.js';

export function makeEmptyBoard(): Board {
  return Array.from({ length: GRID_ROWS }, () =>
    Array<Cell>(GRID_COLS).fill(null)
  );
}

export function cloneBoard(b: Board): Board {
  return b.map(row => [...row]);
}

// Deep-clones a board by creating new disc objects via spread. Used to snapshot
// the board before physics runs so the visual board starts at the correct pre-drop
// state and can be advanced step-by-step as animations complete.
export function deepCloneBoard(b: Board): Board {
  return b.map(row => row.map(cell => cell != null ? { ...cell } : null));
}

export function placeDisc(board: Board, row: number, col: number, disc: Disc): void {
  board[row]![col] = disc;
}

export function removeDisc(board: Board, pos: GridPos): void {
  board[pos.row]![pos.col] = null;
}

export function countInRow(board: Board, row: number): number {
  let n = 0;
  for (let c = 0; c < GRID_COLS; c++) {
    if (board[row]![c] !== null) n++;
  }
  return n;
}

export function countInCol(board: Board, col: number): number {
  let n = 0;
  for (let r = 0; r < GRID_ROWS; r++) {
    if (board[r]![col] !== null) n++;
  }
  return n;
}

/** Counts the uninterrupted horizontal group containing (row, col). */
export function countHorizontalRun(board: Board, row: number, col: number): number {
  if (board[row]?.[col] == null) return 0;

  let n = 1;
  for (let c = col - 1; c >= 0 && board[row]![c] != null; c--) n++;
  for (let c = col + 1; c < GRID_COLS && board[row]![c] != null; c++) n++;
  return n;
}

/** Counts the uninterrupted vertical group containing (row, col). */
export function countVerticalRun(board: Board, row: number, col: number): number {
  if (board[row]?.[col] == null) return 0;

  let n = 1;
  for (let r = row - 1; r >= 0 && board[r]![col] != null; r--) n++;
  for (let r = row + 1; r < GRID_ROWS && board[r]![col] != null; r++) n++;
  return n;
}

/** Row index where a dropped disc lands; null if column is full. */
export function landingRow(board: Board, col: number): number | null {
  // Scan bottom-up: the first empty cell from the bottom is the landing spot.
  for (let r = GRID_ROWS - 1; r >= 0; r--) {
    if (board[r]![col] === null) return r;
  }
  return null;
}

export function isColumnFull(board: Board, col: number): boolean {
  return board[0]![col] !== null;
}

/** Compact each column downward in-place. Returns a FallStep describing every disc that moved. */
export function applyGravity(board: Board): FallStep {
  const moves: FallStep['moves'] = [];

  for (let col = 0; col < GRID_COLS; col++) {
    // Collect all discs with their current row positions before touching the board.
    // If we moved discs in-place we'd lose track of where they started, which the
    // FallStep needs so the animation can interpolate from the correct position.
    const discs: Array<{ disc: Disc; origRow: number }> = [];
    for (let row = 0; row < GRID_ROWS; row++) {
      const cell = board[row]![col];
      // Loose != covers both null and undefined; noUncheckedIndexedAccess makes
      // board[row]![col] type Cell | undefined, so !== null alone wouldn't narrow correctly.
      if (cell != null) discs.push({ disc: cell, origRow: row });
    }

    // Wipe the column, then write discs back from the bottom up.
    for (let row = 0; row < GRID_ROWS; row++) {
      board[row]![col] = null;
    }

    let writeRow = GRID_ROWS - 1;
    for (let i = discs.length - 1; i >= 0; i--) {
      const { disc, origRow } = discs[i]!;
      board[writeRow]![col] = disc;
      if (origRow !== writeRow) {
        // FallStep is a playback event. Do not retain a mutable board reference:
        // a later clear in the same turn may reveal this disc before animation runs.
        moves.push({ from: { row: origRow, col }, to: { row: writeRow, col }, disc: { ...disc } });
      }
      writeRow--;
    }
  }

  return { kind: StepKind.Fall, moves };
}
