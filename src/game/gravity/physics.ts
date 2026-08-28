import { cloneBoard, deepCloneBoard, placeDisc } from '../board.js';
import type { DropStep, FallStep, PhysicsStep } from '../events.js';
import { StepKind } from '../events.js';
import type { Board, Disc, EntryEdge } from '../model.js';
import { GRAVITY_RULES } from '../modes/index.js';
import type { GameRulesConfig } from '../modes/mode.js';
import {
  commitBoard, resolveClearSteps, type PhysicsTrace, type SettleFn,
} from '../physics.js';
import {
  entryPositionForLane, isLaneFull, offBoardEntryPosition, settleContinuous,
} from './settling.js';

/**
 * Physics steps for a Gravity-mode drop: the disc enters through the selected
 * edge, the whole board settles once under the committed angle, then clear
 * chains resolve.
 */
export function computeGravityDropSteps(
  board: Board,
  disc: Disc,
  lane: number,
  entryEdge: EntryEdge,
  finalAngleDeg: number,
  rules: GameRulesConfig = GRAVITY_RULES,
  trace?: PhysicsTrace,
): PhysicsStep[] {
  const steps: PhysicsStep[] = [];
  const scratch = cloneBoard(board);
  const rows = scratch.length;
  const cols = scratch[0]!.length;

  if (isLaneFull(scratch, lane, entryEdge)) return steps;

  const onEntryPos = entryPositionForLane(entryEdge, lane, rows, cols);
  placeDisc(scratch, onEntryPos.row, onEntryPos.col, disc);

  const settle: SettleFn = b => settleContinuous(b, finalAngleDeg);
  const settleResult = settle(scratch);
  const newDiscMove = settleResult.moves.find(move => move.disc.id === disc.id);
  const landPos = newDiscMove ? newDiscMove.to : onEntryPos;
  const otherMoves = settleResult.moves.filter(move => move.disc.id !== disc.id);

  steps.push({
    kind: StepKind.Drop,
    disc: { ...disc },
    entryPos: offBoardEntryPosition(entryEdge, lane, rows, cols),
    landPos,
  } satisfies DropStep);
  trace?.frames.push({
    label: `Drop #${disc.id} into r${landPos.row + 1}c${landPos.col + 1}`,
    board: deepCloneBoard(scratch),
  });

  if (otherMoves.length > 0) {
    steps.push({ kind: StepKind.Fall, moves: otherMoves } satisfies FallStep);
    trace?.frames.push({
      label: `Gravity: ${otherMoves.length} move${otherMoves.length === 1 ? '' : 's'}`,
      board: deepCloneBoard(scratch),
    });
  }

  steps.push(...resolveClearSteps(scratch, rules, trace, settle, finalAngleDeg));
  commitBoard(board, scratch);
  return steps;
}

/**
 * Physics steps for a tilt with no drop.
 *
 * @remarks
 * A primitive for scripted and diagnostic callers; normal Gravity turns always
 * include a drop.
 */
export function computeGravityTiltSteps(
  board: Board,
  finalAngleDeg: number,
  rules: GameRulesConfig = GRAVITY_RULES,
  trace?: PhysicsTrace,
): PhysicsStep[] {
  const steps: PhysicsStep[] = [];
  const scratch = cloneBoard(board);
  const settle: SettleFn = b => settleContinuous(b, finalAngleDeg);

  const fall = settle(scratch);
  if (fall.moves.length > 0) {
    steps.push(fall);
    trace?.frames.push({
      label: `Tilt: ${fall.moves.length} move${fall.moves.length === 1 ? '' : 's'}`,
      board: deepCloneBoard(scratch),
    });
  }

  steps.push(...resolveClearSteps(scratch, rules, trace, settle, finalAngleDeg));
  commitBoard(board, scratch);
  return steps;
}
