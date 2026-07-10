import { describe, expect, test } from 'vitest';
import { StepKind } from '../../game/events.js';
import {
  evaluateTutorialSuccess, isTutorialStepSuccessful, CLASSIC_TUTORIAL, GRAVITY_TUTORIAL, TUTORIALS,
  type TutorialTurnResult,
} from '../../app/tutorial.js';
import { GameEngine } from '../../game/engine.js';
import { CLASSIC_MODE, GRAVITY_MODE } from '../../game/modes/index.js';
import { settleContinuous } from '../../game/gravity.js';
import { deepCloneBoard } from '../../game/board.js';

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

describe('GRAVITY_TUTORIAL', () => {
  test('contains the four ordered tutorial steps', () => {
    expect(GRAVITY_TUTORIAL.steps.map(step => step.id)).toEqual([
      'drop-like-classic', 'tilt-is-a-turn', 'tilt-reveals-a-line', 'drop-under-tilt',
    ]);
    for (const step of GRAVITY_TUTORIAL.steps) {
      expect(step.board).toHaveLength(7);
      expect(step.board[0]).toHaveLength(7);
      expect(step.currentDisc).toBeDefined();
      expect(step.nextDisc).toBeDefined();
    }
  });

  // Generalizes CLASSIC_TUTORIAL's "physically grounded" check to any
  // starting angle: a step's board must already be a converged resting state
  // for its OWN gravityAngleDeg (defaulting to 0, same as Classic) — checked
  // by re-settling a clone and asserting nothing moves — rather than always
  // assuming straight-down support, since a step can start pre-tilted.
  test('starts every tutorial step from a board already settled at its own gravity angle', () => {
    for (const step of GRAVITY_TUTORIAL.steps) {
      const angle = step.gravityAngleDeg ?? 0;
      const clone = deepCloneBoard(step.board);
      const result = settleContinuous(clone, angle);
      expect(result.moves, `${step.id} is not settled at ${angle}deg`).toEqual([]);
    }
  });

  // A tilt-only step (allowedCols: []) must actually make a drop into ANY
  // lane a no-op — not just be prompted as tilt-only in the UI copy — since
  // that's what game-controller.ts's handleIntent relies on to force the
  // player toward the tilt action instead of a drop.
  test('tilt-only steps (empty allowedCols) reject every lane for a drop', () => {
    for (const step of GRAVITY_TUTORIAL.steps) {
      if (step.allowedCols.length > 0) continue;
      for (let lane = 0; lane < 7; lane++) {
        expect(step.allowedCols.includes(lane), `${step.id} should not allow lane ${lane}`).toBe(false);
      }
    }
  });

  // Mirrors CLASSIC_TUTORIAL's "winnable through the real engine" test: a
  // step with lanes drops into the first allowed one; a tilt-only step tilts
  // to +45deg (within the standard maxTiltDelta) and commits.
  test('scripted steps are winnable through the real engine', () => {
    for (const step of GRAVITY_TUTORIAL.steps) {
      const engine = new GameEngine({ mode: GRAVITY_MODE });
      engine.loadScriptedState({
        mode: GRAVITY_MODE,
        board: step.board,
        currentDisc: step.currentDisc,
        nextDisc: step.nextDisc,
        ...(step.gravityAngleDeg !== undefined ? { gravityAngleDeg: step.gravityAngleDeg } : {}),
      });

      let result;
      if (step.allowedCols.length > 0) {
        result = engine.drop(step.allowedCols[0]!);
      } else {
        engine.tiltGravity(45);
        result = engine.commitTilt();
      }

      expect(isTutorialStepSuccessful(step, result), step.id).toBe(true);
    }
  });

  test('is registered under its mode id in TUTORIALS', () => {
    expect(TUTORIALS[GRAVITY_MODE.id]).toBe(GRAVITY_TUTORIAL);
    expect(TUTORIALS[CLASSIC_MODE.id]).toBe(CLASSIC_TUTORIAL);
  });
});
