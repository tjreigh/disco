// @vitest-environment happy-dom

import { afterEach, describe, expect, test, vi } from 'vitest';
import { createDemoScenario, DemoController } from '../../app/demo-controller.js';
import { applyStepToVisualBoard } from '../../app/visual-board.js';
import { deepCloneBoard } from '../../game/board.js';
import { GameEngine } from '../../game/engine.js';
import { StepKind } from '../../game/events.js';
import { CLASSIC_RULES } from '../../game/modes/index.js';
import { DiscKind } from '../../game/model.js';
import { GamePhase } from '../../game/state.js';
import type { ScorePopup } from '../../ui/rendering/animation-types.js';
import { Renderer } from '../../ui/rendering/renderer.js';

const INITIAL_MOVE_TIME_MS = 1_600;

/**
 * Stubs requestAnimationFrame/cancelAnimationFrame the same way the existing
 * loop test does, but exposes the captured callback and lets a test clear it
 * so "was a new frame scheduled after this call" can be asserted precisely
 * (cancelAnimationFrame is a no-op mock, so the previous callback reference
 * would otherwise linger and give a false positive).
 */
function stubAnimationFrame() {
  let scheduledFrame: FrameRequestCallback | undefined;
  const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
    scheduledFrame = callback;
    return 1;
  });
  const caf = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
  return {
    raf,
    caf,
    getFrame: () => scheduledFrame,
    clearFrame: () => { scheduledFrame = undefined; },
  };
}

/**
 * DemoController keeps its collaborators as TS-`private` (not `#`-private)
 * fields, so they're reachable at runtime through a cast. Used below to reach
 * into the constructor-time engine/animation state that has no public getter,
 * the same way the source itself has no other seam to test these branches.
 */
type DemoControllerInternals = {
  engine: GameEngine;
  scorePopups: ScorePopup[];
  animationQueue: {
    onStepStart: (
      step: { kind: StepKind; cleared?: { row: number; col: number }[]; pointsAwarded?: number },
      now: number,
    ) => void;
  } | null;
  handleReducedMotionChange: (event: MediaQueryListEvent) => void;
  handleIntersection: (entries: IntersectionObserverEntry[]) => void;
  handleVisibilityChange: () => void;
};

function internals(controller: DemoController): DemoControllerInternals {
  return controller as unknown as DemoControllerInternals;
}

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
    const engine = new GameEngine({ rules: CLASSIC_RULES, seed: 0 });
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
    const engine = new GameEngine({ rules: CLASSIC_RULES, seed: 0 });
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

describe('DemoController environment fallbacks', () => {
  test('constructs without matchMedia and treats reduced motion as not requested', () => {
    const { getFrame } = stubAnimationFrame();
    const originalMatchMedia = window.matchMedia;
    Object.defineProperty(window, 'matchMedia', { value: undefined, configurable: true });

    let controller: DemoController | undefined;
    try {
      expect(() => { controller = new DemoController(makeCanvas()); }).not.toThrow();
      // No matchMedia means reducedMotion defaults to false, so the constructor
      // still calls syncPlayback() and schedules the loop.
      expect(getFrame()).toBeTypeOf('function');
    } finally {
      Object.defineProperty(window, 'matchMedia', { value: originalMatchMedia, configurable: true });
      controller?.destroy();
    }
  });

  test('constructs without IntersectionObserver and leaves playback to run normally', () => {
    const { getFrame } = stubAnimationFrame();
    const originalIntersectionObserver = window.IntersectionObserver;
    Object.defineProperty(window, 'IntersectionObserver', { value: undefined, configurable: true });

    let controller: DemoController | undefined;
    try {
      expect(() => { controller = new DemoController(makeCanvas()); }).not.toThrow();
      // isIntersecting still defaults true when there's no observer to update
      // it, so playback isn't blocked by the missing API.
      expect(getFrame()).toBeTypeOf('function');
      expect(() => controller!.destroy()).not.toThrow();
    } finally {
      Object.defineProperty(window, 'IntersectionObserver', { value: originalIntersectionObserver, configurable: true });
    }
  });

  test('does not start playback when reduced motion is already requested at construction', () => {
    const { getFrame } = stubAnimationFrame();
    const removeEventListener = vi.fn();
    const mediaQueryList = {
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener,
    } as unknown as MediaQueryList;
    vi.spyOn(window, 'matchMedia').mockReturnValue(mediaQueryList);

    const controller = new DemoController(makeCanvas());

    expect(getFrame()).toBeUndefined();

    controller.destroy();
    expect(removeEventListener).toHaveBeenCalledWith('change', expect.any(Function));
  });
});

describe('DemoController visibility and motion handlers', () => {
  test('handleReducedMotionChange pauses playback when engaged and resumes when disengaged', () => {
    const { caf, getFrame, clearFrame } = stubAnimationFrame();
    const controller = new DemoController(makeCanvas());
    expect(getFrame()).toBeTypeOf('function');

    const cafCallsBefore = caf.mock.calls.length;
    internals(controller).handleReducedMotionChange({ matches: true } as MediaQueryListEvent);
    expect(caf.mock.calls.length).toBeGreaterThan(cafCallsBefore);

    clearFrame();
    internals(controller).handleReducedMotionChange({ matches: false } as MediaQueryListEvent);
    expect(getFrame()).toBeTypeOf('function');

    controller.destroy();
  });

  test('handleIntersection pauses playback when the canvas leaves view and resumes when it returns', () => {
    const { caf, getFrame, clearFrame } = stubAnimationFrame();
    const controller = new DemoController(makeCanvas());
    expect(getFrame()).toBeTypeOf('function');

    // An empty entries list (entries.at(-1) undefined) is a no-op guard.
    expect(() => internals(controller).handleIntersection([])).not.toThrow();

    const cafCallsBefore = caf.mock.calls.length;
    internals(controller).handleIntersection([
      { isIntersecting: false, intersectionRatio: 0 } as IntersectionObserverEntry,
    ]);
    expect(caf.mock.calls.length).toBeGreaterThan(cafCallsBefore);

    clearFrame();
    internals(controller).handleIntersection([
      { isIntersecting: true, intersectionRatio: 1 } as IntersectionObserverEntry,
    ]);
    expect(getFrame()).toBeTypeOf('function');

    controller.destroy();
  });

  test('handleVisibilityChange pauses playback when the document is hidden and resumes when visible', () => {
    const { caf, getFrame, clearFrame } = stubAnimationFrame();
    const controller = new DemoController(makeCanvas());
    expect(getFrame()).toBeTypeOf('function');

    const originalDescriptor = Object.getOwnPropertyDescriptor(document, 'visibilityState');
    try {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      const cafCallsBefore = caf.mock.calls.length;
      internals(controller).handleVisibilityChange();
      expect(caf.mock.calls.length).toBeGreaterThan(cafCallsBefore);

      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
      clearFrame();
      internals(controller).handleVisibilityChange();
      expect(getFrame()).toBeTypeOf('function');
    } finally {
      if (originalDescriptor) Object.defineProperty(document, 'visibilityState', originalDescriptor);
      controller.destroy();
    }
  });

  test('handleResize resizes the renderer and redraws without throwing', () => {
    stubAnimationFrame();
    const resizeSpy = vi.spyOn(Renderer.prototype, 'resize');
    const drawSpy = vi.spyOn(Renderer.prototype, 'draw');
    const controller = new DemoController(makeCanvas());
    resizeSpy.mockClear();
    drawSpy.mockClear();

    expect(() => controller.handleResize()).not.toThrow();

    expect(resizeSpy).toHaveBeenCalledOnce();
    expect(drawSpy).toHaveBeenCalledOnce();

    controller.destroy();
  });
});

describe('DemoController lifecycle and guards', () => {
  test('destroy cancels the frame, detaches listeners/observers, and tolerates repeat calls', () => {
    const { caf } = stubAnimationFrame();
    const mediaRemoveEventListener = vi.fn();
    const mediaQueryList = {
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: mediaRemoveEventListener,
    } as unknown as MediaQueryList;
    vi.spyOn(window, 'matchMedia').mockReturnValue(mediaQueryList);

    const observerDisconnect = vi.fn();
    class FakeIntersectionObserver {
      observe = vi.fn();
      disconnect = observerDisconnect;
      unobserve = vi.fn();
      takeRecords = vi.fn(() => []);
    }
    const originalIntersectionObserver = window.IntersectionObserver;
    Object.defineProperty(window, 'IntersectionObserver', { value: FakeIntersectionObserver, configurable: true });
    const documentRemoveEventListener = vi.spyOn(document, 'removeEventListener');

    try {
      const controller = new DemoController(makeCanvas());
      controller.destroy();

      expect(caf).toHaveBeenCalled();
      expect(observerDisconnect).toHaveBeenCalledOnce();
      expect(mediaRemoveEventListener).toHaveBeenCalledWith('change', expect.any(Function));
      expect(documentRemoveEventListener).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
      expect(() => controller.destroy()).not.toThrow();
    } finally {
      Object.defineProperty(window, 'IntersectionObserver', { value: originalIntersectionObserver, configurable: true });
    }
  });

  test('animation callback ignores empty-cleared Clear steps and non-Clear steps, but reacts to real clears', () => {
    const { getFrame } = stubAnimationFrame();
    const controller = new DemoController(makeCanvas());
    const frame = getFrame()!;
    frame(0);
    frame(INITIAL_MOVE_TIME_MS); // triggers the first scripted move, constructing the animation queue

    const state = internals(controller);
    expect(state.animationQueue).not.toBeNull();

    state.scorePopups.length = 0;
    state.animationQueue!.onStepStart({ kind: StepKind.Clear, cleared: [] }, 0);
    state.animationQueue!.onStepStart({ kind: StepKind.Drop }, 0);
    expect(state.scorePopups).toHaveLength(0);

    state.animationQueue!.onStepStart({ kind: StepKind.Clear, cleared: [{ row: 0, col: 0 }], pointsAwarded: 30 }, 0);
    expect(state.scorePopups).toHaveLength(1);

    controller.destroy();
  });

  test('throws when a scripted move becomes illegal against live engine state', () => {
    const { getFrame } = stubAnimationFrame();
    const controller = new DemoController(makeCanvas());
    internals(controller).engine.state.phase = GamePhase.GameOver;

    const frame = getFrame()!;
    frame(0);
    expect(() => frame(INITIAL_MOVE_TIME_MS)).toThrowError('Invalid deterministic demo move at index 0');
  });
});
