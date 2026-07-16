import type { Board, Disc, GridPos } from './model.js';
import { DiscKind } from './model.js';
import type { GameModeConfig } from './modes/mode.js';
import type { PhysicsStep, DropStep, FallStep, ClearStep, PushStep } from './events.js';
import { StepKind } from './events.js';
import {
  cloneBoard, countHorizontalRun, countVerticalRun, deepCloneBoard,
  landingRow, placeDisc, removeDisc, applyGravity,
} from './board.js';
import type { EntryEdge } from './gravity.js';
import {
  entryEdgeForAngle, isLaneFull, entryPositionForLane, offBoardEntryPosition,
  oppositeEdge, settleContinuous,
} from './gravity.js';
import { makeCrackedDisc } from './disc.js';
import type { DiscFactory } from './disc.js';
import { CLASSIC_MODE } from './modes/index.js';

/** Compacts a board toward a gravity direction, producing a Fall step of every disc that moved. */
export type SettleFn = (board: Board) => FallStep;

// Returns every position that should clear this pass.
// A disc clears according to the mode's isClearable predicate (for Classic:
// its value equals the contiguous horizontal or vertical run containing it).
// Gaps separate runs; remote discs do not keep an isolated 1 alive.
// The scan is a single row-major pass over every (row, col) exactly once, so a
// disc qualifying via both its row-run and its column-run still produces at
// most one push into `result` — there is no duplicate source to guard against.
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

function inspectClears(
  board: Board, mode: GameModeConfig, angleDeg: number,
): { clears: GridPos[]; checks: ClearCheck[] } {
  const result: GridPos[] = [];
  const checks: ClearCheck[] = [];

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
        if (!mode.isClearable(board, row, col, disc, angleDeg)) continue;
        result.push({ row, col });
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

function isBoardEmpty(board: Board): boolean {
  return board.every(row => row.every(cell => cell === null));
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

/** Points awarded for a completed Stack-mode cascade. */
export function pointsForStack(stackSize: number, pointsPerStackUnit: number): number {
  if (!Number.isInteger(stackSize) || stackSize < 1) return 0;
  return pointsPerStackUnit * stackSize * stackSize;
}

// Resolves every clear/reveal/fall chain on a board that has already changed.
// This is shared by normal drops and row pushes: a push changes every column's
// disc count, so leaving it unresolved makes an eligible disc clear during the
// next, potentially unrelated, drop.
//
// Steps/frames invariant (relied on by the UI to map playback position to
// trace.frames): every PhysicsStep produced across a turn, except Bonus, pairs
// with exactly one trace.frames entry. Drop, Clear, and Push steps always push
// a frame unconditionally right alongside them (Drop and Push happen outside
// this function, in computeDropSteps and the engine's push handling, but the
// same rule applies there). Reveal and Fall steps are each pushed under the
// same `length > 0` guard as their frame below, so the step and its frame
// either both fire or neither does. Bonus steps — the board-clear bonus here
// and the engine's level bonus — never emit a frame, since a bonus doesn't
// change the board and so has nothing new to render.
function resolveClearSteps(
  scratch: Board, mode: GameModeConfig, trace?: PhysicsTrace,
  settle: SettleFn = applyGravity, angleDeg = 0, startingChainLevel = 0,
): PhysicsStep[] {
  const steps: PhysicsStep[] = [];
  let chainLevel = startingChainLevel;

  while (true) {
    const inspection = inspectClears(scratch, mode, angleDeg);
    const clears = inspection.clears;
    trace?.scans.push({
      chainLevel,
      checks: inspection.checks,
      clears: clears.map(pos => ({ ...pos })),
    });
    if (clears.length === 0) break;

    const points = mode.scoring.kind === 'chain'
      ? clears.length * pointsForChain(chainLevel + 1, mode.pointsPerDisc, mode.chainExponent)
      : 0;
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

    const fall = settle(scratch);
    if (fall.moves.length > 0) {
      steps.push(fall);
      trace?.frames.push({ label: `Gravity: ${fall.moves.length} move${fall.moves.length === 1 ? '' : 's'}`, board: deepCloneBoard(scratch) });
    }


    if (mode.boardClearBonus > 0 && isBoardEmpty(scratch)) {
      steps.push({
        kind: StepKind.Bonus,
        bonusKind: 'board-clear',
        pointsAwarded: mode.boardClearBonus,
      });
    }

    chainLevel++;
  }

  return steps;
}

/** Resolves clear chains after an in-place board change such as a row push. */
export function computeClearSteps(
  board: Board, mode: GameModeConfig = CLASSIC_MODE, trace?: PhysicsTrace,
  settle: SettleFn = applyGravity, angleDeg = 0, startingChainLevel = 0,
): PhysicsStep[] {
  const scratch = cloneBoard(board);
  const steps = resolveClearSteps(scratch, mode, trace, settle, angleDeg, startingChainLevel);
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
  settle: SettleFn = applyGravity,
  startingChainLevel = 0,
): PhysicsStep[] {
  const steps: PhysicsStep[] = [];
  const scratch = cloneBoard(board);

  const row = landingRow(scratch, col);
  if (row === null) return steps; // column full — game over handled by caller

  placeDisc(scratch, row, col, disc);
  // The dropped board object may be revealed later in this same synchronous turn.
  // Preserve how it looked at drop time for animation playback.
  steps.push({
    kind: StepKind.Drop, disc: { ...disc },
    entryPos: { row: -1, col }, landPos: { row, col },
  } satisfies DropStep);
  trace?.frames.push({ label: `Drop #${disc.id} into r${row + 1}c${col + 1}`, board: deepCloneBoard(scratch) });
  steps.push(...resolveClearSteps(scratch, mode, trace, settle, 0, startingChainLevel));

  // Write the scratch result back into the caller's board array in-place.
  // Replacing the board reference entirely wouldn't work because GameState
  // still holds the old reference.
  commitBoard(board, scratch);

  return steps;
}

// Gravity-mode equivalent of computeDropSteps: the disc enters through
// whichever edge/lane corresponds to entryEdge, then the *whole* board
// (including the new disc) settles once under finalAngleDeg — gravity mode
// can rearrange already-placed discs, not just the new one. The new disc's
// own move is folded into the Drop step's landPos (so it animates as one
// smooth motion straight to its true resting cell, same as Classic); every
// other disc's move is reported as a separate Fall step, reusing the
// existing (already direction-agnostic) Fall animation untouched.
export function computeGravityDropSteps(
  board: Board,
  disc: Disc,
  lane: number,
  entryEdge: EntryEdge,
  finalAngleDeg: number,
  mode: GameModeConfig = CLASSIC_MODE,
  trace?: PhysicsTrace,
): PhysicsStep[] {
  const steps: PhysicsStep[] = [];
  const scratch = cloneBoard(board);
  const rows = scratch.length;
  const cols = scratch[0]!.length;

  if (isLaneFull(scratch, lane, entryEdge)) return steps; // lane full — game over handled by caller

  const onEntryPos = entryPositionForLane(entryEdge, lane, rows, cols);
  placeDisc(scratch, onEntryPos.row, onEntryPos.col, disc);

  const settle: SettleFn = b => settleContinuous(b, finalAngleDeg);
  const settleResult = settle(scratch);
  const newDiscMove = settleResult.moves.find(m => m.disc.id === disc.id);
  const landPos = newDiscMove ? newDiscMove.to : onEntryPos;
  const otherMoves = settleResult.moves.filter(m => m.disc.id !== disc.id);

  steps.push({
    kind: StepKind.Drop, disc: { ...disc },
    entryPos: offBoardEntryPosition(entryEdge, lane, rows, cols), landPos,
  } satisfies DropStep);
  trace?.frames.push({ label: `Drop #${disc.id} into r${landPos.row + 1}c${landPos.col + 1}`, board: deepCloneBoard(scratch) });

  if (otherMoves.length > 0) {
    steps.push({ kind: StepKind.Fall, moves: otherMoves } satisfies FallStep);
    trace?.frames.push({ label: `Gravity: ${otherMoves.length} move${otherMoves.length === 1 ? '' : 's'}`, board: deepCloneBoard(scratch) });
  }

  steps.push(...resolveClearSteps(scratch, mode, trace, settle, finalAngleDeg));

  commitBoard(board, scratch);
  return steps;
}

// Gravity-mode tilt-only turn: no new disc, but the whole board resettles
// under the (possibly changed) gravity angle, then normal clear/chain
// resolution runs. Mirrors computeGravityDropSteps minus the disc entry.
export function computeGravityTiltSteps(
  board: Board,
  finalAngleDeg: number,
  mode: GameModeConfig = CLASSIC_MODE,
  trace?: PhysicsTrace,
): PhysicsStep[] {
  const steps: PhysicsStep[] = [];
  const scratch = cloneBoard(board);
  const settle: SettleFn = b => settleContinuous(b, finalAngleDeg);

  const fall = settle(scratch);
  if (fall.moves.length > 0) {
    steps.push(fall);
    trace?.frames.push({ label: `Tilt: ${fall.moves.length} move${fall.moves.length === 1 ? '' : 's'}`, board: deepCloneBoard(scratch) });
  }

  steps.push(...resolveClearSteps(scratch, mode, trace, settle, finalAngleDeg));

  commitBoard(board, scratch);
  return steps;
}

/** True when any cell along this edge (the one about to be shifted off / discarded) is occupied. */
function edgeHasDisc(board: Board, edge: EntryEdge): boolean {
  const rows = board.length;
  const cols = board[0]!.length;
  switch (edge) {
    case 'top': return board[0]!.some(cell => cell != null);
    case 'bottom': return board[rows - 1]!.some(cell => cell != null);
    case 'left': return board.some(row => row[0] != null);
    case 'right': return board.some(row => row[cols - 1] != null);
  }
}

// Pushes a new row (or column) of cracked discs in from whichever edge
// gravity currently pulls TOWARD — Classic (angleDeg 0, entry edge 'top')
// always enters from the bottom, same as before; Gravity mode's floor edge
// changes with the tilt, same as a drop's entry edge does, via
// entryEdgeForAngle/oppositeEdge. Game over is flagged if the OPPOSITE edge
// (where a drop enters, and where a full pile would spill off the board) has
// any disc before the shift — those discs would be pushed off and lost,
// which counts as overflow. This is deliberately a direct edge-occupancy
// check, not mode.isGameOver(board) (which for Gravity mode is a full-board
// scan serving a different, more general purpose elsewhere) — a push's
// overflow condition is specifically about the one edge THIS push discards.
export function computePushStep(
  board: Board,
  discFactory: DiscFactory = makeCrackedDisc,
  angleDeg = 0,
): { step: PushStep; gameOver: boolean } {
  const rows = board.length;
  const cols = board[0]!.length;

  const entryEdge = entryEdgeForAngle(angleDeg);
  const floorEdge = oppositeEdge(entryEdge);
  const gameOver = edgeHasDisc(board, entryEdge);

  let newDiscs: Disc[];

  if (floorEdge === 'bottom' || floorEdge === 'top') {
    newDiscs = Array.from({ length: cols }, discFactory);
    if (floorEdge === 'bottom') {
      for (let r = 0; r < rows - 1; r++) board[r] = board[r + 1]!;
      board[rows - 1] = newDiscs;
    } else {
      for (let r = rows - 1; r > 0; r--) board[r] = board[r - 1]!;
      board[0] = newDiscs;
    }
  } else {
    newDiscs = Array.from({ length: rows }, discFactory);
    if (floorEdge === 'right') {
      for (let r = 0; r < rows; r++) {
        const row = board[r]!;
        for (let c = 0; c < cols - 1; c++) row[c] = row[c + 1]!;
        row[cols - 1] = newDiscs[r]!;
      }
    } else {
      for (let r = 0; r < rows; r++) {
        const row = board[r]!;
        for (let c = cols - 1; c > 0; c--) row[c] = row[c - 1]!;
        row[0] = newDiscs[r]!;
      }
    }
  }

  // Clear resolution runs immediately after a push and can reveal these discs.
  // Keep the push event as a snapshot of what actually entered the board.
  return {
    step: { kind: StepKind.Push, edge: floorEdge, newDiscs: newDiscs.map(disc => ({ ...disc })) },
    gameOver,
  };
}
