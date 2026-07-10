import { describe, expect, test } from 'vitest';
import { StepKind } from '../../game/events.js';
import { evaluateTutorialSuccess, isTutorialStepSuccessful, CLASSIC_TUTORIAL, type TutorialTurnResult } from '../../app/tutorial.js';
import { GameEngine } from '../../game/engine.js';
import { CLASSIC_MODE } from '../../game/modes/index.js';

describe('CLASSIC_TUTORIAL', () => {
  test('contains the four ordered tutorial steps', () => {
    expect(CLASSIC_TUTORIAL.steps.map(step => step.id)).toEqual([
      'row-clear', 'column-clear', 'cracked-reveal', 'chain-reaction',
    ]);
    for (const step of CLASSIC_TUTORIAL.steps) {
      expect(step.board).toHaveLength(7);
      expect(step.board[0]).toHaveLength(7);
      expect(step.allowedCols.length).toBeGreaterThan(0);
      expect(step.currentDisc).toBeDefined();
      expect(step.nextDisc).toBeDefined();
    }
  });

  test('starts every tutorial step from a physically grounded board', () => {
    for (const step of CLASSIC_TUTORIAL.steps) {
      for (let col = 0; col < step.board[0]!.length; col++) {
        let seenEmptyBelow = false;
        for (let row = step.board.length - 1; row >= 0; row--) {
          const cell = step.board[row]![col];
          if (cell == null) {
            seenEmptyBelow = true;
          } else {
            expect(seenEmptyBelow, `${step.id} has unsupported disc at r${row + 1}c${col + 1}`).toBe(false);
          }
        }
      }
    }
  });

  test('evaluates accepted clears, reveals, and chain length', () => {
    const result: TutorialTurnResult = {
      accepted: true,
      steps: [
        { kind: StepKind.Clear, cleared: [], discs: [], chainLevel: 1, pointsAwarded: 0 },
        { kind: StepKind.Reveal, positions: [{ row: 6, col: 3 }], discs: [] },
      ],
    };
    expect(evaluateTutorialSuccess(result, { accepted: true, clearCountAtLeast: 1, revealCountAtLeast: 1, chainLengthAtLeast: 2 })).toBe(true);
    expect(evaluateTutorialSuccess({ ...result, accepted: false }, { accepted: true })).toBe(false);
    expect(evaluateTutorialSuccess(result, { clearCountAtLeast: 2 })).toBe(false);
  });

  test('scripted steps are winnable through the real engine', () => {
    for (const step of CLASSIC_TUTORIAL.steps) {
      const engine = new GameEngine({ mode: CLASSIC_MODE });
      engine.loadScriptedState({
        mode: CLASSIC_MODE,
        board: step.board,
        currentDisc: step.currentDisc,
        nextDisc: step.nextDisc,
      });

      const result = engine.drop(step.allowedCols[0]!);

      expect(isTutorialStepSuccessful(step, result), step.id).toBe(true);
    }
  });
});
