import type { PhysicsStep } from '../game/events.js';
import { StepKind } from '../game/events.js';
import { makeDisc } from '../game/disc.js';
import { DiscKind, type Board, type Disc } from '../game/model.js';

export interface TutorialSuccess {
  accepted?: boolean;
  clearCountAtLeast?: number;
  revealCountAtLeast?: number;
  chainLengthAtLeast?: number;
  /** Gravity tutorial only: the committed angle required to demonstrate the intended direction. */
  gravityAngleDeg?: number;
  /** Minimum total numbered discs cleared across the whole cascade (sum of every Clear step's cleared count). The Stack-mode metric: points scale with stackSize², so this is what a Stack step really measures. */
  stackSizeAtLeast?: number;
}

export interface TutorialStep {
  readonly id: string;
  readonly title: string;
  readonly prompt: string;
  readonly board: Board;
  readonly currentDisc: Disc;
  readonly nextDisc: Disc;
  /** Allowed LANES — a column index for top/bottom entry, a row index for left/right. Gravity steps stage one of these lanes before their required tilt. */
  readonly allowedCols: readonly number[];
  readonly success: TutorialSuccess;
  /** Gravity-mode steps only: starting angle, defaulting to the mode's initialAngleDeg (0) when omitted — e.g. a step that wants the board pre-tilted before the player acts. */
  readonly gravityAngleDeg?: number;
  /** Gravity-mode steps only: replaces `prompt` in the overlay while the staged drop is Aiming — the "now you must tilt" copy. */
  readonly tiltPrompt?: string;
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
  opts?: { gravityAngleDeg?: number; tiltPrompt?: string },
): TutorialStep {
  return {
    id, title, prompt, board: tutorialBoard, currentDisc, nextDisc, allowedCols, success,
    ...(opts?.gravityAngleDeg !== undefined ? { gravityAngleDeg: opts.gravityAngleDeg } : {}),
    ...(opts?.tiltPrompt !== undefined ? { tiltPrompt: opts.tiltPrompt } : {}),
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
      'stage-a-drop', 'Stage a drop',
      'Move to the highlighted lane and confirm to stage it — nothing drops yet. Every Gravity drop must be tilted before it can settle.',
      gravityTiltPracticeBoard, numbered(7), numbered(4), [3], { accepted: true },
      { tiltPrompt: 'Lane staged — nothing drops until you tilt. Tap ↺ or ↻ (or press Q / E) to rotate gravity 45°, then CONFIRM.' },
    ),
    step(
      'tilt-the-drop', 'Tilt before dropping',
      'Stage the highlighted lane again, then tilt 45° or 90° and confirm a second time. The disc enters from the direction you staged, then settles under the new gravity.',
      gravityDropBoard, numbered(7), numbered(4), [2], { accepted: true },
      { tiltPrompt: 'Now tilt ↺ or ↻ and watch the preview resettle live. The disc still enters from the lane you staged — CONFIRM when it looks right.' },
    ),
    step(
      'tilt-reveals-lines', 'Tilting reveals lines',
      'These three 3s form a line only under diagonal gravity. Stage the disc, tilt, then confirm to reveal it.',
      gravityRevealBoard, numbered(7), numbered(4), [6], { accepted: true, clearCountAtLeast: 1, gravityAngleDeg: 45 },
      { tiltPrompt: 'Tilt ↻ once so gravity points down-right (45°), then CONFIRM — the three 3s already sit on that diagonal.' },
    ),
    step(
      'keep-gravity-moving', 'Keep gravity moving',
      'Gravity stays tilted after every drop. Stage this row, tilt again, and watch the board reorganize around the new direction.',
      gravityDropUnderTiltBoard, numbered(7), numbered(4), [3], { accepted: true },
      { gravityAngleDeg: 90, tiltPrompt: 'Staged from the left edge. Tilt ↺ or ↻ — 45° or 90° — then CONFIRM. Gravity stays wherever you leave it.' },
    ),
  ],
};

// ─── Stack tutorial ─────────────────────────────────────────────────────────
// Stack keeps Classic's clearing rules; only scoring changes — a drop earns one
// award for EVERY numbered disc its cascade clears (points = unit × stackSize²),
// so the goal is to clear as many discs as possible in a single drop. Every
// board below was verified against the real engine (GameEngine.drop on STACK_MODE)
// before being written here, not hand-derived — the run helpers count ALL
// contiguous discs (any value), so a "looks right" board often clears the wrong
// set or nothing at all.
//
// Each board keeps a stray support disc on the far side of the board (value 7
// or 4) so the cascade doesn't empty it and fire the board-clear bonus (which
// would dwarf the Stack award being taught). These are real disc values: a lone
// 7 sits in a run of 1 (≠ 7), so it never clears — no fake/impossible values.

const stackRowBoard = emptyBoard();
stackRowBoard[6]![0] = numbered(3);
stackRowBoard[6]![1] = numbered(3);
stackRowBoard[6]![6] = numbered(7);

const stackLongRunBoard = emptyBoard();
stackLongRunBoard[3]![1] = numbered(5);
stackLongRunBoard[4]![1] = numbered(5);
stackLongRunBoard[5]![1] = numbered(5);
stackLongRunBoard[6]![1] = numbered(5);
stackLongRunBoard[6]![6] = numbered(7);

const stackChainBoard = emptyBoard();
stackChainBoard[4]![2] = numbered(2);
stackChainBoard[5]![2] = numbered(2);
stackChainBoard[6]![2] = numbered(7);
stackChainBoard[6]![3] = numbered(4);

const stackBigStackBoard = emptyBoard();
stackBigStackBoard[6]![0] = numbered(6);
stackBigStackBoard[6]![1] = numbered(6);
stackBigStackBoard[6]![2] = numbered(6);
stackBigStackBoard[6]![3] = numbered(6);
stackBigStackBoard[6]![4] = numbered(6);
stackBigStackBoard[5]![0] = numbered(7);

export const STACK_TUTORIAL: TutorialDefinition = {
  id: 'stack',
  title: 'Stack Tutorial',
  steps: [
    step('clear-a-run', 'Clear a run', 'Drop the 3 to complete the row. The whole run clears at once — every disc counts toward your stack.', stackRowBoard, numbered(3), numbered(4), [2], { accepted: true, stackSizeAtLeast: 3 }),
    step('bigger-run', 'Bigger run, bigger stack', 'Drop the 5 to complete the column of five. Stack scores the whole cascade, so longer runs pay off fast.', stackLongRunBoard, numbered(5), numbered(4), [1], { accepted: true, stackSizeAtLeast: 5 }),
    step('chain-the-stack', 'Chain the stack', 'Drop the 2 to clear the pair, then watch the fallen 2 chain into a second clear. Each cleared disc still adds to your stack.', stackChainBoard, numbered(2), numbered(3), [3], { accepted: true, stackSizeAtLeast: 3, chainLengthAtLeast: 2 }),
    step('big-stack', 'Go for the big stack', 'Drop the 6 to complete the row of six. The bigger the cascade, the bigger the payoff.', stackBigStackBoard, numbered(6), numbered(4), [5], { accepted: true, stackSizeAtLeast: 6 }),
  ],
};

export const TUTORIALS: Record<string, TutorialDefinition> = {
  [CLASSIC_TUTORIAL.id]: CLASSIC_TUTORIAL,
  [GRAVITY_TUTORIAL.id]: GRAVITY_TUTORIAL,
  [STACK_TUTORIAL.id]: STACK_TUTORIAL,
};

export function evaluateTutorialSuccess(
  result: TutorialTurnResult,
  success: TutorialSuccess,
  gravityAngleDeg?: number,
): boolean {
  if (success.accepted !== undefined && result.accepted !== success.accepted) return false;
  if (success.gravityAngleDeg !== undefined) {
    if (gravityAngleDeg === undefined) return false;
    const normalizedActual = ((gravityAngleDeg % 360) + 360) % 360;
    const normalizedRequired = ((success.gravityAngleDeg % 360) + 360) % 360;
    if (normalizedActual !== normalizedRequired) return false;
  }

  const clearSteps = result.steps.filter(step => step.kind === StepKind.Clear);
  const revealSteps = result.steps.filter(step => step.kind === StepKind.Reveal);
  const chainLength = clearSteps.reduce(
    (longest, clear) => Math.max(longest, clear.chainLevel + 1),
    0,
  );
  const stackSize = clearSteps.reduce((total, clear) => total + clear.cleared.length, 0);

  return clearSteps.length >= (success.clearCountAtLeast ?? 0)
    && revealSteps.reduce((count, reveal) => count + reveal.positions.length, 0) >= (success.revealCountAtLeast ?? 0)
    && chainLength >= (success.chainLengthAtLeast ?? 0)
    && stackSize >= (success.stackSizeAtLeast ?? 0);
}

export function isTutorialStepSuccessful(
  step: TutorialStep,
  result: TutorialTurnResult,
  gravityAngleDeg?: number,
): boolean {
  return evaluateTutorialSuccess(result, step.success, gravityAngleDeg);
}
