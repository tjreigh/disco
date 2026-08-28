import type { Board, Cell, Disc, GridPos } from './model.js';
import type { FallStep } from './events.js';
import { StepKind } from './events.js';

export const DEFAULT_BOARD_COLS = 7;
export const DEFAULT_BOARD_ROWS = 7;

export function makeEmptyBoard(cols: number = DEFAULT_BOARD_COLS, rows: number = DEFAULT_BOARD_ROWS): Board {
  return Array.from({ length: rows }, () =>
    Array<Cell>(cols).fill(null),
  );
}

export function cloneBoard(b: Board): Board {
  return b.map(row => [...row]);
}

/**
 * Deep-clones a board with fresh disc objects.
 *
 * @remarks
 * Snapshots the pre-physics board so the visual board can be advanced step by
 * step as animations complete.
 */
export function deepCloneBoard(b: Board): Board {
  return b.map(row => row.map(cell => cell != null ? {
    ...cell,
    ...(cell.temporalFracture
      ? { temporalFracture: { ...cell.temporalFracture } }
      : {}),
  } : null));
}

export function placeDisc(board: Board, row: number, col: number, disc: Disc): void {
  board[row]![col] = disc;
}

export function removeDisc(board: Board, pos: GridPos): void {
  board[pos.row]![pos.col] = null;
}

export function countInRow(board: Board, row: number): number {
  let n = 0;
  for (let c = 0; c < board[row]!.length; c++) {
    if (board[row]![c] !== null) n++;
  }
  return n;
}

export function countInCol(board: Board, col: number): number {
  let n = 0;
  for (let r = 0; r < board.length; r++) {
    if (board[r]![col] !== null) n++;
  }
  return n;
}

/** Counts the uninterrupted horizontal group containing (row, col). */
export function countHorizontalRun(board: Board, row: number, col: number): number {
  if (board[row]?.[col] == null) return 0;

  let n = 1;
  for (let c = col - 1; c >= 0 && board[row]![c] != null; c--) n++;
  for (let c = col + 1; c < board[row]!.length && board[row]![c] != null; c++) n++;
  return n;
}

/** Counts the uninterrupted vertical group containing (row, col). */
export function countVerticalRun(board: Board, row: number, col: number): number {
  if (board[row]?.[col] == null) return 0;

  let n = 1;
  for (let r = row - 1; r >= 0 && board[r]![col] != null; r--) n++;
  for (let r = row + 1; r < board.length && board[r]![col] != null; r++) n++;
  return n;
}

/** Row index where a dropped disc lands; null if column is full. */
export function landingRow(board: Board, col: number): number | null {
  // Scan bottom-up: the first empty cell from the bottom is the landing spot.
  for (let r = board.length - 1; r >= 0; r--) {
    if (board[r]![col] === null) return r;
  }
  return null;
}

export function isColumnFull(board: Board, col: number): boolean {
  return board[0]![col] !== null;
}

/**
 * True when every cell is occupied (no legal drop remains, any mode).
 *
 * @remarks
 * A full scan, not a row-0 shortcut: Classic gravity compacts every column so
 * "row 0 full" implies "board full", but a continuous-angle settle can leave
 * corner gaps under a packed edge row.
 */
export function isBoardFull(board: Board): boolean {
  return board.every(row => row.every(cell => cell !== null));
}

/** True when every cell on the board is empty. */
export function isBoardEmpty(board: Board): boolean {
  return board.every(row => row.every(cell => cell === null));
}

export type GravityDirection = 'down' | 'up' | 'left' | 'right';

// vertical: gravity pulls along rows (down/up), lanes are columns.
// forward: discs pack toward the highest index in their lane (down, right).
const GRAVITY_AXES: Record<GravityDirection, { vertical: boolean; forward: boolean }> = {
  down: { vertical: true, forward: true },
  up: { vertical: true, forward: false },
  right: { vertical: false, forward: true },
  left: { vertical: false, forward: false },
};

/**
 * Compacts every lane perpendicular to `direction` in-place, packing discs toward
 * the gravity target while preserving their relative order within the lane.
 * Down/up lanes are columns; left/right lanes are rows. Returns a FallStep
 * describing every disc that moved.
 */
export function applyDirectionalGravity(board: Board, direction: GravityDirection): FallStep {
  const moves: FallStep['moves'] = [];
  const rows = board.length;
  const cols = board[0]!.length;
  const { vertical, forward } = GRAVITY_AXES[direction];
  const laneCount = vertical ? cols : rows;
  const laneLength = vertical ? rows : cols;

  for (let lane = 0; lane < laneCount; lane++) {
    // Collect all discs with their current lane positions before touching the board.
    // If we moved discs in-place we'd lose track of where they started, which the
    // FallStep needs so the animation can interpolate from the correct position.
    const discs: Array<{ disc: Disc; origPos: number }> = [];
    for (let i = 0; i < laneLength; i++) {
      const row = vertical ? i : lane;
      const col = vertical ? lane : i;
      const cell = board[row]![col];
      // Loose != covers both null and undefined; noUncheckedIndexedAccess makes
      // board[row]![col] type Cell | undefined, so !== null alone wouldn't narrow correctly.
      if (cell != null) discs.push({ disc: cell, origPos: i });
    }

    // Wipe the lane, then write discs back starting from the gravity target end.
    for (let i = 0; i < laneLength; i++) {
      const row = vertical ? i : lane;
      const col = vertical ? lane : i;
      board[row]![col] = null;
    }

    let writePos = forward ? laneLength - 1 : 0;
    const step = forward ? -1 : 1;
    // Process discs nearest the gravity target first so relative order is preserved.
    const ordered = forward ? [...discs].reverse() : discs;
    for (const { disc, origPos } of ordered) {
      const row = vertical ? writePos : lane;
      const col = vertical ? lane : writePos;
      board[row]![col] = disc;
      if (origPos !== writePos) {
        const origRow = vertical ? origPos : lane;
        const origCol = vertical ? lane : origPos;
        // FallStep is a playback event. Do not retain a mutable board reference:
        // a later clear in the same turn may reveal this disc before animation runs.
        moves.push({ from: { row: origRow, col: origCol }, to: { row, col }, disc: { ...disc } });
      }
      writePos += step;
    }
  }

  return { kind: StepKind.Fall, moves };
}

/** Compacts every column downward in-place. Returns a FallStep describing every disc that moved. */
export function applyGravity(board: Board): FallStep {
  return applyDirectionalGravity(board, 'down');
}
