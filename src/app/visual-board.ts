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
      board[step.landPos.row]![step.landPos.col] = { ...step.disc };
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
    case StepKind.Fall: {
      // Read every source cell before writing any destination — a chained
      // slide (e.g. the disc above falls into the cell the disc below is
      // simultaneously vacating) has one move's `to` equal another's `from`.
      // Applying moves one at a time in that case overwrites the second
      // disc before it's ever read: it vanishes, and the first disc's data
      // gets duplicated onto its cell instead.
      const sourceDiscs = step.moves.map(move => board[move.from.row]![move.from.col]);
      for (const move of step.moves) {
        board[move.from.row]![move.from.col] = null;
      }
      step.moves.forEach((move, i) => {
        board[move.to.row]![move.to.col] = sourceDiscs[i]!;
      });
      break;
    }
    case StepKind.Push: {
      // Mirror computePushStep exactly: new discs enter from step.edge (the
      // side gravity currently pulls toward), shifting the board toward the
      // opposite edge. 'top'/'bottom' is a row shift (indexed by column);
      // 'left'/'right' is a column shift (indexed by row).
      const rows = board.length;
      const cols = board[0]!.length;
      const newDiscs = step.newDiscs.map(disc => ({ ...disc }));
      if (step.edge === 'bottom') {
        for (let r = 0; r < rows - 1; r++) board[r] = board[r + 1]!;
        board[rows - 1] = newDiscs;
      } else if (step.edge === 'top') {
        for (let r = rows - 1; r > 0; r--) board[r] = board[r - 1]!;
        board[0] = newDiscs;
      } else if (step.edge === 'right') {
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
      break;
    }
    case StepKind.Bonus:
      break;
  }
}
