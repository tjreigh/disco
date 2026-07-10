import type { Board } from '../game/model.js';
import type { PhysicsStep } from '../game/events.js';
import { StepKind } from '../game/events.js';

/**
 * Applies one physics playback step to the visual board snapshot used for static
 * rendering. The board is mutated in place so callers can replay an entire turn
 * by feeding the returned step log through this helper in order.
 */
export function applyStepToVisualBoard(board: Board, step: PhysicsStep): void {
  switch (step.kind) {
    case StepKind.Drop:
      board[step.toLandRow]![step.col] = { ...step.disc };
      break;
    case StepKind.Clear:
      for (const pos of step.cleared) {
        board[pos.row]![pos.col] = null;
      }
      break;
    case StepKind.Reveal:
      // positions[i] and discs[i] are parallel; discs carry the post-physics
      // kind. The visual board's disc objects are separate clones so we update
      // kind by matching position rather than object identity.
      for (let i = 0; i < step.positions.length; i++) {
        const pos = step.positions[i]!;
        const disc = step.discs[i]!;
        const cell = board[pos.row]![pos.col];
        if (cell != null) cell.kind = disc.kind;
      }
      break;
    case StepKind.Fall:
      for (const move of step.moves) {
        board[move.to.row]![move.to.col] = board[move.from.row]![move.from.col]!;
        if (move.from.row !== move.to.row || move.from.col !== move.to.col) {
          board[move.from.row]![move.from.col] = null;
        }
      }
      break;
    case StepKind.Push:
      // Mirror what computePushStep does: shift rows up, place new row at bottom.
      for (let row = 0; row < board.length - 1; row++) board[row] = board[row + 1]!;
      board[board.length - 1] = step.newRow.map(disc => ({ ...disc }));
      break;
    case StepKind.Bonus:
      break;
  }
}
