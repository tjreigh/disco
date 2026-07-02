import {
  Board, Disc, DiscKind, GridPos,
  PhysicsStep, StepKind,
  DropStep, ClearStep, FallStep, RevealStep, PushStep,
} from './types.js';
import {
  GRID_COLS, GRID_ROWS,
  POINTS_PER_DISC,
} from './constants.js';
import {
  cloneBoard, countHorizontalRun, countVerticalRun, deepCloneBoard,
  landingRow, placeDisc, removeDisc, applyGravity,
} from './board.js';
import { makeCrackedDisc } from './disc.js';
import type { DiscFactory } from './disc.js';

// Returns every position that should clear this pass.
// A disc clears when its value equals the contiguous horizontal or vertical run
// containing it. Gaps separate runs; remote discs do not keep an isolated 1 alive.
// Only Numbered discs can clear — cracked discs must be revealed first.
// The `seen` set prevents duplicates when a disc qualifies on both row and column.
export interface ClearCheck {
  pos: GridPos;
  discId: number;
  value: number;
  rowCount: number;
  colCount: number;
  clearsByRow: boolean;
  clearsByCol: boolean;
}

export interface LogicFrame {
  label: string;
  board: Board;
}

export interface PhysicsTrace {
  scans: Array<{ chainLevel: number; checks: ClearCheck[]; clears: GridPos[] }>;
  frames: LogicFrame[];
}

function inspectClears(board: Board): { clears: GridPos[]; checks: ClearCheck[] } {
  const seen = new Set<string>();
  const result: GridPos[] = [];
  const checks: ClearCheck[] = [];

  const key = (r: number, c: number) => `${r},${c}`;

  for (let row = 0; row < GRID_ROWS; row++) {
    for (let col = 0; col < GRID_COLS; col++) {
      const disc = board[row]![col];
      if (disc && disc.kind === DiscKind.Numbered) {
        const rowCount = countHorizontalRun(board, row, col);
        const colCount = countVerticalRun(board, row, col);
        const clearsByRow = disc.value === rowCount;
        const clearsByCol = disc.value === colCount;
        checks.push({
          pos: { row, col }, discId: disc.id, value: disc.value,
          rowCount, colCount, clearsByRow, clearsByCol,
        });
        if (!clearsByRow && !clearsByCol) continue;
        const k = key(row, col);
        if (!seen.has(k)) { seen.add(k); result.push({ row, col }); }
      }
    }
  }

  return { clears: result, checks };
}

const DIRS: [number, number][] = [[-1, 0], [1, 0], [0, -1], [0, 1]];

// Degrades cracked discs orthogonally adjacent to the cleared positions.
// DoubleCracked → SingleCracked, SingleCracked → Numbered.
// The `updated` set ensures a cracked disc adjacent to multiple cleared cells
// in the same batch only loses one crack layer per clear event, not one per neighbor.
function applyCrackUpdates(board: Board, cleared: GridPos[]): RevealStep {
  const positions: GridPos[] = [];
  const updated = new Set<string>();

  for (const { row, col } of cleared) {
    for (const [dr, dc] of DIRS) {
      const r = row + dr;
      const c = col + dc;
      if (r < 0 || r >= GRID_ROWS || c < 0 || c >= GRID_COLS) continue;
      const disc = board[r]![c];
      if (!disc) continue;
      const k = `${r},${c}`;
      if (updated.has(k)) continue;
      updated.add(k);

      if (disc.kind === DiscKind.DoubleCracked) {
        disc.kind = DiscKind.SingleCracked;
        positions.push({ row: r, col: c });
      } else if (disc.kind === DiscKind.SingleCracked) {
        disc.kind = DiscKind.Numbered;
        positions.push({ row: r, col: c });
      }
    }
  }

  // Animation steps are an event log, so capture values rather than mutable board
  // references. A later chain may reveal the same disc again before playback starts.
  const discs = positions.map(p => ({ ...board[p.row]![p.col]! }));
  return { kind: StepKind.Reveal, positions, discs };
}

function commitBoard(target: Board, source: Board): void {
  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      target[r]![c] = source[r]![c]!;
    }
  }
}

/** Points awarded per cleared disc at a one-based chain length. */
export function pointsForChain(chainLength: number): number {
  if (!Number.isInteger(chainLength) || chainLength < 1) return 0;
  return Math.floor(POINTS_PER_DISC * Math.pow(chainLength, 2.5));
}

// Resolves every clear/reveal/fall chain on a board that has already changed.
// This is shared by normal drops and row pushes: a push changes every column's
// disc count, so leaving it unresolved makes an eligible disc clear during the
// next, potentially unrelated, drop.
function resolveClearSteps(scratch: Board, trace?: PhysicsTrace): PhysicsStep[] {
  const steps: PhysicsStep[] = [];
  let chainLevel = 0;

  while (true) {
    const inspection = inspectClears(scratch);
    const clears = inspection.clears;
    trace?.scans.push({
      chainLevel,
      checks: inspection.checks,
      clears: clears.map(pos => ({ ...pos })),
    });
    if (clears.length === 0) break;

    const points = clears.length * pointsForChain(chainLevel + 1);
    // Capture immutable playback values before removeDisc() makes the positions null.
    const clearedDiscs = clears.map(pos => ({ ...scratch[pos.row]![pos.col]! }));
    steps.push({ kind: StepKind.Clear, cleared: clears, discs: clearedDiscs, chainLevel, pointsAwarded: points } satisfies ClearStep);

    for (const pos of clears) removeDisc(scratch, pos);
    trace?.frames.push({
      label: `Clear chain ${chainLevel}: ${clears.length} tile${clears.length === 1 ? '' : 's'}`,
      board: deepCloneBoard(scratch),
    });

    const reveal = applyCrackUpdates(scratch, clears);
    if (reveal.positions.length > 0) {
      steps.push(reveal);
      trace?.frames.push({ label: `Reveal ${reveal.positions.length} adjacent tile${reveal.positions.length === 1 ? '' : 's'}`, board: deepCloneBoard(scratch) });
    }

    const fall = applyGravity(scratch);
    if (fall.moves.length > 0) {
      steps.push(fall);
      trace?.frames.push({ label: `Gravity: ${fall.moves.length} move${fall.moves.length === 1 ? '' : 's'}`, board: deepCloneBoard(scratch) });
    }

    chainLevel++;
  }

  return steps;
}

/** Resolves clear chains after an in-place board change such as a row push. */
export function computeClearSteps(board: Board, trace?: PhysicsTrace): PhysicsStep[] {
  const scratch = cloneBoard(board);
  const steps = resolveClearSteps(scratch, trace);
  commitBoard(board, scratch);
  return steps;
}

// Runs all physics for one drop synchronously on a scratch board, produces an
// ordered PhysicsStep[] for animation playback, then commits the final state
// back to the caller's board. The caller's board is therefore settled before
// any animation starts — if the tab loses focus mid-animation, the board is
// already correct when the page resumes.
export function computeDropSteps(
  board: Board,
  disc: Disc,
  col: number,
  trace?: PhysicsTrace,
): PhysicsStep[] {
  const steps: PhysicsStep[] = [];
  const scratch = cloneBoard(board);

  const row = landingRow(scratch, col);
  if (row === null) return steps; // column full — game over handled by caller

  placeDisc(scratch, row, col, disc);
  // The dropped board object may be revealed later in this same synchronous turn.
  // Preserve how it looked at drop time for animation playback.
  steps.push({ kind: StepKind.Drop, disc: { ...disc }, col, toLandRow: row } satisfies DropStep);
  trace?.frames.push({ label: `Drop #${disc.id} into r${row + 1}c${col + 1}`, board: deepCloneBoard(scratch) });
  steps.push(...resolveClearSteps(scratch, trace));

  // Write the scratch result back into the caller's board array in-place.
  // Replacing the board reference entirely wouldn't work because GameState
  // still holds the old reference.
  commitBoard(board, scratch);

  return steps;
}

// Pushes a new row of cracked discs up from the bottom.
// Game over is flagged if row 0 has any disc before the shift — those discs
// would be pushed off the top and lost, which counts as overflow.
export function computePushStep(
  board: Board,
  discFactory: DiscFactory = makeCrackedDisc,
): { step: PushStep; gameOver: boolean } {
  let gameOver = false;
  for (let c = 0; c < GRID_COLS; c++) {
    if (board[0]![c] !== null) { gameOver = true; break; }
  }

  const newRow: Disc[] = Array.from({ length: GRID_COLS }, discFactory);

  // Shift every row up by one index (row 0 content is discarded).
  for (let r = 0; r < GRID_ROWS - 1; r++) {
    board[r] = board[r + 1]!;
  }
  board[GRID_ROWS - 1] = newRow;

  // Clear resolution runs immediately after a push and can reveal these discs.
  // Keep the push event as a snapshot of what actually entered the board.
  return { step: { kind: StepKind.Push, newRow: newRow.map(disc => ({ ...disc })) }, gameOver };
}
