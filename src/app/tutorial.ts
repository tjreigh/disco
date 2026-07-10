import type { PhysicsStep } from '../game/events.js';
import { StepKind } from '../game/events.js';
import { makeDisc } from '../game/disc.js';
import { DiscKind, type Board, type Disc } from '../game/model.js';

export interface TutorialSuccess {
  accepted?: boolean;
  clearCountAtLeast?: number;
  revealCountAtLeast?: number;
  chainLengthAtLeast?: number;
}

export interface TutorialStep {
  readonly id: string;
  readonly title: string;
  readonly prompt: string;
  readonly board: Board;
  readonly currentDisc: Disc;
  readonly nextDisc: Disc;
  /** Allowed LANES — a column index for top/bottom entry, a row index for left/right (see GameEngine.drop). Empty means no drop is accepted at all — the step requires a tilt instead. */
  readonly allowedCols: readonly number[];
  readonly success: TutorialSuccess;
  /** Gravity-mode steps only: starting angle, defaulting to the mode's initialAngleDeg (0) when omitted — e.g. a step that wants the board pre-tilted before the player acts. */
  readonly gravityAngleDeg?: number;
}

export interface TutorialDefinition {
  readonly id: string;
  readonly title: string;
  readonly steps: readonly TutorialStep[];
}

/** The smallest result shape needed by the tutorial evaluator. */
export interface TutorialTurnResult {
  readonly accepted: boolean;
  readonly steps: readonly PhysicsStep[];
}

function emptyBoard(): Board {
  return Array.from({ length: 7 }, () => Array<Disc | null>(7).fill(null));
}

function numbered(value: number): Disc {
  return makeDisc(value, DiscKind.Numbered);
}

function cracked(value: number): Disc {
  return makeDisc(value, DiscKind.DoubleCracked);
}

function step(
  id: string,
  title: string,
  prompt: string,
  tutorialBoard: Board,
  currentDisc: Disc,
  nextDisc: Disc,
  allowedCols: readonly number[],
  success: TutorialSuccess,
  gravityAngleDeg?: number,
): TutorialStep {
  return {
    id, title, prompt, board: tutorialBoard, currentDisc, nextDisc, allowedCols, success,
    ...(gravityAngleDeg !== undefined ? { gravityAngleDeg } : {}),
  };
}

const rowBoard = emptyBoard();
rowBoard[6] = [numbered(3), numbered(3), null, null, null, null, null];

const columnBoard = emptyBoard();
columnBoard[6]![2] = numbered(3);
columnBoard[5]![2] = numbered(3);

const revealBoard = emptyBoard();
revealBoard[6]![2] = numbered(2);
revealBoard[6]![3] = cracked(4);

const chainBoard = emptyBoard();
chainBoard[4]![0] = numbered(2);
chainBoard[5]![0] = numbered(2);
chainBoard[6]![0] = numbered(5);
chainBoard[6]![1] = numbered(6);

export const CLASSIC_TUTORIAL: TutorialDefinition = {
  id: 'classic',
  title: 'Classic Tutorial',
  steps: [
    step('row-clear', 'Clear a row', 'Drop the 3 in the highlighted column to complete the horizontal run.', rowBoard, numbered(3), numbered(4), [2], { accepted: true, clearCountAtLeast: 1 }),
    step('column-clear', 'Clear a column', 'Drop the 3 in the highlighted column to complete the vertical run.', columnBoard, numbered(3), numbered(4), [2], { accepted: true, clearCountAtLeast: 1 }),
    step('cracked-reveal', 'Reveal a cracked disc', 'Drop the 2 in the highlighted column to clear beside the cracked disc.', revealBoard, numbered(2), numbered(3), [2], { accepted: true, clearCountAtLeast: 1, revealCountAtLeast: 1 }),
    step('chain-reaction', 'Start a chain reaction', 'Drop the 2 in the highlighted column to clear a row and make the upper 2 fall into a chain.', chainBoard, numbered(2), numbered(3), [1], { accepted: true, clearCountAtLeast: 2, chainLengthAtLeast: 2 }),
  ],
};

// ─── Gravity tutorial ───────────────────────────────────────────────────────
// Every board here was verified against the real engine (computeGravityDropSteps
// / computeGravityTiltSteps) before being written down here, not hand-derived —
// see gravity-mode-implementation session notes for why that discipline matters
// for this mode specifically.

const gravityDropBoard = emptyBoard();
gravityDropBoard[6]![2] = numbered(3);
gravityDropBoard[5]![2] = numbered(3);

// Empty on purpose — this step is about the aim-then-confirm interaction
// itself (Q/E to adjust, Escape cancels free, only confirming spends the
// turn), not about a specific board outcome. A disc placed anywhere that
// isn't already resting under 0deg gravity would render as visibly floating
// on load (loadScriptedState never auto-settles a scripted board), which is
// exactly the kind of "looks broken" moment this whole tutorial exists to
// head off.
const gravityTiltPracticeBoard = emptyBoard();

// Three "9" (never matches a real run length up to 7, so it's inert filler)
// discs prop three "3" discs up to different heights in three different
// columns — each is independently resting under 0deg gravity (settled, not
// floating), so no run forms yet (grid rows/columns each see the 3s as
// isolated). But (row4,col0), (row5,col1), (row6,col2) all share the same
// depth along a 45deg diagonal — tilting there needs no movement at all,
// just reveals that these three were already a line along that axis. The
// purest version of the core lesson: clearing checks the CURRENT gravity
// direction, not always up/down — same board, different angle.
const gravityRevealBoard = emptyBoard();
gravityRevealBoard[6]![0] = numbered(9);
gravityRevealBoard[5]![0] = numbered(9);
gravityRevealBoard[4]![0] = numbered(3);
gravityRevealBoard[6]![1] = numbered(9);
gravityRevealBoard[5]![1] = numbered(3);
gravityRevealBoard[6]![2] = numbered(3);

// Pre-tilted to 90deg (entry edge 'left', lanes are ROWS) with two 3s already
// packed toward the right side of row 3 — dropping into row 3 enters from the
// left and slides right to complete a run of 3.
const gravityDropUnderTiltBoard = emptyBoard();
gravityDropUnderTiltBoard[3]![5] = numbered(3);
gravityDropUnderTiltBoard[3]![6] = numbered(3);

export const GRAVITY_TUTORIAL: TutorialDefinition = {
  id: 'gravity',
  title: 'Gravity Tutorial',
  steps: [
    step(
      'drop-like-classic', 'Drop, same as always',
      'With no tilt, dropping works exactly like Classic. Drop the 3 in the highlighted column to complete the vertical run.',
      gravityDropBoard, numbered(3), numbered(4), [2], { accepted: true, clearCountAtLeast: 1 },
    ),
    step(
      'tilt-is-a-turn', 'Tilting is its own turn',
      'Press Q/E to start tilting — adjust freely, Escape cancels for free. Confirm to commit the tilt; that spends the turn.',
      gravityTiltPracticeBoard, numbered(5), numbered(4), [], { accepted: true },
    ),
    step(
      'tilt-reveals-a-line', 'Tilting reveals new lines',
      'These three 3s don’t line up yet. Tilt to 45° and confirm — clearing follows the direction gravity is pulling, not always up-and-down.',
      gravityRevealBoard, numbered(3), numbered(4), [], { accepted: true, clearCountAtLeast: 1 },
    ),
    step(
      'drop-under-tilt', 'Tilting changes where you enter',
      'Gravity is already tilted here, so you enter from the highlighted side. Drop the 3 to complete the run.',
      gravityDropUnderTiltBoard, numbered(3), numbered(4), [3], { accepted: true, clearCountAtLeast: 1 }, 90,
    ),
  ],
};

export const TUTORIALS: Record<string, TutorialDefinition> = {
  [CLASSIC_TUTORIAL.id]: CLASSIC_TUTORIAL,
  [GRAVITY_TUTORIAL.id]: GRAVITY_TUTORIAL,
};

export function evaluateTutorialSuccess(
  result: TutorialTurnResult,
  success: TutorialSuccess,
): boolean {
  if (success.accepted !== undefined && result.accepted !== success.accepted) return false;

  const clearSteps = result.steps.filter(step => step.kind === StepKind.Clear);
  const revealSteps = result.steps.filter(step => step.kind === StepKind.Reveal);
  const chainLength = clearSteps.reduce(
    (longest, clear) => Math.max(longest, clear.chainLevel + 1),
    0,
  );

  return clearSteps.length >= (success.clearCountAtLeast ?? 0)
    && revealSteps.reduce((count, reveal) => count + reveal.positions.length, 0) >= (success.revealCountAtLeast ?? 0)
    && chainLength >= (success.chainLengthAtLeast ?? 0);
}

export function isTutorialStepSuccessful(
  step: TutorialStep,
  result: TutorialTurnResult,
): boolean {
  return evaluateTutorialSuccess(result, step.success);
}
