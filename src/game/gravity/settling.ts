import type { Board, Disc, EntryEdge, GridPos } from '../model.js';
import type { FallStep } from '../events.js';
import { StepKind } from '../events.js';

export type { EntryEdge };

export interface GravityVector {
  gx: number;
  gy: number;
}

const CARDINAL_ENTRY_EDGE: Record<number, EntryEdge> = {
  0: 'top',
  90: 'left',
  180: 'bottom',
  270: 'right',
};

function normalizeAngle(angleDeg: number): number {
  return ((angleDeg % 360) + 360) % 360;
}

/**
 * angleDeg is continuous, 0 = straight down (classic gravity). Increasing
 * angle rotates clockwise on screen: 90 = right, 180 = up, 270 = left.
 */
export function computeGravityVector(angleDeg: number): GravityVector {
  const rad = (angleDeg * Math.PI) / 180;
  let gx = Math.sin(rad);
  let gy = Math.cos(rad);
  // Snap floating-point noise (e.g. cos(90deg) ~= 6.12e-17) to exact 0 so
  // cardinal angles behave identically to applyDirectionalGravity.
  if (Math.abs(gx) < 1e-9) gx = 0;
  if (Math.abs(gy) < 1e-9) gy = 0;
  return { gx, gy };
}

/** Snaps a continuous angle to the entry edge opposite the nearest cardinal gravity direction. */
export function entryEdgeForAngle(angleDeg: number): EntryEdge {
  const nearestCardinal = (Math.round(normalizeAngle(angleDeg) / 90) * 90) % 360;
  return CARDINAL_ENTRY_EDGE[nearestCardinal]!;
}

const OPPOSITE_EDGE: Record<EntryEdge, EntryEdge> = {
  top: 'bottom', bottom: 'top', left: 'right', right: 'left',
};

/**
 * The edge opposite a given one. Used to find the "floor" a level push
 * should enter from: entryEdgeForAngle gives the side a DROP enters from
 * (opposite the gravity pull), so the side gravity actually pulls TOWARD —
 * where discs settle, and where a push's new row/column should appear from,
 * same as Classic's push always entering from the bottom when gravity pulls
 * straight down (entry edge 'top') — is the opposite of that.
 */
export function oppositeEdge(edge: EntryEdge): EntryEdge {
  return OPPOSITE_EDGE[edge];
}

/** True when the cell a new disc would enter through on this edge/lane is already occupied. */
export function isLaneFull(board: Board, lane: number, entryEdge: EntryEdge): boolean {
  const rows = board.length;
  const cols = board[0]!.length;
  switch (entryEdge) {
    case 'top': return board[0]![lane] !== null;
    case 'bottom': return board[rows - 1]![lane] !== null;
    case 'left': return board[lane]![0] !== null;
    case 'right': return board[lane]![cols - 1] !== null;
  }
}

/** The on-grid cell a disc entering this lane/edge is placed into. */
export function entryPositionForLane(entryEdge: EntryEdge, lane: number, rows: number, cols: number): GridPos {
  switch (entryEdge) {
    case 'top': return { row: 0, col: lane };
    case 'bottom': return { row: rows - 1, col: lane };
    case 'left': return { row: lane, col: 0 };
    case 'right': return { row: lane, col: cols - 1 };
  }
}

/** One cell beyond the board edge, used as the animation start position for an entering disc. */
export function offBoardEntryPosition(entryEdge: EntryEdge, lane: number, rows: number, cols: number): GridPos {
  switch (entryEdge) {
    case 'top': return { row: -1, col: lane };
    case 'bottom': return { row: rows, col: lane };
    case 'left': return { row: lane, col: -1 };
    case 'right': return { row: lane, col: cols };
  }
}

const EPSILON = 1e-9;

/**
 * Settles every disc on the board toward a continuous gravity angle, in place.
 * Grid-based, not free physics: every disc always ends on an integer cell.
 *
 * Algorithm (see gravity-mode-design.md "Gravity And Settling Model" for the
 * depth/side-order formulas this is built on):
 *   1. depth(row,col) = col*gx + row*gy — position along the gravity vector.
 *      Sort discs by depth descending (most-settled first).
 *   2. Process in that order; each disc marches a continuous ray from its own
 *      position along (gy,gx), rounding every step to the nearest grid cell,
 *      advancing as far as possible while the candidate is in-bounds and not
 *      yet claimed by an earlier (deeper) disc this pass.
 *
 * Because deeper discs are processed first and only ever advance to strictly
 * higher depth, a disc's forward ray can never reach a not-yet-processed
 * disc's original cell (which necessarily has depth <= the current disc's
 * starting depth) — so no explicit collision handling with unprocessed discs
 * is needed beyond the `claimed` set for already-placed ones.
 *
 * Reduces to exactly applyDirectionalGravity's per-lane packing at the 4
 * cardinal angles (see gravity.test.ts).
 *
 * At non-cardinal angles a single pass is NOT guaranteed to reach every
 * disc's true final cell: two discs on nearly-but-not-quite the same ray can
 * round to the same intermediate cell, so whichever is processed first
 * "claims" it and blocks the other prematurely, even though the blocker goes
 * on to move further away later in the same pass. A fuzz test proved this —
 * ~76% of angles left some discs one or more cells short after one pass, only
 * settling fully after 2-8 repeated calls. settleContinuous (below) is the
 * public entry point and repeats settleOnePass to a fixed point; settleOnePass
 * is the single-pass primitive described above.
 */
function settleOnePass(board: Board, angleDeg: number): FallStep {
  const { gx, gy } = computeGravityVector(angleDeg);
  const rows = board.length;
  const cols = board[0]!.length;

  const depth = (row: number, col: number) => col * gx + row * gy;
  const sideOrder = (row: number, col: number) => col * -gy + row * gx;

  const placements: Array<{ disc: Disc; row: number; col: number }> = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const disc = board[row]![col];
      if (disc != null) placements.push({ disc, row, col });
    }
  }

  const ordered = [...placements].sort((a, b) => {
    const depthDiff = depth(b.row, b.col) - depth(a.row, a.col);
    if (Math.abs(depthDiff) > EPSILON) return depthDiff;
    const sideDiff = sideOrder(a.row, a.col) - sideOrder(b.row, b.col);
    if (Math.abs(sideDiff) > EPSILON) return sideDiff;
    return (a.row * cols + a.col) - (b.row * cols + b.col);
  });

  const claimed = new Set<string>();
  const finalPos = new Map<Disc, GridPos>();
  const maxSteps = rows + cols;

  for (const { disc, row, col } of ordered) {
    let bestRow = row;
    let bestCol = col;
    let lastRow = row;
    let lastCol = col;

    for (let t = 1; t <= maxSteps; t++) {
      const candRow = Math.round(row + t * gy);
      const candCol = Math.round(col + t * gx);
      if (candRow < 0 || candRow >= rows || candCol < 0 || candCol >= cols) break;
      if (candRow === lastRow && candCol === lastCol) continue; // rounding repeated the same cell
      if (claimed.has(`${candRow},${candCol}`)) break;
      bestRow = candRow;
      bestCol = candCol;
      lastRow = candRow;
      lastCol = candCol;
    }

    claimed.add(`${bestRow},${bestCol}`);
    finalPos.set(disc, { row: bestRow, col: bestCol });
  }

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      board[row]![col] = null;
    }
  }

  const moves: FallStep['moves'] = [];
  for (const { disc, row, col } of placements) {
    const pos = finalPos.get(disc)!;
    board[pos.row]![pos.col] = disc;
    if (pos.row !== row || pos.col !== col) {
      moves.push({ from: { row, col }, to: { row: pos.row, col: pos.col }, disc: { ...disc } });
    }
  }

  return { kind: StepKind.Fall, moves };
}

/**
 * Public entry point: repeats settleOnePass until it reaches a fixed point
 * (a pass that moves nothing), so every disc ends on its true final cell
 * regardless of how many passes that takes. Each pass only ever advances
 * discs to strictly higher depth and depth is bounded by the board size, so
 * this always terminates; rows+cols is a safe cap (fuzz-tested convergence
 * tops out around 8 passes on a 10x7 board). Returns the NET move for each
 * disc — from its position when this function was called to its true final
 * cell — along with the actual waypoint-by-waypoint `path` it took to get
 * there (one entry per pass in which it moved), so a caller that wants to
 * animate the true, obstacle-routed motion can, instead of a straight line
 * that can visually cut through/past discs the mover never actually passed.
 */
export function settleContinuous(board: Board, angleDeg: number): FallStep {
  const rows = board.length;
  const cols = board[0]!.length;

  const originalPos = new Map<number, GridPos>();
  const path = new Map<number, GridPos[]>();
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const disc = board[row]![col];
      if (disc) {
        originalPos.set(disc.id, { row, col });
        path.set(disc.id, [{ row, col }]);
      }
    }
  }

  const maxPasses = rows + cols;
  for (let pass = 0; pass < maxPasses; pass++) {
    const { moves } = settleOnePass(board, angleDeg);
    if (moves.length === 0) break;
    for (const move of moves) path.get(move.disc.id)!.push(move.to);
  }

  const moves: FallStep['moves'] = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const disc = board[row]![col];
      if (!disc) continue;
      const from = originalPos.get(disc.id)!;
      if (from.row !== row || from.col !== col) {
        moves.push({ from, to: { row, col }, disc: { ...disc }, path: path.get(disc.id)! });
      }
    }
  }

  return { kind: StepKind.Fall, moves };
}

// The 8 grid-exact directions a gravity angle can snap to for run detection,
// index i holding the (dRow,dCol) step for angle i*45deg (same clockwise
// convention as computeGravityVector: 0=down, 90=right, 180=up, 270=left).
const EIGHT_DIRECTIONS: readonly [number, number][] = [
  [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1],
];

// A continuous angle has no consistent, symmetric notion of "the next cell
// in this line" on a discrete grid except at multiples of 45deg — a fuzz
// test proved this by finding two discs that were "obviously" part of the
// same physical line each computing a DIFFERENT run length for it, because
// Math.round(k*d) isn't linear in k, so independent per-cell ray marching
// drifts apart at generic angles. Only cardinal and diagonal directions have
// an exact, rounding-free grid step (dRow,dCol both in {-1,0,1}).
//
// This turned out to matter beyond just the run check: settling at any angle
// that ISN'T one of these 8 only approximately resembles a clean line — e.g.
// a 5-disc pile settled at 40deg (well inside the "nearest is 45deg" range,
// not even near a boundary) comes out kinked, with two discs sharing a row
// partway up instead of a single-file diagonal, because the true continuous
// packing only lines up exactly with the diagonal lattice at exactly 45deg.
// A player watching that pile reasonably reads it as "a line" and is
// confused when it doesn't clear as one. So GameEngine snaps the gravity
// ANGLE itself (not just the run check) to one of these 8 directions at the
// moment a tilt/drop actually commits — see GravitySystem.prepareTiltCommit and
// snapAngleToEightDirections — so the pile only ever physically packs into
// one of these 8 exact shapes, which always matches what the run check
// (below) expects. Aiming/dragging is still continuous for feel; only the
// angle actually used to settle is quantized.
export function snapAngleToEightDirections(angleDeg: number): number {
  const normalized = ((angleDeg % 360) + 360) % 360;
  return (Math.round(normalized / 45) * 45) % 360;
}

function snapToEightDirections(angleDeg: number): [number, number] {
  const snappedAngle = snapAngleToEightDirections(angleDeg);
  return EIGHT_DIRECTIONS[snappedAngle / 45]!;
}

// Walks from (row,col) in an exact integer grid direction, counting
// consecutive occupied cells. No rounding is involved — (dRow,dCol) are
// always -1/0/1 — so this is trivially symmetric: if this run includes a
// neighbor, that neighbor's own run agrees on the total length, exactly like
// countHorizontalRun/countVerticalRun already do.
function stepRun(board: Board, row: number, col: number, dRow: number, dCol: number): number {
  const rows = board.length;
  const cols = board[0]!.length;
  let n = 0;
  let r = row + dRow;
  let c = col + dCol;
  while (r >= 0 && r < rows && c >= 0 && c < cols && board[r]![c] != null) {
    n++;
    r += dRow;
    c += dCol;
  }
  return n;
}

/**
 * Generalizes countHorizontalRun/countVerticalRun (board.ts, Classic's fixed
 * up/down gravity) to gravity mode: the "along-gravity" run is the
 * contiguous stack of discs in the direction gravity pulls, and the
 * "cross-gravity" run is the contiguous line perpendicular to that — the
 * direction a single "layer" of the pile extends in. angleDeg snaps to
 * whichever of 8 directions (4 cardinal + 4 diagonal) is nearest before
 * counting (see snapToEightDirections for why). At angleDeg 0/90/180/270
 * this reduces exactly to {countVerticalRun, countHorizontalRun}
 * (see gravity.test.ts).
 */
export function gravityRunLengths(
  board: Board, row: number, col: number, angleDeg: number,
): { alongGravity: number; crossGravity: number } {
  const [dRow, dCol] = snapToEightDirections(angleDeg);
  const alongGravity = 1 + stepRun(board, row, col, dRow, dCol) + stepRun(board, row, col, -dRow, -dCol);
  const crossGravity = 1 + stepRun(board, row, col, dCol, -dRow) + stepRun(board, row, col, -dCol, dRow);
  return { alongGravity, crossGravity };
}
