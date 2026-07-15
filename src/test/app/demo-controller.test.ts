// @vitest-environment happy-dom

import { afterEach, describe, expect, test, vi } from 'vitest';
import { createDemoScenario, DemoController } from '../../app/demo-controller.js';
import { applyStepToVisualBoard } from '../../app/visual-board.js';
import { deepCloneBoard } from '../../game/board.js';
import { GameEngine } from '../../game/engine.js';
import { StepKind } from '../../game/events.js';
import { CLASSIC_MODE } from '../../game/modes/index.js';
import { DiscKind } from '../../game/model.js';

const INITIAL_MOVE_TIME_MS = 1_600;

function makeCanvas(): HTMLCanvasElement {
  const gradient = { addColorStop: vi.fn() };
  const noop = vi.fn();
  const context = {
    arc: noop, beginPath: noop, clearRect: noop,
    createLinearGradient: () => gradient, createRadialGradient: () => gradient,
    fill: noop, fillRect: noop, fillText: noop, lineTo: noop, moveTo: noop,
    restore: noop, roundRect: noop, save: noop, scale: noop, setLineDash: noop,
    setTransform: noop, stroke: noop, strokeRect: noop, translate: noop,
    fillStyle: '', strokeStyle: '', font: '', globalAlpha: 1, lineCap: 'butt',
    lineWidth: 1, shadowBlur: 0, shadowColor: '', textAlign: 'center',
    textBaseline: 'middle',
  } as unknown as CanvasRenderingContext2D;
  const canvas = document.createElement('canvas');
  vi.spyOn(canvas, 'getContext').mockReturnValue(context);
  document.body.append(canvas);
  return canvas;
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('demo scenario', () => {
  test('controller executes its first scheduled move through the real animation loop', () => {
    let scheduledFrame: FrameRequestCallback | undefined;
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
      scheduledFrame = callback;
      return 1;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
    const controller = new DemoController(makeCanvas());

    expect(scheduledFrame).toBeTypeOf('function');
    scheduledFrame!(0);
    expect(() => scheduledFrame!(INITIAL_MOVE_TIME_MS)).not.toThrow();

    controller.destroy();
  });

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
