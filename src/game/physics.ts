import type { Board, Disc, GridPos } from './model.js';
import { DiscKind } from './model.js';
import type { GameModeConfig } from './modes/mode.js';
import type { PhysicsStep, DropStep, ClearStep, PushStep } from './events.js';
import { StepKind } from './events.js';
import {
  cloneBoard, countHorizontalRun, countVerticalRun, deepCloneBoard,
  landingRow, placeDisc, removeDisc, applyGravity,
} from './board.js';
import { makeCrackedDisc } from './disc.js';
import type { DiscFactory } from './disc.js';
import { CLASSIC_MODE } from './modes/index.js';

// Returns every position that should clear this pass.
// A disc clears according to the mode's isClearable predicate (for Classic:
// its value equals the contiguous horizontal or vertical run containing it).
// Gaps separate runs; remote discs do not keep an isolated 1 alive.
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

function inspectClears(board: Board, mode: GameModeConfig): { clears: GridPos[]; checks: ClearCheck[] } {
  const seen = new Set<string>();
  const result: GridPos[] = [];
  const checks: ClearCheck[] = [];

  const key = (r: number, c: number) => `${r},${c}`;

  for (let row = 0; row < board.length; row++) {
    for (let col = 0; col < board[row]!.length; col++) {
      const disc = board[row]![col];
      if (disc && disc.kind === DiscKind.Numbered) {
        // rowCount/colCount are still computed via the classic contiguous-run
        // helpers for trace/debug purposes, independent of which predicate
        // mode.isClearable actually uses.
        const rowCount = countHorizontalRun(board, row, col);
        const colCount = countVerticalRun(board, row, col);
        const clearsByRow = disc.value === rowCount;
        const clearsByCol = disc.value === colCount;
        checks.push({
          pos: { row, col }, discId: disc.id, value: disc.value,
          rowCount, colCount, clearsByRow, clearsByCol,
        });
        if (!mode.isClearable(board, row, col, disc)) continue;
        const k = key(row, col);
        if (!seen.has(k)) { seen.add(k); result.push({ row, col }); }
      }
    }
  }

  return { clears: result, checks };
}

function commitBoard(target: Board, source: Board): void {
  for (let r = 0; r < target.length; r++) {
    for (let c = 0; c < target[r]!.length; c++) {
      target[r]![c] = source[r]![c]!;
    }
  }
}

/** Points awarded per cleared disc at a one-based chain length. */
export function pointsForChain(
  chainLength: number,
  pointsPerDisc: number = CLASSIC_MODE.pointsPerDisc,
  exponent: number = CLASSIC_MODE.chainExponent,
): number {
  if (!Number.isInteger(chainLength) || chainLength < 1) return 0;
  return Math.floor(pointsPerDisc * Math.pow(chainLength, exponent));
}

// Resolves every clear/reveal/fall chain on a board that has already changed.
// This is shared by normal drops and row pushes: a push changes every column's
// disc count, so leaving it unresolved makes an eligible disc clear during the
// next, potentially unrelated, drop.
function resolveClearSteps(scratch: Board, mode: GameModeConfig, trace?: PhysicsTrace): PhysicsStep[] {
  const steps: PhysicsStep[] = [];
  let chainLevel = 0;

  while (true) {
    const inspection = inspectClears(scratch, mode);
    const clears = inspection.clears;
    trace?.scans.push({
      chainLevel,
      checks: inspection.checks,
      clears: clears.map(pos => ({ ...pos })),
    });
    if (clears.length === 0) break;

    const points = clears.length * pointsForChain(chainLevel + 1, mode.pointsPerDisc, mode.chainExponent);
    // Capture immutable playback values before removeDisc() makes the positions null.
    const clearedDiscs = clears.map(pos => ({ ...scratch[pos.row]![pos.col]! }));
    steps.push({ kind: StepKind.Clear, cleared: clears, discs: clearedDiscs, chainLevel, pointsAwarded: points } satisfies ClearStep);

    for (const pos of clears) removeDisc(scratch, pos);
    trace?.frames.push({
      label: `Clear chain ${chainLevel}: ${clears.length} tile${clears.length === 1 ? '' : 's'}`,
      board: deepCloneBoard(scratch),
    });

    const reveal = mode.revealAdjacent(scratch, clears);
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
export function computeClearSteps(board: Board, mode: GameModeConfig = CLASSIC_MODE, trace?: PhysicsTrace): PhysicsStep[] {
  const scratch = cloneBoard(board);
  const steps = resolveClearSteps(scratch, mode, trace);
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
  mode: GameModeConfig = CLASSIC_MODE,
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
  steps.push(...resolveClearSteps(scratch, mode, trace));

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
  mode: GameModeConfig = CLASSIC_MODE,
): { step: PushStep; gameOver: boolean } {
  const rows = board.length;
  const cols = board[0]!.length;

  const gameOver = mode.isGameOver(board);

  const newRow: Disc[] = Array.from({ length: cols }, discFactory);

  // Shift every row up by one index (row 0 content is discarded).
  for (let r = 0; r < rows - 1; r++) {
    board[r] = board[r + 1]!;
  }
  board[rows - 1] = newRow;

  // Clear resolution runs immediately after a push and can reveal these discs.
  // Keep the push event as a snapshot of what actually entered the board.
  return { step: { kind: StepKind.Push, newRow: newRow.map(disc => ({ ...disc })) }, gameOver };
}
