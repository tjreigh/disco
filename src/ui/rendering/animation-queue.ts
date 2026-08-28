import type { PhysicsStep } from '../../game/events.js';
import { StepKind } from '../../game/events.js';
import { DROP_MS_PER_ROW, FLASH_MS, CLEAR_MS, FALL_MS_PER_ROW, REVEAL_MS, PUSH_MS, gridDistance } from '../../game/animation-timing.js';
import type { Disc, GridPos } from '../../game/model.js';
import type { RichDiscAnimation, GravityShiftCue, ScoreIndicator, ScorePopup } from './animation-types.js';
import { AnimPhase } from './animation-types.js';
import { cellCenterY, cellCenterX, gridRows, gridCols } from './layout.js';

const SCORE_POPUP_MS = 800;
const SCORE_INDICATOR_MS = 1_100;
const GRAVITY_SHIFT_MS = 550;

function easeInOutQuad(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
}

function easeOutCubic(t: number): number {
  return 1 - (1 - t) ** 3;
}

function makeAnim(
  disc: Disc, phase: AnimPhase,
  now: number, duration: number,
  fromX: number, fromY: number,
  toX: number, toY: number,
  waypoints?: { x: number; y: number }[],
): RichDiscAnimation {
  return {
    discId: disc.id, disc, phase,
    startTime: now, duration,
    fromX, toX, fromY, toY,
    alpha: 1, scale: 1, progress: 0,
    ...(waypoints ? { waypoints } : {}),
  };
}

/** Sum of hop distances along a multi-point grid path, e.g. for duration scaling. */
function pathDistance(path: readonly GridPos[]): number {
  let total = 0;
  for (let i = 1; i < path.length; i++) total += gridDistance(path[i - 1]!, path[i]!);
  return total;
}

// Walks a canvas-space polyline to the point `t` (0-1) of the way along its
// total length — used to follow a bent Falling path instead of a straight
// line. Segment lengths are weighted by actual pixel distance so a disc
// moves at a roughly constant speed across hops of different grid lengths.
function pointAlongPath(waypoints: readonly { x: number; y: number }[], t: number): { x: number; y: number } {
  const segLengths = waypoints.slice(1).map((p, i) => Math.hypot(p.x - waypoints[i]!.x, p.y - waypoints[i]!.y));
  const total = segLengths.reduce((sum, len) => sum + len, 0);
  if (total === 0) return waypoints[waypoints.length - 1]!;

  let target = t * total;
  for (let i = 0; i < segLengths.length; i++) {
    const len = segLengths[i]!;
    if (target <= len || i === segLengths.length - 1) {
      const segT = len === 0 ? 0 : Math.min(1, target / len);
      const a = waypoints[i]!;
      const b = waypoints[i + 1]!;
      return { x: a.x + (b.x - a.x) * segT, y: a.y + (b.y - a.y) * segT };
    }
    target -= len;
  }
  return waypoints[waypoints.length - 1]!;
}

/**
 * Sequences {@link PhysicsStep}s one at a time, converting each into a set of
 * concurrent {@link RichDiscAnimation}s.
 *
 * @remarks
 * When every animation for a step reaches `progress === 1` the queue advances to
 * the next step; when every step is done, `onComplete` is called.
 */
export class AnimationQueue {
  private steps: PhysicsStep[];
  private stepIndex = 0;
  private active: RichDiscAnimation[] = [];
  // -1 is a sentinel meaning "no step has started yet for this index".
  private stepStartTime = -1;
  // Tracks whether onComplete has fired, independent of isDone(): a queue
  // constructed with a genuinely empty steps array is isDone() from the very
  // first tick, before startStep/advance ever run — relying on isDone() alone
  // to decide whether to call onComplete would silently never call it for
  // that case (tick()'s old top guard just returned immediately forever, and
  // the caller's phase would never flip back). This flag makes onComplete
  // fire exactly once regardless of whether the queue had zero steps to
  // begin with or ran out normally.
  private completed = false;
  private onStepStart: (step: PhysicsStep, now: DOMHighResTimeStamp) => void;
  private onStepComplete: (step: PhysicsStep) => void;
  private onComplete: () => void;

  constructor(
    steps: PhysicsStep[],
    onStepStart: (step: PhysicsStep, now: DOMHighResTimeStamp) => void,
    onStepComplete: (step: PhysicsStep) => void,
    onComplete: () => void,
  ) {
    this.steps = steps;
    this.onStepStart = onStepStart;
    this.onStepComplete = onStepComplete;
    this.onComplete = onComplete;
  }

  // Must be called every rAF frame. Updates progress on active animations and
  // advances to the next step when they all complete.
  tick(now: DOMHighResTimeStamp): void {
    if (this.completed) return;

    if (this.stepStartTime < 0) {
      this.stepStartTime = now;
      this.startStep(now);
      if (this.completed) return;
    }

    for (const anim of this.active) {
      const elapsed = now - anim.startTime;
      anim.progress = Math.min(1, elapsed / anim.duration);
      this.updateAnimProps(anim);
    }

    if (this.active.length > 0 && this.active.every(a => a.progress >= 1)) {
      this.advance(now);
    }
  }

  private updateAnimProps(anim: RichDiscAnimation): void {
    switch (anim.phase) {
      case AnimPhase.Dropping:
      case AnimPhase.Falling:
      case AnimPhase.Pushing:
        anim.alpha = 1;
        anim.scale = 1;
        break;
      case AnimPhase.Flashing: {
        // Single animation covers flash + fade-out in one progress range.
        // First flashRatio: pulse scale (visible flash). Rest: fade out and shrink.
        const flashRatio = FLASH_MS / (FLASH_MS + CLEAR_MS);
        if (anim.progress < flashRatio) {
          const t = anim.progress / flashRatio;
          anim.scale = 1 + Math.sin(t * Math.PI * 4) * 0.1;
          anim.alpha = 1;
        } else {
          const t = (anim.progress - flashRatio) / (1 - flashRatio);
          anim.alpha = 1 - easeInOutQuad(t);
          anim.scale = 1 - easeInOutQuad(t) * 0.6;
        }
        break;
      }
      case AnimPhase.Revealing:
        // Briefly scale up and back down so the newly-revealed number pops.
        anim.alpha = 1;
        anim.scale = 1 + Math.sin(anim.progress * Math.PI) * 0.2;
        break;
      case AnimPhase.Clearing:
        // No longer set by this queue; handled inside Flashing above.
        break;
    }
  }

  private advance(now: DOMHighResTimeStamp): void {
    // Capture before incrementing so the callback receives the step that just finished.
    const completedStep = this.steps[this.stepIndex];
    this.stepIndex++;
    this.active = [];
    this.stepStartTime = -1;

    if (completedStep) {
      // Update the visual board before starting the next step's animations so
      // static discs render at the correct post-step positions this frame.
      this.onStepComplete(completedStep);
    }

    if (this.isDone()) {
      this.completed = true;
      this.onComplete();
      return;
    }

    this.stepStartTime = now;
    this.startStep(now);
  }

  private startStep(now: DOMHighResTimeStamp): void {
    const step = this.steps[this.stepIndex];
    if (!step) { this.completed = true; this.onComplete(); return; }
    this.onStepStart(step, now);

    switch (step.kind) {
      case StepKind.Drop: {
        // entryPos is one cell beyond whichever edge the disc entered through
        // (row -1 for classic top entry), so distance already includes that
        // extra cell's worth of travel time.
        const distance = gridDistance(step.entryPos, step.landPos);
        const duration = Math.max(120, DROP_MS_PER_ROW * distance);
        this.active.push(makeAnim(
          step.disc, AnimPhase.Dropping, now, duration,
          cellCenterX(step.entryPos.col), cellCenterY(step.entryPos.row),
          cellCenterX(step.landPos.col), cellCenterY(step.landPos.row),
        ));
        break;
      }

      case StepKind.Clear: {
        // Single animation per disc covers the flash pulse and the fade-out in
        // sequence. updateAnimProps handles the two sub-phases via progress ratio.
        for (let i = 0; i < step.cleared.length; i++) {
          const pos  = step.cleared[i]!;
          const disc = step.discs[i]!;
          const x = cellCenterX(pos.col);
          const y = cellCenterY(pos.row);
          const anim = makeAnim(disc, AnimPhase.Flashing, now, FLASH_MS + CLEAR_MS, x, y, x, y);
          this.active.push(anim);
        }
        break;
      }

      case StepKind.Fall: {
        if (step.moves.length === 0) { this.advance(now); return; }
        for (const move of step.moves) {
          // Follow the disc's actual route when it bent (routed around
          // obstacles across several settling passes) rather than a straight
          // line that can visually cut through/past discs it never really
          // passed — see settleContinuous's `path` for how this is built. A
          // plain two-point move (the common case) keeps the original
          // straight-line animation untouched.
          const bentPath = move.path && move.path.length > 2 ? move.path : undefined;
          const waypoints = bentPath?.map(pos => ({ x: cellCenterX(pos.col), y: cellCenterY(pos.row) }));
          // Duration scales with the real distance traveled (which can exceed
          // the straight-line distance for a bent path) so all falling discs
          // arrive at roughly the same velocity.
          const duration = Math.max(80, FALL_MS_PER_ROW * pathDistance(bentPath ?? [move.from, move.to]));
          this.active.push(makeAnim(
            move.disc, AnimPhase.Falling, now, duration,
            cellCenterX(move.from.col), cellCenterY(move.from.row),
            cellCenterX(move.to.col), cellCenterY(move.to.row),
            waypoints,
          ));
        }
        break;
      }

      case StepKind.Reveal: {
        if (step.positions.length === 0) { this.advance(now); return; }
        for (let i = 0; i < step.positions.length; i++) {
          const pos  = step.positions[i]!;
          const disc = step.discs[i]!;
          const x = cellCenterX(pos.col);
          const y = cellCenterY(pos.row);
          // disc.kind is already updated (physics ran eagerly), so the pulse
          // animation shows the disc in its new, revealed appearance.
          this.active.push(makeAnim(disc, AnimPhase.Revealing, now, REVEAL_MS, x, y, x, y));
        }
        break;
      }

      case StepKind.Push: {
        // Animate each new disc sliding in from one cell beyond whichever
        // edge it entered (step.edge — the side gravity currently pulls
        // toward, see computePushStep) into its resting lane just inside
        // the grid. 'top'/'bottom' slides vertically, indexed by column;
        // 'left'/'right' slides horizontally, indexed by row.
        const vertical = step.edge === 'top' || step.edge === 'bottom';
        const enterIndex = step.edge === 'bottom' ? gridRows() : step.edge === 'top' ? -1
          : step.edge === 'right' ? gridCols() : -1;
        const restIndex = step.edge === 'bottom' ? gridRows() - 1 : step.edge === 'top' ? 0
          : step.edge === 'right' ? gridCols() - 1 : 0;
        for (let i = 0; i < step.newDiscs.length; i++) {
          const disc = step.newDiscs[i];
          if (!disc) continue;
          const fromX = vertical ? cellCenterX(i) : cellCenterX(enterIndex);
          const toX   = vertical ? cellCenterX(i) : cellCenterX(restIndex);
          const fromY = vertical ? cellCenterY(enterIndex) : cellCenterY(i);
          const toY   = vertical ? cellCenterY(restIndex) : cellCenterY(i);
          this.active.push(makeAnim(disc, AnimPhase.Pushing, now, PUSH_MS, fromX, fromY, toX, toY));
        }
        break;
      }

      case StepKind.Bonus:
        // Score indicators have their own lifetime, so this event does not
        // need to hold up board animation playback.
        this.advance(now);
        break;
    }
  }

  getActiveAnimations(): readonly RichDiscAnimation[] {
    return this.active;
  }

  shiftTime(deltaMs: number): void {
    if (!Number.isFinite(deltaMs) || deltaMs <= 0) return;
    if (this.stepStartTime >= 0) this.stepStartTime += deltaMs;
    for (const anim of this.active) {
      anim.startTime += deltaMs;
    }
  }

  isDone(): boolean {
    return this.stepIndex >= this.steps.length;
  }
}

export function spawnScoreIndicator(
  title: string,
  detail: string,
  now: DOMHighResTimeStamp,
): ScoreIndicator {
  return {
    title, detail, startTime: now, duration: SCORE_INDICATOR_MS,
    progress: 0, alpha: 1, scale: 0.85,
  };
}

export function tickScoreIndicators(
  indicators: readonly ScoreIndicator[],
  now: DOMHighResTimeStamp,
): ScoreIndicator[] {
  return indicators.flatMap(indicator => {
    const progress = Math.min(1, (now - indicator.startTime) / indicator.duration);
    if (progress >= 1) return [];
    const fadeStart = 0.55;
    const alpha = progress <= fadeStart ? 1 : 1 - (progress - fadeStart) / (1 - fadeStart);
    return [{
      ...indicator,
      progress,
      alpha,
      scale: 0.85 + 0.15 * easeOutCubic(Math.min(1, progress * 5)),
    }];
  });
}

/**
 * Interpolates an animation's Y canvas position with easeOutCubic, so the disc
 * decelerates as it approaches its destination.
 *
 * @remarks
 * When the animation has waypoints (a bent path), the eased progress walks the
 * actual polyline instead of a straight line between the endpoints.
 */
export function interpolateY(anim: RichDiscAnimation): number {
  const t = easeOutCubic(anim.progress);
  if (anim.waypoints && anim.waypoints.length > 2) return pointAlongPath(anim.waypoints, t).y;
  return anim.fromY + (anim.toY - anim.fromY) * t;
}

/**
 * Shared board offset during a Push step, when the settled board slides in
 * lockstep with the incoming row or column.
 *
 * @remarks
 * 0 when no push is active, or when the push doesn't move on this axis
 * (top/bottom → Y only, left/right → X only).
 */
export function pushBoardOffsetX(anims: readonly RichDiscAnimation[]): number {
  const push = anims.find(a => a.phase === AnimPhase.Pushing);
  if (!push || push.fromX === push.toX) return 0;
  return interpolateX(push) - push.fromX;
}

export function pushBoardOffsetY(anims: readonly RichDiscAnimation[]): number {
  const push = anims.find(a => a.phase === AnimPhase.Pushing);
  if (!push || push.fromY === push.toY) return 0;
  return interpolateY(push) - push.fromY;
}

export function interpolateX(anim: RichDiscAnimation): number {
  const t = easeOutCubic(anim.progress);
  if (anim.waypoints && anim.waypoints.length > 2) return pointAlongPath(anim.waypoints, t).x;
  return anim.fromX + (anim.toX - anim.fromX) * t;
}

/**
 * Creates one floating "+N" popup per cleared position, all sharing the same
 * per-disc value — every disc cleared in one chain step earns the same amount.
 */
export function spawnScorePopups(
  cleared: readonly GridPos[],
  value: number,
  now: DOMHighResTimeStamp,
): ScorePopup[] {
  return cleared.map(pos => ({
    value, col: pos.col, row: pos.row,
    startTime: now, duration: SCORE_POPUP_MS,
    progress: 0, alpha: 1, yOffset: 0,
  }));
}

const POPUP_DRIFT_PX = 28;

/**
 * Advances each popup's progress, alpha, and yOffset, dropping any that have
 * fully faded.
 *
 * @remarks
 * Popups live independently of {@link AnimationQueue}'s per-step active list, so
 * one from an earlier chain level can keep fading while a later level's flash
 * begins.
 */
export function tickScorePopups(
  popups: readonly ScorePopup[],
  now: DOMHighResTimeStamp,
): ScorePopup[] {
  const next: ScorePopup[] = [];
  for (const p of popups) {
    const progress = Math.min(1, (now - p.startTime) / p.duration);
    if (progress >= 1) continue; // fully faded — pruned
    next.push({
      ...p,
      progress,
      alpha: 1 - easeInOutQuad(progress),
      yOffset: POPUP_DRIFT_PX * easeOutCubic(progress),
    });
  }
  return next;
}

/**
 * Marks the instant a Gravity tilt commits, so the renderer can sweep the
 * ambient wash to the new direction and flash an edge-glow bar instead of
 * snapping both on the first post-commit frame.
 *
 * @remarks
 * Ticked each frame by game-controller's loop, independent of
 * {@link AnimationQueue}. Short fixed duration (~`PUSH_MS`), regardless of how
 * long the physics animation runs.
 */
export function spawnGravityShiftCue(
  fromAngle: number,
  toAngle: number,
  now: DOMHighResTimeStamp,
): GravityShiftCue {
  return {
    fromAngle, toAngle,
    startTime: now, duration: GRAVITY_SHIFT_MS,
    progress: 0, angle: fromAngle, alpha: 0,
  };
}

/**
 * Advances the cue's progress, eased angle, and sine-pulse alpha; returns `null`
 * once expired (like {@link tickScorePopups} pruning).
 *
 * @remarks
 * The angle takes the shortest signed path from `fromAngle` to `toAngle` — a
 * sweep past 0° (e.g. 315° → 0°) rotates forward through 0, not back through
 * 180°. Alpha is a single `sin(π·progress)` pulse: fade in, peak, fade out.
 */
export function tickGravityShiftCue(
  cue: GravityShiftCue | null,
  now: DOMHighResTimeStamp,
): GravityShiftCue | null {
  if (!cue) return null;
  const progress = Math.min(1, (now - cue.startTime) / cue.duration);
  if (progress >= 1) return null; // expired — pruned
  let delta = cue.toAngle - cue.fromAngle;
  if (delta > 180) delta -= 360;
  else if (delta < -180) delta += 360;
  const t = easeInOutQuad(progress);
  return {
    ...cue,
    progress,
    angle: cue.fromAngle + delta * t,
    alpha: Math.sin(progress * Math.PI),
  };
}
