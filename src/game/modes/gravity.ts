import type { Board, Disc } from '../model.js';
import { DiscKind } from '../model.js';
import type { GameModeConfig } from './mode.js';
import { isBoardFull } from '../board.js';
import { gravityRunLengths } from '../gravity.js';
import { CLASSIC_MODE } from './classic.js';

// Gravity mode's entry edge can be any of the 4 sides, so a continuous-angle
// settle can leave gaps a single-edge check would miss — a genuine full-board
// scan is the only correct terminal condition here.
function gravityIsGameOver(board: Board): boolean {
  return isBoardFull(board);
}

// Runs are measured along the CURRENT gravity angle (the same angle the
// board was just settled under — see gravityRunLengths), not always grid
// rows/columns like Classic. Settling packs discs into diagonal "staircases"
// at non-cardinal angles; checking grid-aligned runs against a diagonally
// packed pile made clears (and chains especially, which are several clears
// in a row) look arbitrary to the player, disconnected from how the pile
// actually formed. The angle snaps to the nearest of 8 directions for this
// check specifically (settling itself stays fully continuous) — a genuinely
// continuous run check turns out not to be well-defined on a discrete grid
// except at cardinal/diagonal angles, see gravityRunLengths. angleDeg
// defaults to 0 (straight down, i.e. identical to Classic) for any caller
// that doesn't have a current angle to pass.
function gravityIsClearable(board: Board, row: number, col: number, disc: Disc, angleDeg = 0): boolean {
  if (disc.kind !== DiscKind.Numbered) return false;
  const { alongGravity, crossGravity } = gravityRunLengths(board, row, col, angleDeg);
  return disc.value === alongGravity || disc.value === crossGravity;
}

// Reuses Classic's revealAdjacent (cracked-disc degrade stays orthogonal in
// the upright grid regardless of gravity angle — a visual-adjacency rule,
// not a physics one, per the design doc) and scoring/generation tuning —
// first-slice recommendation is to prove out gravity mastery on otherwise-
// familiar rules before tuning difficulty separately.
export const GRAVITY_MODE: GameModeConfig = {
  ...CLASSIC_MODE,
  id: 'gravity',
  name: 'Gravity',
  tagline: 'Drop or tilt — gravity changes at will.',
  gravity: { initialAngleDeg: 0, maxTiltDeltaDeg: 45 },
  isClearable: gravityIsClearable,
  isGameOver: gravityIsGameOver,
};
