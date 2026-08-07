import { mustQuery } from './dom-utils.js';
import { MIN_ZOOM, MAX_ZOOM, UserSettingsStore } from '../platform/user-settings-store.js';
import { canvasLogicalWidth, canvasLogicalHeight } from './rendering/layout.js';

const ZOOM_STEP = 0.25;
const ELIGIBLE_SURFACE_SELECTOR = '.game-stage, .demo-overlay';

interface Point {
  x: number;
  y: number;
}

// Pure geometry helpers, kept free of DOM/touch-event types so they're
// directly unit-testable without simulating real TouchEvents.

/**
 * Focal-point-preserving pinch update for `transform: translate(pan) scale(s)`
 * around a fixed center `C`. Also captures a plain two-finger pan (F0 -> F1
 * with no distance change) with no separate step — do not add midpoint
 * movement again on top of this.
 */
export function computeFocalZoom(params: {
  s0: number;
  distance0: number;
  distance1: number;
  F0: Point;
  F1: Point;
  C: Point;
  pan0: Point;
  minZoom: number;
  maxZoom: number;
}): { scale: number; pan: Point } {
  const { s0, distance0, distance1, F0, F1, C, pan0, minZoom, maxZoom } = params;
  const rawS1 = s0 * (distance1 / Math.max(distance0, 1));
  const s1 = Math.min(maxZoom, Math.max(minZoom, rawS1));
  const ratio = s1 / s0;
  return {
    scale: s1,
    pan: {
      x: F1.x - C.x - ratio * (F0.x - C.x - pan0.x),
      y: F1.y - C.y - ratio * (F0.y - C.y - pan0.y),
    },
  };
}

/** Clamps pan so the painted content rectangle always covers the stage. */
export function clampPan(
  pan: Point,
  scale: number,
  contentWidth: number,
  contentHeight: number,
  stageWidth: number,
  stageHeight: number,
): Point {
  const maxPanX = Math.max(0, (contentWidth * scale - stageWidth) / 2);
  const maxPanY = Math.max(0, (contentHeight * scale - stageHeight) / 2);
  return {
    x: Math.min(maxPanX, Math.max(-maxPanX, pan.x)),
    y: Math.min(maxPanY, Math.max(-maxPanY, pan.y)),
  };
}

/**
 * The rectangle the board is actually painted into. In every mode but demo
 * this is just the canvas's logical size (Renderer.resize() sets
 * canvas.style.width/height to exactly that). Demo mode forces the canvas
 * element itself to 100%/100% with `object-fit: contain` (styles/demo.css),
 * so the painted board is letterboxed inside that box instead.
 */
export function paintedContentSize(
  demoMode: boolean,
  canvasBoxWidth: number,
  canvasBoxHeight: number,
  intrinsicWidth: number,
  intrinsicHeight: number,
): { width: number; height: number } {
  if (!demoMode) return { width: intrinsicWidth, height: intrinsicHeight };
  if (canvasBoxWidth <= 0 || canvasBoxHeight <= 0) return { width: 0, height: 0 };
  const intrinsicRatio = intrinsicWidth / intrinsicHeight;
  const boxRatio = canvasBoxWidth / canvasBoxHeight;
  return intrinsicRatio > boxRatio
    ? { width: canvasBoxWidth, height: canvasBoxWidth / intrinsicRatio }
    : { width: canvasBoxHeight * intrinsicRatio, height: canvasBoxHeight };
}

function touchDistance(a: Touch, b: Touch): number {
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
}

function touchMidpoint(a: Touch, b: Touch): Point {
  return { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 };
}

function findTouch(e: TouchEvent, identifier: number): Touch | undefined {
  return Array.from(e.touches).find(t => t.identifier === identifier);
}

/**
 * Mobile-optimized zoom for the board + HUD, shared across every mode. Owns
 * transform state and the touch gesture only — the buttons that drive
 * zoomIn()/zoomOut()/resetZoom() live in each mode's game menu (HomeScreen,
 * MultiplayerPauseMenu), not here, so this class stays headless.
 *
 * `stage` is `.zoom-layer` (see ui-root.template.html), not the outer
 * `.game-stage` — `.game-stage` is the fixed, clipping viewport
 * (`overflow: hidden`) and is deliberately never transformed itself, or a
 * pan could move the clipping boundary and reveal empty page background
 * past the board's own edges (worst on the smallest phones, where the
 * MIN_CELL_SIZE-floored board can already exceed the viewport before any
 * zoom is applied). `.zoom-layer` fills `.game-stage` exactly and is what
 * actually gets `transform: translate(pan) scale(s)`.
 *
 * Pinch/pan is intercepted in the capture phase on `root`, above every
 * gameplay input handler, so single-finger gameplay input is never touched —
 * see the "Gesture interception" section of the implementation plan for the
 * full reasoning behind each piece of this state machine.
 */
export class ZoomControls {
  private readonly stage: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly settings = new UserSettingsStore();
  private readonly abortCtrl = new AbortController();

  /** Fires after any button- or gesture-driven scale change, incl. mid-pinch frames. */
  onScaleChange?: (scale: number) => void;

  private scale: number;
  private pan: Point = { x: 0, y: 0 };

  // Suppression stays true for the whole tainted touch sequence, even after
  // the count drops below 2 — see the tap-through bug this guards against.
  private sequenceIsMultiTouch = false;
  // Only true while >=2 touches are simultaneously down; gates the per-frame
  // camera update separately from suppression.
  private cameraTracking = false;
  // Sticky for the whole sequence once any touchcancel fires during it, even
  // if that specific event still leaves other touches active — otherwise a
  // partially-cancelled gesture (e.g. one of two touches cancels, the other
  // survives to a normal touchend) would commit instead of rolling back.
  private sequenceWasCancelled = false;

  private sequenceStartScale = MIN_ZOOM;
  private sequenceStartPan: Point = { x: 0, y: 0 };
  private center: Point = { x: 0, y: 0 };
  // Identifiers of the two touches the camera is currently reading, not just
  // their positions — e.touches[0]/[1] can silently refer to a different
  // physical pair between frames (a third finger present, or one of the
  // tracked two ending while another stays down), which would otherwise
  // compute a distance/midpoint delta between touches that were never
  // actually a consistent pair.
  private trackedIds: [number, number] | null = null;
  private prevMidpoint: Point = { x: 0, y: 0 };
  private prevDistance = 0;

  constructor(root: HTMLElement, stage: HTMLElement) {
    this.stage = stage;
    this.canvas = mustQuery(stage, 'canvas');

    this.scale = this.settings.get().zoomLevel;
    this.applyTransform();

    const sig = { signal: this.abortCtrl.signal };
    root.addEventListener('touchstart', this.onTouchStart, { ...sig, capture: true, passive: false });
    root.addEventListener('touchmove', this.onTouchMove, { ...sig, capture: true, passive: false });
    root.addEventListener('touchend', e => this.onTouchEnd(e, false), { ...sig, capture: true, passive: false });
    root.addEventListener('touchcancel', e => this.onTouchEnd(e, true), { ...sig, capture: true, passive: false });
  }

  destroy(): void {
    this.abortCtrl.abort();
  }

  getScale(): number {
    return this.scale;
  }

  // ─── Public API (called by each mode's game-menu buttons) ────────────────

  zoomIn(): void {
    this.stepButton(ZOOM_STEP);
  }

  zoomOut(): void {
    this.stepButton(-ZOOM_STEP);
  }

  resetZoom(): void {
    this.scale = MIN_ZOOM;
    this.pan = { x: 0, y: 0 };
    this.applyTransform(true);
    this.settings.setZoomLevel(this.scale);
    this.onScaleChange?.(this.scale);
  }

  private stepButton(delta: number): void {
    const s1 = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.scale + delta));
    const ratio = s1 / this.scale;
    const rawPan: Point = { x: this.pan.x * ratio, y: this.pan.y * ratio };
    this.scale = s1;
    this.pan = this.clampCurrentPan(rawPan, s1);
    this.applyTransform(true);
    this.settings.setZoomLevel(this.scale);
    this.onScaleChange?.(this.scale);
  }

  // ─── Gesture ───────────────────────────────────────────────────────────

  private isEligible(e: TouchEvent): boolean {
    return Array.from(e.touches).every(t =>
      t.target instanceof Element && t.target.closest(ELIGIBLE_SURFACE_SELECTOR) !== null);
  }

  private beginCameraTracking(e: TouchEvent): void {
    const t0 = e.touches[0];
    const t1 = e.touches[1];
    if (!t0 || !t1) return;
    this.cameraTracking = true;
    this.trackedIds = [t0.identifier, t1.identifier];
    this.prevMidpoint = touchMidpoint(t0, t1);
    this.prevDistance = touchDistance(t0, t1);
  }

  /** The two touches this.trackedIds points to, or undefined if either has ended. */
  private currentTrackedPair(e: TouchEvent): [Touch, Touch] | undefined {
    if (!this.trackedIds) return undefined;
    const t0 = findTouch(e, this.trackedIds[0]);
    const t1 = findTouch(e, this.trackedIds[1]);
    return t0 && t1 ? [t0, t1] : undefined;
  }

  private computeCenter(): Point {
    const rect = this.stage.getBoundingClientRect();
    return {
      x: rect.left + rect.width / 2 - this.pan.x,
      y: rect.top + rect.height / 2 - this.pan.y,
    };
  }

  private onTouchStart = (e: TouchEvent): void => {
    if (!this.sequenceIsMultiTouch && e.touches.length >= 2) {
      if (this.isEligible(e)) {
        this.sequenceIsMultiTouch = true;
        this.sequenceStartScale = this.scale;
        this.sequenceStartPan = { ...this.pan };
        this.center = this.computeCenter();
        this.beginCameraTracking(e);
      }
    } else if (
      this.sequenceIsMultiTouch && !this.sequenceWasCancelled
      && !this.cameraTracking && e.touches.length >= 2
    ) {
      // A finger came back after a 2->1 drop mid-sequence: rebaseline
      // instead of resuming from the stale pre-drop reference frame. Never
      // for an already-cancelled sequence — a finger rejoining a cancelled
      // gesture must not resume camera tracking.
      this.beginCameraTracking(e);
    }

    if (this.sequenceIsMultiTouch) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  private onTouchMove = (e: TouchEvent): void => {
    if (this.sequenceIsMultiTouch) {
      e.preventDefault();
      e.stopPropagation();
    }
    if (!this.cameraTracking || e.touches.length < 2) return;

    let pair = this.currentTrackedPair(e);
    if (!pair) {
      // The tracked pair changed underneath us (one of the two touches we
      // were reading ended while a different one is still active, but the
      // count stayed >= 2) — rebaseline against whatever pair is active now
      // instead of computing a delta against touches that were never
      // actually a consistent pair.
      this.beginCameraTracking(e);
      pair = this.currentTrackedPair(e);
      if (!pair) return;
    }
    const [t0, t1] = pair;

    const F1 = touchMidpoint(t0, t1);
    const distance1 = touchDistance(t0, t1);
    const { scale, pan } = computeFocalZoom({
      s0: this.scale,
      distance0: this.prevDistance,
      distance1,
      F0: this.prevMidpoint,
      F1,
      C: this.center,
      pan0: this.pan,
      minZoom: MIN_ZOOM,
      maxZoom: MAX_ZOOM,
    });

    this.scale = scale;
    this.pan = this.clampCurrentPan(pan, scale);
    this.prevMidpoint = F1;
    this.prevDistance = distance1;
    this.applyTransform();
    this.onScaleChange?.(this.scale);
  };

  private onTouchEnd = (e: TouchEvent, cancelled: boolean): void => {
    if (this.sequenceIsMultiTouch) {
      e.preventDefault();
      e.stopPropagation();
    }

    if (cancelled && this.sequenceIsMultiTouch && !this.sequenceWasCancelled) {
      // The *first* touchcancel in this sequence rolls back immediately —
      // don't wait for the sequence to reach zero touches. sequenceIsMultiTouch
      // and sequenceWasCancelled both stay true until it does, though, so
      // every further event in this sequence (including the eventual
      // touchend from a surviving finger) keeps being suppressed instead of
      // being read as a fresh gameplay tap.
      this.sequenceWasCancelled = true;
      this.cameraTracking = false;
      this.trackedIds = null;
      this.scale = this.sequenceStartScale;
      this.pan = this.sequenceStartPan;
      this.applyTransform();
      this.onScaleChange?.(this.scale);
    }

    if (e.touches.length >= 2) {
      // Still tracking with remaining touches — but never resume/rebaseline
      // camera tracking once this sequence has been cancelled, even if
      // another finger joins and the count climbs back to >= 2. For a
      // still-clean sequence, rebaseline if the pair we were reading just
      // changed (one of the two tracked touches ended, a different one is
      // still down) rather than leaving a stale reference frame for the
      // next touchmove to trip on.
      if (!this.sequenceWasCancelled && this.cameraTracking && !this.currentTrackedPair(e)) {
        this.beginCameraTracking(e);
      }
      return;
    }
    if (e.touches.length === 1) {
      // Dropped from >=2 to exactly 1 — freeze the camera (no second touch
      // to read a distance/midpoint from; already off if cancelled), but
      // keep suppressing gameplay events for the rest of this sequence.
      this.cameraTracking = false;
      return;
    }

    // e.touches.length === 0: the sequence is over.
    if (this.sequenceIsMultiTouch && !this.sequenceWasCancelled) {
      // Clean gesture: commit. A cancelled sequence already rolled back and
      // fired onScaleChange the moment it was cancelled, above — no
      // duplicate notification, and nothing to persist here.
      this.settings.setZoomLevel(this.scale);
      this.onScaleChange?.(this.scale);
    }
    this.sequenceIsMultiTouch = false;
    this.cameraTracking = false;
    this.trackedIds = null;
    this.sequenceWasCancelled = false;
  };

  private clampCurrentPan(pan: Point, scale: number): Point {
    const demoMode = document.documentElement.classList.contains('demo-mode');
    const { width, height } = paintedContentSize(
      demoMode,
      this.canvas.clientWidth,
      this.canvas.clientHeight,
      canvasLogicalWidth(),
      canvasLogicalHeight(),
    );
    return clampPan(pan, scale, width, height, this.stage.clientWidth, this.stage.clientHeight);
  }

  /**
   * Re-clamps pan against the current stage/canvas geometry. Callers must
   * invoke this themselves, after `Renderer.resize()` has already run for
   * the same resize/orientation-change event — not via a `window.resize`
   * listener registered independently in this class' constructor, since two
   * separately-registered listeners fire in registration order and a
   * `ZoomControls` constructed before its mode controller (as main.ts does)
   * would otherwise reclamp against the stage's *pre*-resize dimensions.
   */
  reclampPan(): void {
    this.pan = this.clampCurrentPan(this.pan, this.scale);
    this.applyTransform();
  }

  private applyTransform(animated = false): void {
    this.stage.classList.toggle('zoom-layer--transitioning', animated);
    this.stage.style.transformOrigin = 'center';
    this.stage.style.transform = `translate(${this.pan.x}px, ${this.pan.y}px) scale(${this.scale})`;
  }
}
