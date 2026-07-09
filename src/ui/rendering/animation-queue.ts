import type { PhysicsStep } from '../../game/events.js';
import { StepKind } from '../../game/events.js';
import type { Disc, GridPos } from '../../game/model.js';
import type { RichDiscAnimation, ScoreIndicator, ScorePopup } from './animation-types.js';
import { AnimPhase } from './animation-types.js';
import { cellCenterY, cellCenterX, gridRows } from './layout.js';

const DROP_MS_PER_ROW = 60;
const FLASH_MS = 280;
const CLEAR_MS = 320;
const FALL_MS_PER_ROW = 55;
const REVEAL_MS = 350;
const PUSH_MS = 420;
const SCORE_POPUP_MS = 800;
const SCORE_INDICATOR_MS = 1_100;

function easeInOutQuad(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
}

function easeOutCubic(t: number): number {
  return 1 - (1 - t) ** 3;
}

function makeAnim(
  disc: Disc, col: number, phase: AnimPhase,
  now: number, duration: number,
  fromY: number, toY: number,
): RichDiscAnimation {
  return { discId: disc.id, disc, col, phase, startTime: now, duration, fromY, toY, alpha: 1, scale: 1, progress: 0 };
}

// Sequences PhysicsSteps one at a time, converting each into a set of
// concurrent RichDiscAnimations. When all animations for a step reach
// progress=1, the queue advances to the next step. When all steps are done,
// onComplete is called.
export class AnimationQueue {
  private steps: PhysicsStep[];
  private stepIndex = 0;
  private active: RichDiscAnimation[] = [];
  // -1 is a sentinel meaning "no step has started yet for this index".
  private stepStartTime = -1;
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
    if (this.isDone()) return;

    if (this.stepStartTime < 0) {
      this.stepStartTime = now;
      this.startStep(now);
      if (this.isDone()) return; // step was empty and auto-advanced
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
      this.onComplete();
      return;
    }

    this.stepStartTime = now;
    this.startStep(now);
  }

  private startStep(now: DOMHighResTimeStamp): void {
    const step = this.steps[this.stepIndex];
    if (!step) { this.onComplete(); return; }
    this.onStepStart(step, now);

    switch (step.kind) {
      case StepKind.Drop: {
        // toLandRow + 1: row 0 is a full cell below the start position (row -1),
        // so even landing on row 0 needs one row's worth of travel time.
        const duration = Math.max(120, DROP_MS_PER_ROW * (step.toLandRow + 1));
        const fromY = cellCenterY(-1); // one cell above the grid
        const toY   = cellCenterY(step.toLandRow);
        this.active.push(makeAnim(step.disc, step.col, AnimPhase.Dropping, now, duration, fromY, toY));
        break;
      }

      case StepKind.Clear: {
        // Single animation per disc covers the flash pulse and the fade-out in
        // sequence. updateAnimProps handles the two sub-phases via progress ratio.
        for (let i = 0; i < step.cleared.length; i++) {
          const pos  = step.cleared[i]!;
          const disc = step.discs[i]!;
          const y = cellCenterY(pos.row);
          const anim = makeAnim(disc, pos.col, AnimPhase.Flashing, now, FLASH_MS + CLEAR_MS, y, y);
          this.active.push(anim);
        }
        break;
      }

      case StepKind.Fall: {
        if (step.moves.length === 0) { this.advance(now); return; }
        for (const move of step.moves) {
          // Duration scales with distance so all falling discs arrive at the same velocity.
          const rows     = move.to.row - move.from.row;
          const duration = Math.max(80, FALL_MS_PER_ROW * rows);
          this.active.push(makeAnim(
            move.disc, move.to.col, AnimPhase.Falling, now, duration,
            cellCenterY(move.from.row), cellCenterY(move.to.row),
          ));
        }
        break;
      }

      case StepKind.Reveal: {
        if (step.positions.length === 0) { this.advance(now); return; }
        for (let i = 0; i < step.positions.length; i++) {
          const pos  = step.positions[i]!;
          const disc = step.discs[i]!;
          const y = cellCenterY(pos.row);
          // disc.kind is already updated (physics ran eagerly), so the pulse
          // animation shows the disc in its new, revealed appearance.
          this.active.push(makeAnim(disc, pos.col, AnimPhase.Revealing, now, REVEAL_MS, y, y));
        }
        break;
      }

      case StepKind.Push: {
        // Animate each new disc sliding up from one row below the grid.
        const fromY = cellCenterY(gridRows());     // one cell below the bottom row
        const toY   = cellCenterY(gridRows() - 1); // bottom row
        for (let c = 0; c < step.newRow.length; c++) {
          const disc = step.newRow[c];
          if (!disc) continue;
          this.active.push(makeAnim(disc, c, AnimPhase.Pushing, now, PUSH_MS, fromY, toY));
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

// Interpolates the Y canvas position for an animation using easeOutCubic,
// giving a natural deceleration as the disc approaches its destination.
export function interpolateY(anim: RichDiscAnimation): number {
  const t = easeOutCubic(anim.progress);
  return anim.fromY + (anim.toY - anim.fromY) * t;
}

// During a Push step the whole settled board must rise in lockstep with the
// sliding new row; this returns the shared Y offset (0 when no push is active).
export function pushBoardOffsetY(anims: readonly RichDiscAnimation[]): number {
  const push = anims.find(a => a.phase === AnimPhase.Pushing);
  return push ? interpolateY(push) - push.fromY : 0;
}

// X position doesn't interpolate — discs always stay in their column.
export function interpolateX(anim: RichDiscAnimation): number {
  return cellCenterX(anim.col);
}

// Creates one floating "+N" popup per cleared position, all sharing the same
// per-disc value — every disc cleared in one chain step earns the same amount.
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

// Advances each popup's progress/alpha/yOffset and drops any that have fully
// faded. Popups live independently of AnimationQueue's per-step active[]
// array so one from an earlier chain level can keep fading while a later
// level's flash begins.
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
