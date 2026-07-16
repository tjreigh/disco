import { describe, expect, test } from 'vitest';
import { StepKind } from '../../game/events.js';
import {
  evaluateTutorialSuccess, isTutorialStepSuccessful, CLASSIC_TUTORIAL, GRAVITY_TUTORIAL, STACK_TUTORIAL, TUTORIALS,
  type TutorialTurnResult,
} from '../../app/tutorial.js';
import { GameEngine } from '../../game/engine.js';
import { CLASSIC_MODE, GRAVITY_MODE, STACK_MODE } from '../../game/modes/index.js';
import { settleContinuous } from '../../game/gravity/settling.js';
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
      'stage-a-drop', 'tilt-the-drop', 'tilt-reveals-lines', 'keep-gravity-moving',
    ]);
    for (const step of GRAVITY_TUTORIAL.steps) {
      expect(step.board).toHaveLength(7);
      expect(step.board[0]).toHaveLength(7);
      expect(step.currentDisc).toBeDefined();
      expect(step.nextDisc).toBeDefined();
      expect(step.tiltPrompt, `${step.id} is missing its Aiming prompt`).toBeTruthy();
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

  // Every Gravity tutorial turn stages a lane, tilts it, then commits the
  // resulting placement through the real engine.
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

      expect(engine.stageGravityDrop(step.allowedCols[0]!)).toBeUndefined();
      engine.tiltGravity(45);
      const result = engine.commitTilt();

      expect(isTutorialStepSuccessful(step, result, engine.state.gravity?.angle), step.id).toBe(true);
    }
  });

  test('tilt-reveals-lines succeeds clockwise but not counter-clockwise', () => {
    const step = GRAVITY_TUTORIAL.steps.find(candidate => candidate.id === 'tilt-reveals-lines')!;
    const play = (tiltDelta: number) => {
      const engine = new GameEngine({ mode: GRAVITY_MODE });
      engine.loadScriptedState({
        mode: GRAVITY_MODE,
        board: step.board,
        currentDisc: step.currentDisc,
        nextDisc: step.nextDisc,
      });
      expect(engine.stageGravityDrop(step.allowedCols[0]!)).toBeUndefined();
      engine.tiltGravity(tiltDelta);
      return engine.commitTilt();
    };

    const counterClockwise = play(-45);
    const clockwise = play(45);
    expect(isTutorialStepSuccessful(step, counterClockwise, -45)).toBe(false);
    expect(isTutorialStepSuccessful(step, clockwise, 45)).toBe(true);
  });

  test('is registered under its mode id in TUTORIALS', () => {
    expect(TUTORIALS[GRAVITY_MODE.id]).toBe(GRAVITY_TUTORIAL);
    expect(TUTORIALS[CLASSIC_MODE.id]).toBe(CLASSIC_TUTORIAL);
  });
});

describe('STACK_TUTORIAL', () => {
  test('contains the four ordered tutorial steps', () => {
    expect(STACK_TUTORIAL.steps.map(step => step.id)).toEqual([
      'clear-a-run', 'bigger-run', 'chain-the-stack', 'big-stack',
    ]);
    for (const step of STACK_TUTORIAL.steps) {
      expect(step.board).toHaveLength(7);
      expect(step.board[0]).toHaveLength(7);
      expect(step.allowedCols.length).toBeGreaterThan(0);
      expect(step.currentDisc).toBeDefined();
      expect(step.nextDisc).toBeDefined();
    }
  });

  test('explicitly distinguishes falling from clearing and explains the squared turn total', () => {
    const copy = STACK_TUTORIAL.steps.map(step => `${step.title} ${step.prompt}`).join(' ');
    expect(copy).toContain('10 × total²');
    expect(copy).toContain('Falling scores nothing by itself');
    expect(copy).toContain('joins the same turn total');
    expect(copy).toContain('clear together or in later waves');
  });

  test('starts every tutorial step from a physically grounded board', () => {
    for (const step of STACK_TUTORIAL.steps) {
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

  // Stack (like Classic) only deals values 1–7, so every disc on a tutorial
  // board — including the "filler" kept around to avoid the board-clear bonus —
  // must be a value the player could actually see in a real game.
  test('uses only in-range disc values (1–7) on every board', () => {
    for (const step of STACK_TUTORIAL.steps) {
      for (let row = 0; row < step.board.length; row++) {
        for (let col = 0; col < step.board[row]!.length; col++) {
          const disc = step.board[row]![col];
          if (!disc) continue;
          expect(disc.value, `${step.id} has out-of-range value ${disc.value} at r${row + 1}c${col + 1}`).toBeGreaterThanOrEqual(STACK_MODE.discValueMin);
          expect(disc.value).toBeLessThanOrEqual(STACK_MODE.discValueMax);
        }
      }
    }
  });

  // Stack reuses Classic's clearing rules, so a step's board must not already
  // contain a clearable disc — the player's drop should be what triggers the
  // cascade, not a pre-existing match the board happened to ship with.
  test('starts every tutorial step with no already-clearable disc', () => {
    for (const step of STACK_TUTORIAL.steps) {
      for (let row = 0; row < step.board.length; row++) {
        for (let col = 0; col < step.board[row]!.length; col++) {
          const disc = step.board[row]![col];
          if (!disc) continue;
          expect(
            STACK_MODE.isClearable(step.board, row, col, disc),
            `${step.id} has a clearable disc at r${row + 1}c${col + 1} before any drop`,
          ).toBe(false);
        }
      }
    }
  });

  test('scripted steps are winnable through the real engine', () => {
    for (const step of STACK_TUTORIAL.steps) {
      const engine = new GameEngine({ mode: STACK_MODE });
      engine.loadScriptedState({
        mode: STACK_MODE,
        board: step.board,
        currentDisc: step.currentDisc,
        nextDisc: step.nextDisc,
      });

      const result = engine.drop(step.allowedCols[0]!);

      expect(isTutorialStepSuccessful(step, result), step.id).toBe(true);
    }
  });

  test('is registered under its mode id in TUTORIALS', () => {
    expect(TUTORIALS[STACK_MODE.id]).toBe(STACK_TUTORIAL);
  });
});
