// @vitest-environment happy-dom

import { describe, expect, test } from 'vitest';
import { createDemoScenario } from '../../app/demo-controller.js';
import { applyStepToVisualBoard } from '../../app/visual-board.js';
import { deepCloneBoard } from '../../game/board.js';
import { GameEngine } from '../../game/engine.js';
import { StepKind } from '../../game/events.js';
import { CLASSIC_MODE } from '../../game/modes/index.js';
import { DiscKind } from '../../game/model.js';

describe('demo scenario', () => {
  test('uses legal deterministic moves for a basic clear, cracked reveal, and chain', () => {
    const scenario = createDemoScenario();
    const engine = new GameEngine({ mode: CLASSIC_MODE, seed: 0 });
    engine.loadScriptedState(scenario);

    const results = scenario.moves.map(lane => engine.drop(lane));
    expect(results.every(result => result.accepted)).toBe(true);

    expect(results[0]!.steps.map(step => step.kind)).toEqual([
      StepKind.Drop, StepKind.Clear,
    ]);
    expect(results[0]!.steps.filter(step => step.kind === StepKind.Clear).map(step => step.chainLevel)).toEqual([0]);

    expect(results[1]!.steps.some(step => step.kind === StepKind.Reveal)).toBe(true);
    expect(engine.state.board[6]![3]?.kind).toBe(DiscKind.SingleCracked);

    expect(results[2]!.steps.filter(step => step.kind === StepKind.Clear).map(step => step.chainLevel)).toEqual([0, 1]);
  });

  test('replays every engine step to the same final board the renderer receives', () => {
    const scenario = createDemoScenario();
    const engine = new GameEngine({ mode: CLASSIC_MODE, seed: 0 });
    engine.loadScriptedState(scenario);

    for (const lane of scenario.moves) {
      const result = engine.drop(lane);
      expect(result.accepted).toBe(true);
      const visualBoard = deepCloneBoard(result.boardBefore);
      result.steps.forEach(step => applyStepToVisualBoard(visualBoard, step));
      expect(visualBoard).toEqual(engine.state.board);
    }
  });
});
