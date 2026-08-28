import type { Board, Disc, EntryEdge, GridPos } from './model.js';
import { DiscKind } from './model.js';
import type { GameRulesConfig } from './modes/mode.js';
import type { PhysicsStep, DropStep, FallStep, ClearStep, PushStep } from './events.js';
import { StepKind } from './events.js';
import {
  cloneBoard, countHorizontalRun, countVerticalRun, deepCloneBoard,
  isBoardEmpty, landingRow, placeDisc, removeDisc, applyGravity,
} from './board.js';
import {
  entryEdgeForAngle, oppositeEdge,
} from './gravity/settling.js';
import { makeCrackedDisc } from './disc.js';
import type { DiscFactory } from './disc.js';
import { CLASSIC_RULES } from './modes/index.js';
import { pointsForChain } from './scoring/formulas.js';

/** Compacts a board toward a gravity direction, producing a Fall step of every disc that moved. */
export type SettleFn = (board: Board) => FallStep;

/**
 * One position the clear-check scan flagged as eligible to clear this pass.
 *
 * @remarks
 * Eligibility follows the mode's `isClearable` predicate (Classic: value equals
 * the contiguous row or column run). The scan is one row-major pass over every
 * cell, so a disc qualifying via both axes still produces just one entry.
 */
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
  board: Board, rules: GameRulesConfig, angleDeg: number,
): { clears: GridPos[]; checks: ClearCheck[] } {
  const result: GridPos[] = [];
  const checks: ClearCheck[] = [];

  for (let row = 0; row < board.length; row++) {
    for (let col = 0; col < board[row]!.length; col++) {
      const disc = board[row]![col];
      if (disc && disc.kind === DiscKind.Numbered) {
        // rowCount/colCount are still computed via the classic contiguous-run
        // helpers for trace/debug purposes, independent of which predicate
        // rules.clearing.isClearable actually uses.
        const rowCount = countHorizontalRun(board, row, col);
        const colCount = countVerticalRun(board, row, col);
        const clearsByRow = disc.value === rowCount;
        const clearsByCol = disc.value === colCount;
        checks.push({
          pos: { row, col }, discId: disc.id, value: disc.value,
          rowCount, colCount, clearsByRow, clearsByCol,
        });
        if (!rules.clearing.isClearable(board, row, col, disc, angleDeg)) continue;
        result.push({ row, col });
      }
    }
  }

  return { clears: result, checks };
}

export function commitBoard(target: Board, source: Board): void {
  for (let r = 0; r < target.length; r++) {
    for (let c = 0; c < target[r]!.length; c++) {
      target[r]![c] = source[r]![c]!;
    }
  }
}

/**
 * Resolves every clear/reveal/fall chain on a board that has already changed.
 *
 * @remarks
 * Shared by drops and row pushes — a push changes every column's disc count, so
 * leaving it unresolved lets an eligible disc clear during the next, unrelated,
 * drop.
 *
 * Steps/frames invariant (the UI maps playback position to `trace.frames` via
 * it): every {@link PhysicsStep} except Bonus pairs with exactly one
 * `trace.frames` entry. Drop/Clear/Push always push a frame alongside the step
 * (Drop and Push outside this function, same rule). Reveal and Fall push step
 * and frame under one shared `length > 0` guard. Bonus steps never emit a frame
 * — nothing on the board changed.
 */
export function resolveClearSteps(
  scratch: Board, rules: GameRulesConfig, trace?: PhysicsTrace,
  settle: SettleFn = applyGravity, angleDeg = 0, startingChainLevel = 0,
): PhysicsStep[] {
  const steps: PhysicsStep[] = [];
  let chainLevel = startingChainLevel;

  while (true) {
    const inspection = inspectClears(scratch, rules, angleDeg);
    const clears = inspection.clears;
    trace?.scans.push({
      chainLevel,
      checks: inspection.checks,
      clears: clears.map(pos => ({ ...pos })),
    });
    if (clears.length === 0) break;

    const points = rules.scoring.kind === 'chain-score@1'
      ? clears.length * pointsForChain(
        chainLevel + 1,
        rules.scoring.pointsPerDisc,
        rules.scoring.chainExponent,
      )
      : 0;
    // Capture immutable playback values before removeDisc() makes the positions null.
    const clearedDiscs = clears.map(pos => ({ ...scratch[pos.row]![pos.col]! }));
    steps.push({ kind: StepKind.Clear, cleared: clears, discs: clearedDiscs, chainLevel, pointsAwarded: points } satisfies ClearStep);

    for (const pos of clears) removeDisc(scratch, pos);
    trace?.frames.push({
      label: `Clear chain ${chainLevel}: ${clears.length} tile${clears.length === 1 ? '' : 's'}`,
      board: deepCloneBoard(scratch),
    });

    const reveal = rules.revealing.revealAdjacent(scratch, clears);
    if (reveal.positions.length > 0) {
      steps.push(reveal);
      trace?.frames.push({ label: `Reveal ${reveal.positions.length} adjacent tile${reveal.positions.length === 1 ? '' : 's'}`, board: deepCloneBoard(scratch) });
    }

    const fall = settle(scratch);
    if (fall.moves.length > 0) {
      steps.push(fall);
      trace?.frames.push({ label: `Gravity: ${fall.moves.length} move${fall.moves.length === 1 ? '' : 's'}`, board: deepCloneBoard(scratch) });
    }


    if (rules.scoring.boardClearBonus > 0 && isBoardEmpty(scratch)) {
      steps.push({
        kind: StepKind.Bonus,
        bonusKind: 'board-clear',
        pointsAwarded: rules.scoring.boardClearBonus,
      });
    }

    chainLevel++;
  }

  return steps;
}

/** Resolves clear chains after an in-place board change such as a row push. */
export function computeClearSteps(
  board: Board, rules: GameRulesConfig = CLASSIC_RULES, trace?: PhysicsTrace,
  settle: SettleFn = applyGravity, angleDeg = 0, startingChainLevel = 0,
): PhysicsStep[] {
  const scratch = cloneBoard(board);
  const steps = resolveClearSteps(scratch, rules, trace, settle, angleDeg, startingChainLevel);
  commitBoard(board, scratch);
  return steps;
}

/**
 * Runs all physics for one drop on a scratch board, returns an ordered
 * {@link PhysicsStep} array for playback, and commits the final state to the
 * caller's board.
 *
 * @remarks
 * The board is settled before any animation starts, so losing focus
 * mid-animation leaves it already correct.
 */
export function computeDropSteps(
  board: Board,
  disc: Disc,
  col: number,
  rules: GameRulesConfig = CLASSIC_RULES,
  trace?: PhysicsTrace,
  settle: SettleFn = applyGravity,
  startingChainLevel = 0,
  ownerId?: string,
): PhysicsStep[] {
  const steps: PhysicsStep[] = [];
  const scratch = cloneBoard(board);

  const row = landingRow(scratch, col);
  if (row === null) return steps; // column full — game over handled by caller

  const placedDisc: Disc = ownerId !== undefined
    ? { ...disc, ownerId }
    : disc;
  placeDisc(scratch, row, col, placedDisc);
  // The dropped board object may be revealed later in this same synchronous turn.
  // Preserve how it looked at drop time for animation playback.
  steps.push({
    kind: StepKind.Drop, disc: { ...placedDisc },
    entryPos: { row: -1, col }, landPos: { row, col },
  } satisfies DropStep);
  trace?.frames.push({ label: `Drop #${disc.id} into r${row + 1}c${col + 1}`, board: deepCloneBoard(scratch) });
  steps.push(...resolveClearSteps(scratch, rules, trace, settle, 0, startingChainLevel));

  // Write the scratch result back into the caller's board array in-place.
  // Replacing the board reference entirely wouldn't work because GameState
  // still holds the old reference.
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

/**
 * Pushes a new row (or column) of cracked discs in from the edge gravity
 * currently pulls toward.
 *
 * @remarks
 * Classic always enters from the bottom; Gravity's floor edge follows the tilt
 * (`entryEdgeForAngle` / `oppositeEdge`). Game over if the opposite edge already
 * holds a disc before the shift — it would be pushed off and lost. A direct
 * edge-occupancy check, not the full-board failure rule.
 */
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
