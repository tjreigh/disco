// @vitest-environment happy-dom

import { beforeEach, describe, expect, test } from 'vitest';
import { clampPan, computeFocalZoom, paintedContentSize, ZoomControls } from '../../ui/zoom-controls.js';
import { USER_SETTINGS_STORAGE_KEY, UserSettingsStore } from '../../platform/user-settings-store.js';
import { canvasLogicalHeight, canvasLogicalWidth, setGridSize, updateCellSize } from '../../ui/rendering/layout.js';

// Sets clientWidth/clientHeight (via defineProperty, since happy-dom does no
// real layout) on the stage and canvas, and a matching getBoundingClientRect
// on the stage — computeCenter() reads that for the pinch focal-point math.
function setGeometry(stage: HTMLElement, canvas: HTMLElement, width: number, height: number): void {
  for (const el of [stage, canvas]) {
    Object.defineProperty(el, 'clientWidth', { configurable: true, value: width });
    Object.defineProperty(el, 'clientHeight', { configurable: true, value: height });
  }
  stage.getBoundingClientRect = () => ({
    left: 0, top: 0, right: width, bottom: height, width, height, x: 0, y: 0, toJSON: () => {},
  }) as DOMRect;
}

function mount(width = 300, height = 300): { root: HTMLElement; stage: HTMLElement; canvas: HTMLCanvasElement } {
  const root = document.createElement('div');
  const stage = document.createElement('div');
  stage.className = 'game-stage';
  const canvas = document.createElement('canvas');
  stage.append(canvas);
  root.append(stage);
  document.body.append(root);
  setGeometry(stage, canvas, width, height);
  return { root, stage, canvas };
}

function currentScale(stage: HTMLElement): number {
  const match = /scale\(([^)]+)\)/.exec(stage.style.transform);
  return match ? Number.parseFloat(match[1]!) : 1;
}

function currentPan(stage: HTMLElement): { x: number; y: number } {
  const match = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)/.exec(stage.style.transform);
  return match ? { x: Number.parseFloat(match[1]!), y: Number.parseFloat(match[2]!) } : { x: 0, y: 0 };
}

function touch(identifier: number, x: number, y: number, target: EventTarget): Touch {
  return new Touch({ identifier, target, clientX: x, clientY: y } as unknown as TouchInit);
}

function dispatchTouch(el: HTMLElement, type: string, touches: Touch[]): void {
  const event = new TouchEvent(type, {
    touches, changedTouches: touches, targetTouches: touches,
    bubbles: true, cancelable: true,
  } as unknown as TouchEventInit);
  el.dispatchEvent(event);
}

describe('computeFocalZoom', () => {
  const MIN_ZOOM = 1;
  const MAX_ZOOM = 2.5;

  test('a pinch centered exactly on C leaves pan at (0,0)', () => {
    const C = { x: 100, y: 100 };
    const { scale, pan } = computeFocalZoom({
      s0: 1, distance0: 100, distance1: 200,
      F0: C, F1: C, C, pan0: { x: 0, y: 0 },
      minZoom: MIN_ZOOM, maxZoom: MAX_ZOOM,
    });

    expect(scale).toBe(2);
    expect(pan.x).toBeCloseTo(0);
    expect(pan.y).toBeCloseTo(0);
  });

  test('a pure two-finger pan (no distance change) moves pan by exactly the midpoint delta', () => {
    const C = { x: 100, y: 100 };
    const pan0 = { x: 5, y: -3 };
    const F0 = { x: 150, y: 80 };
    const F1 = { x: 170, y: 60 };
    const { scale, pan } = computeFocalZoom({
      s0: 1.4, distance0: 120, distance1: 120,
      F0, F1, C, pan0,
      minZoom: MIN_ZOOM, maxZoom: MAX_ZOOM,
    });

    expect(scale).toBe(1.4);
    expect(pan.x).toBeCloseTo(pan0.x + (F1.x - F0.x));
    expect(pan.y).toBeCloseTo(pan0.y + (F1.y - F0.y));
  });

  test('an off-center pinch keeps the touched content point visually stationary', () => {
    // Simulate a content-space point p currently rendered at F0 under the
    // starting transform (C, pan0, s0). After the pinch (s1 derived from the
    // distance ratio, finger anchored on the same point so F1 === F0), the
    // same point p must still render at F1 under the new transform.
    const C = { x: 50, y: 200 };
    const pan0 = { x: 12, y: -8 };
    const s0 = 1;
    const p = { x: 30, y: 260 }; // arbitrary content-space point
    const F0 = { x: C.x + pan0.x + s0 * (p.x - C.x), y: C.y + pan0.y + s0 * (p.y - C.y) };
    const F1 = F0; // finger stays anchored on the same content point

    const distance0 = 100;
    const targetScale = 2;
    const distance1 = distance0 * (targetScale / s0);

    const { scale, pan } = computeFocalZoom({
      s0, distance0, distance1, F0, F1, C, pan0,
      minZoom: MIN_ZOOM, maxZoom: MAX_ZOOM,
    });

    expect(scale).toBeCloseTo(targetScale);
    const renderedX = C.x + pan.x + scale * (p.x - C.x);
    const renderedY = C.y + pan.y + scale * (p.y - C.y);
    expect(renderedX).toBeCloseTo(F1.x);
    expect(renderedY).toBeCloseTo(F1.y);
  });

  test('clamps scale to the supported range and still anchors the focal point at the clamped scale', () => {
    const C = { x: 0, y: 0 };
    const pan0 = { x: 0, y: 0 };
    const F0 = { x: 40, y: 0 };
    const { scale, pan } = computeFocalZoom({
      s0: 1, distance0: 100, distance1: 1000, // would be scale 10 unclamped
      F0, F1: F0, C, pan0,
      minZoom: MIN_ZOOM, maxZoom: MAX_ZOOM,
    });

    expect(scale).toBe(MAX_ZOOM);
    // Anchored using the *clamped* scale, not the raw requested ratio.
    const renderedX = C.x + pan.x + scale * (F0.x - C.x); // p === F0 here since s0 was 1
    expect(renderedX).toBeCloseTo(F0.x);
  });
});

describe('clampPan', () => {
  test('at scale 1, panning is fully disallowed (matches content == stage on mobile)', () => {
    const pan = clampPan({ x: 1000, y: -1000 }, 1, 100, 100, 100, 100);
    // clamp math can land on -0 for the negative-input axis; -0 === 0 for
    // every real use here (CSS translate, further arithmetic), so compare
    // with === rather than toBe's Object.is (which treats -0 !== 0).
    expect(pan.x === 0).toBe(true);
    expect(pan.y === 0).toBe(true);
  });

  test('clamps to the max pan derived from content size at the given scale', () => {
    const pan = clampPan({ x: 1000, y: -1000 }, 2, 100, 100, 100, 100);
    // maxPan = max(0, (100*2 - 100) / 2) = 50
    expect(pan).toEqual({ x: 50, y: -50 });
  });

  test('leaves an in-range pan untouched', () => {
    const pan = clampPan({ x: 20, y: -10 }, 2, 100, 100, 100, 100);
    expect(pan).toEqual({ x: 20, y: -10 });
  });

  test('requires more zoom before panning engages when content is much smaller than the stage', () => {
    // Wide/desktop case: a narrow centered board inside a much wider stage.
    const pan = clampPan({ x: 1000, y: 0 }, 2, 100, 100, 400, 400);
    // content(100) * scale(2) = 200 still < stage(400), so no panning yet.
    expect(pan).toEqual({ x: 0, y: 0 });
  });
});

describe('paintedContentSize', () => {
  test('non-demo modes use the intrinsic canvas size directly, ignoring the box', () => {
    expect(paintedContentSize(false, 999, 999, 500, 700)).toEqual({ width: 500, height: 700 });
  });

  test('demo mode letterboxes portrait content inside a squarer box (left/right bars)', () => {
    const { width, height } = paintedContentSize(true, 400, 400, 500, 700);
    expect(height).toBe(400);
    expect(width).toBeCloseTo(400 * (500 / 700));
  });

  test('demo mode letterboxes landscape content inside a taller box (top/bottom bars)', () => {
    const { width, height } = paintedContentSize(true, 400, 800, 700, 500);
    expect(width).toBe(400);
    expect(height).toBeCloseTo(400 / (700 / 500));
  });

  test('degenerates safely to a zero rect when the canvas box has no size yet', () => {
    expect(paintedContentSize(true, 0, 0, 500, 700)).toEqual({ width: 0, height: 0 });
  });
});

describe('ZoomControls (public API — buttons live in each mode\'s game menu, not here)', () => {
  beforeEach(() => {
    document.body.replaceChildren();
    document.documentElement.classList.remove('demo-mode');
    window.localStorage.removeItem(USER_SETTINGS_STORAGE_KEY);
  });

  test('zoomIn/zoomOut change the stage transform, persist, and fire onScaleChange', () => {
    const { root, stage } = mount();
    const zoom = new ZoomControls(root, stage);
    const scaleChanges: number[] = [];
    zoom.onScaleChange = scale => scaleChanges.push(scale);

    const initialScale = currentScale(stage);
    zoom.zoomIn();
    const afterZoomIn = currentScale(stage);
    expect(afterZoomIn).toBeGreaterThan(initialScale);
    expect(zoom.getScale()).toBeCloseTo(afterZoomIn);
    expect(new UserSettingsStore(window.localStorage).get().zoomLevel).toBeCloseTo(afterZoomIn);
    expect(scaleChanges).toEqual([afterZoomIn]);

    zoom.zoomOut();
    expect(currentScale(stage)).toBeCloseTo(initialScale);
    expect(scaleChanges).toEqual([afterZoomIn, initialScale]);
  });

  test('resetZoom snaps scale back to 1', () => {
    const { root, stage } = mount();
    const zoom = new ZoomControls(root, stage);

    zoom.zoomIn();
    zoom.zoomIn();
    expect(currentScale(stage)).toBeGreaterThan(1);

    zoom.resetZoom();
    expect(currentScale(stage)).toBeCloseTo(1);
    expect(zoom.getScale()).toBeCloseTo(1);
    expect(new UserSettingsStore(window.localStorage).get().zoomLevel).toBeCloseTo(1);
  });

  test('restores a persisted zoom level on construction', () => {
    new UserSettingsStore(window.localStorage).setZoomLevel(1.75);

    const { root, stage } = mount();
    const zoom = new ZoomControls(root, stage);

    expect(currentScale(stage)).toBeCloseTo(1.75);
    expect(zoom.getScale()).toBeCloseTo(1.75);
  });

  test('zoomIn clamps at the max zoom level instead of growing without bound', () => {
    const { root, stage } = mount();
    const zoom = new ZoomControls(root, stage);

    for (let i = 0; i < 20; i += 1) zoom.zoomIn();

    expect(zoom.getScale()).toBeLessThanOrEqual(2.5);
    for (let i = 0; i < 3; i += 1) zoom.zoomIn();
    expect(zoom.getScale()).toBeLessThanOrEqual(2.5);
  });
});

describe('ZoomControls (real two-finger touch sequences)', () => {
  beforeEach(() => {
    document.body.replaceChildren();
    document.documentElement.classList.remove('demo-mode');
    window.localStorage.removeItem(USER_SETTINGS_STORAGE_KEY);
    setGridSize(7, 7);
  });

  test('a plain (non-cancelled) two-finger gesture commits scale and pan on touchend', () => {
    const { root, stage, canvas } = mount(300, 300);
    const zoom = new ZoomControls(root, stage);

    dispatchTouch(canvas, 'touchstart', [touch(1, 100, 150, canvas), touch(2, 200, 150, canvas)]);
    dispatchTouch(canvas, 'touchmove', [touch(1, 50, 150, canvas), touch(2, 300, 150, canvas)]);
    const scaleDuringGesture = zoom.getScale();
    expect(scaleDuringGesture).toBeGreaterThan(1);

    dispatchTouch(canvas, 'touchend', []);

    expect(zoom.getScale()).toBe(scaleDuringGesture);
    expect(new UserSettingsStore(window.localStorage).get().zoomLevel).toBeCloseTo(scaleDuringGesture);
  });

  test('reclampPan clamps against the CURRENT geometry, not values cached at construction', () => {
    // A resize/orientation change updates Renderer.resize()'s canvasLogicalWidth
    // (layout.ts) and the stage's own clientWidth together — simulate both,
    // matching what main.ts's resize handler now guarantees: Renderer.resize()
    // runs, *then* reclampPan() runs (see the doc comment on
    // ZoomControls.reclampPan()).
    updateCellSize({ width: 300, height: 300 });
    const contentWidth = canvasLogicalWidth();

    // Content already exceeds the stage by a known 100px margin, even before
    // any zoom — like the smallest phones, where the MIN_CELL_SIZE-floored
    // board can already be bigger than the available viewport.
    const initialStageWidth = Math.max(50, contentWidth - 100);
    const { root, stage, canvas } = mount(initialStageWidth, 300);
    const zoom = new ZoomControls(root, stage);

    // A pure two-finger pan (fixed finger separation, so scale stays at 1)
    // moved far enough that the live clamp — not the raw finger delta —
    // determines the result: exactly max(0, (contentWidth - stageWidth) / 2).
    dispatchTouch(canvas, 'touchstart', [touch(1, 50, 150, canvas), touch(2, 150, 150, canvas)]);
    dispatchTouch(canvas, 'touchmove', [touch(1, -4950, 150, canvas), touch(2, -4850, 150, canvas)]);
    dispatchTouch(canvas, 'touchend', []);

    expect(zoom.getScale()).toBe(1); // separation never changed — a pure pan
    const expectedMaxPanAtInitialStage = Math.max(0, (contentWidth - initialStageWidth) / 2);
    expect(expectedMaxPanAtInitialStage).toBeGreaterThan(0); // sanity: there was something to clamp
    const panBefore = currentPan(stage);
    expect(panBefore.x).toBeCloseTo(-expectedMaxPanAtInitialStage, 1);

    // Grow the stage well past the content — an orientation change to a much
    // wider viewport, where nothing needs to pan at all any more.
    setGeometry(stage, canvas, contentWidth + 500, 300);

    zoom.reclampPan();

    expect(currentPan(stage)).toEqual({ x: 0, y: 0 });
  });

  test('the first touchcancel rolls back immediately, before the sequence ends', () => {
    const { root, stage, canvas } = mount(300, 300);
    const zoom = new ZoomControls(root, stage);
    expect(currentScale(stage)).toBe(1);
    const scaleChanges: number[] = [];
    zoom.onScaleChange = scale => scaleChanges.push(scale);

    dispatchTouch(canvas, 'touchstart', [touch(1, 100, 150, canvas), touch(2, 200, 150, canvas)]);
    dispatchTouch(canvas, 'touchmove', [touch(1, 50, 150, canvas), touch(2, 300, 150, canvas)]);
    expect(zoom.getScale()).toBeGreaterThan(1); // sanity: the gesture actually did something
    const notificationsDuringGesture = scaleChanges.length;

    // Touch 2 is cancelled; only touch 1 remains active. Rollback must
    // happen right here — not after the survivor eventually lifts.
    dispatchTouch(canvas, 'touchcancel', [touch(1, 50, 150, canvas)]);

    expect(zoom.getScale()).toBe(1);
    expect(currentPan(stage)).toEqual({ x: 0, y: 0 });
    expect(scaleChanges.length).toBe(notificationsDuringGesture + 1);
    expect(scaleChanges[scaleChanges.length - 1]).toBe(1);
    expect(new UserSettingsStore(window.localStorage).get().zoomLevel).toBe(1); // never persisted

    // Touch 1 then lifts normally — must not be read as a fresh gameplay
    // tap, must not persist anything, and must not fire a second
    // notification for a rollback that already happened above.
    dispatchTouch(canvas, 'touchend', []);

    expect(zoom.getScale()).toBe(1);
    expect(currentPan(stage)).toEqual({ x: 0, y: 0 });
    expect(scaleChanges.length).toBe(notificationsDuringGesture + 1); // no duplicate notification
    expect(new UserSettingsStore(window.localStorage).get().zoomLevel).toBe(1); // still unpersisted
  });

  test('a finger rejoining a cancelled sequence does not resume camera tracking', () => {
    const { root, stage, canvas } = mount(300, 300);
    const zoom = new ZoomControls(root, stage);

    dispatchTouch(canvas, 'touchstart', [touch(1, 100, 150, canvas), touch(2, 200, 150, canvas)]);
    dispatchTouch(canvas, 'touchmove', [touch(1, 50, 150, canvas), touch(2, 300, 150, canvas)]);
    expect(zoom.getScale()).toBeGreaterThan(1);

    dispatchTouch(canvas, 'touchcancel', [touch(1, 50, 150, canvas)]);
    expect(zoom.getScale()).toBe(1); // rolled back immediately

    // A new finger (3) joins while touch 1 is still down, bringing the
    // count back to 2 — this must NOT resume camera tracking.
    dispatchTouch(canvas, 'touchstart', [touch(1, 50, 150, canvas), touch(3, 400, 150, canvas)]);
    dispatchTouch(canvas, 'touchmove', [touch(1, -500, 150, canvas), touch(3, 900, 150, canvas)]);

    expect(zoom.getScale()).toBe(1); // untouched — tracking never resumed
    expect(currentPan(stage)).toEqual({ x: 0, y: 0 });

    // Both fingers eventually lift — still no persistence, no notification.
    const scaleChanges: number[] = [];
    zoom.onScaleChange = scale => scaleChanges.push(scale);
    dispatchTouch(canvas, 'touchend', []);

    expect(scaleChanges).toEqual([]);
    expect(zoom.getScale()).toBe(1);
    expect(new UserSettingsStore(window.localStorage).get().zoomLevel).toBe(1);
  });

  test('a touchcancel rolls back immediately even with a third touch still active, not just when exactly two are tracked', () => {
    const { root, stage, canvas } = mount(300, 300);
    const zoom = new ZoomControls(root, stage);

    // Track touches 1+2.
    dispatchTouch(canvas, 'touchstart', [touch(1, 100, 150, canvas), touch(2, 200, 150, canvas)]);
    dispatchTouch(canvas, 'touchmove', [touch(1, 50, 150, canvas), touch(2, 300, 150, canvas)]);
    expect(zoom.getScale()).toBeGreaterThan(1);

    // A third touch joins (still tracking 1+2 — a touchstart while already
    // tracking doesn't rebaseline by itself).
    dispatchTouch(canvas, 'touchstart', [
      touch(1, 50, 150, canvas), touch(2, 300, 150, canvas), touch(3, 400, 150, canvas),
    ]);

    // Touch 1 (half of the tracked pair) is cancelled; 2 and 3 remain — the
    // count stays >= 2, but a cancellation rolls back regardless of how
    // many touches are still down.
    dispatchTouch(canvas, 'touchcancel', [touch(2, 300, 150, canvas), touch(3, 400, 150, canvas)]);

    expect(zoom.getScale()).toBe(1);
    expect(currentPan(stage)).toEqual({ x: 0, y: 0 });

    // Touches 2 and 3 moving together afterward must have no effect —
    // camera tracking stays off for the rest of this cancelled sequence.
    dispatchTouch(canvas, 'touchmove', [touch(2, 320, 150, canvas), touch(3, 420, 150, canvas)]);
    expect(zoom.getScale()).toBe(1);
  });

  test('a tracked touch ending normally (not cancelled) still rebaselines against the remaining pair', () => {
    const { root, stage, canvas } = mount(300, 300);
    const zoom = new ZoomControls(root, stage);

    // Track touches 1+2.
    dispatchTouch(canvas, 'touchstart', [touch(1, 100, 150, canvas), touch(2, 200, 150, canvas)]);
    dispatchTouch(canvas, 'touchmove', [touch(1, 50, 150, canvas), touch(2, 300, 150, canvas)]);
    const scaleBeforeHandoff = zoom.getScale();
    expect(scaleBeforeHandoff).toBeGreaterThan(1);

    // A third touch joins (still tracking 1+2).
    dispatchTouch(canvas, 'touchstart', [
      touch(1, 50, 150, canvas), touch(2, 300, 150, canvas), touch(3, 400, 150, canvas),
    ]);
    // Touch 1 (half of the tracked pair) lifts *normally* — not cancelled.
    // 2 and 3 remain and the count stays >= 2: this must rebaseline, not
    // roll back — a normal touchend removing one of the tracked touches is
    // a different code path from touchcancel-triggered rollback.
    dispatchTouch(canvas, 'touchend', [touch(2, 300, 150, canvas), touch(3, 400, 150, canvas)]);

    // Touches 2 and 3 now move together with no distance change between
    // them. If the camera had NOT rebaselined (i.e. it were still comparing
    // against touch 1's last known position), this would read as a large,
    // spurious distance change and the scale would jump/collapse. With a
    // correct rebaseline, no distance change between 2 and 3 means no scale
    // change at all.
    dispatchTouch(canvas, 'touchmove', [touch(2, 320, 150, canvas), touch(3, 420, 150, canvas)]);

    expect(zoom.getScale()).toBeCloseTo(scaleBeforeHandoff);
  });
});
