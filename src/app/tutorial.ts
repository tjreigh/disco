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
  readonly allowedCols: readonly number[];
  readonly success: TutorialSuccess;
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
): TutorialStep {
  return { id, title, prompt, board: tutorialBoard, currentDisc, nextDisc, allowedCols, success };
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
