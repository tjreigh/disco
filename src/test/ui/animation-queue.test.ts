import { beforeEach, describe, expect, it } from 'vitest';
import { AnimationQueue, pushBoardOffsetY } from '../../ui/rendering/animation-queue.js';
import { AnimPhase } from '../../ui/rendering/animation-types.js';
import type { RichDiscAnimation } from '../../ui/rendering/animation-types.js';
import { cellCenterY, gridCols, gridRows, setGridSize } from '../../ui/rendering/layout.js';
import { makeDisc } from '../../game/disc.js';
import { DiscKind } from '../../game/model.js';
import type { DropStep, ClearStep, FallStep, PushStep, BonusStep } from '../../game/events.js';
import { StepKind } from '../../game/events.js';

// Mirrors the module's private easeOutCubic — pushBoardOffsetY isn't exported
// so the module doesn't provide a way to derive the expected mid-flight value
// other than replicating the documented easing formula independently.
function easeOutCubic(t: number): number {
  return 1 - (1 - t) ** 3;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeQueue(
  steps: Array<DropStep | ClearStep | FallStep | PushStep | BonusStep>,
) {
  const stepStarts: Array<{ step: unknown; now: number }> = [];
  const stepCompletes: unknown[] = [];
  let completeCount = 0;

  const queue = new AnimationQueue(
    steps,
    (step, now) => stepStarts.push({ step, now }),
    step => stepCompletes.push(step),
    () => { completeCount++; },
  );

  return { queue, stepStarts, stepCompletes, completeCount: () => completeCount };
}

function fakeAnim(phase: AnimPhase): RichDiscAnimation {
  return {
    discId: 1,
    disc: makeDisc(1, DiscKind.Numbered),
    col: 0,
    phase,
    startTime: 0,
    duration: 100,
    fromY: 0,
    toY: 100,
    alpha: 1,
    scale: 1,
    progress: 0,
  };
}

// ─── Sequencing & callbacks ─────────────────────────────────────────────────

describe('AnimationQueue sequencing', () => {
  it('runs steps strictly one at a time, firing callbacks in order', () => {
    const dropStep: DropStep = { kind: StepKind.Drop, disc: makeDisc(3, DiscKind.Numbered), col: 2, toLandRow: 0 };
    const clearStep: ClearStep = {
      kind: StepKind.Clear,
      cleared: [{ row: 0, col: 2 }],
      discs: [makeDisc(3, DiscKind.Numbered)],
      chainLevel: 0,
      pointsAwarded: 10,
    };
    const fallDisc = makeDisc(4, DiscKind.Numbered);
    const fallStep: FallStep = {
      kind: StepKind.Fall,
      moves: [{ from: { row: 0, col: 1 }, to: { row: 1, col: 1 }, disc: fallDisc }],
    };

    const { queue, stepStarts, stepCompletes, completeCount } = makeQueue([dropStep, clearStep, fallStep]);

    // Drop duration: max(120, 60 * (toLandRow + 1)) = max(120, 60) = 120.
    queue.tick(0);
    expect(stepStarts).toEqual([{ step: dropStep, now: 0 }]);
    expect(stepCompletes).toEqual([]);
    expect(queue.isDone()).toBe(false);

    // Midway through the drop — nothing should advance yet.
    queue.tick(60);
    expect(stepStarts.length).toBe(1);
    expect(stepCompletes.length).toBe(0);

    // Drop completes exactly at t=120; queue should immediately start Clear.
    queue.tick(120);
    expect(stepCompletes).toEqual([dropStep]);
    expect(stepStarts).toEqual([
      { step: dropStep, now: 0 },
      { step: clearStep, now: 120 },
    ]);
    expect(queue.isDone()).toBe(false);
    expect(completeCount()).toBe(0);

    // Clear duration: FLASH_MS + CLEAR_MS = 280 + 320 = 600. Completes at t=720.
    queue.tick(720);
    expect(stepCompletes).toEqual([dropStep, clearStep]);
    expect(stepStarts).toEqual([
      { step: dropStep, now: 0 },
      { step: clearStep, now: 120 },
      { step: fallStep, now: 720 },
    ]);
    expect(queue.isDone()).toBe(false);

    // Fall duration: max(80, 55 * 1) = 80. Completes at t=800, which is the
    // final step, so onComplete should fire exactly once here.
    queue.tick(800);
    expect(stepCompletes).toEqual([dropStep, clearStep, fallStep]);
    expect(completeCount()).toBe(1);
    expect(queue.isDone()).toBe(true);

    // Further ticks after completion are no-ops.
    queue.tick(900);
    expect(completeCount()).toBe(1);
    expect(stepStarts.length).toBe(3);
  });

  it('fires onComplete exactly once for a single-step queue', () => {
    const fallDisc = makeDisc(2, DiscKind.Numbered);
    const fallStep: FallStep = {
      kind: StepKind.Fall,
      moves: [{ from: { row: 0, col: 0 }, to: { row: 1, col: 0 }, disc: fallDisc }],
    };
    const { queue, completeCount } = makeQueue([fallStep]);

    queue.tick(0);
    expect(queue.isDone()).toBe(false);
    queue.tick(80); // FALL_MS_PER_ROW * 1 = 55, but floored to min 80.
    expect(queue.isDone()).toBe(true);
    expect(completeCount()).toBe(1);

    queue.tick(200);
    expect(completeCount()).toBe(1);
  });

  it('continues active animations from the same visual progress after a time shift', () => {
    const dropStep: DropStep = { kind: StepKind.Drop, disc: makeDisc(3, DiscKind.Numbered), col: 2, toLandRow: 1 };
    const { queue, completeCount } = makeQueue([dropStep]);

    queue.tick(0);
    queue.tick(60);
    expect(queue.getActiveAnimations()[0]!.progress).toBeCloseTo(0.5, 5);

    queue.shiftTime(1_000);
    queue.tick(1_060);

    expect(queue.getActiveAnimations()[0]!.progress).toBeCloseTo(0.5, 5);
    expect(queue.isDone()).toBe(false);
    expect(completeCount()).toBe(0);

    queue.tick(1_120);
    expect(queue.isDone()).toBe(true);
    expect(completeCount()).toBe(1);
  });
});

// ─── Bonus steps ─────────────────────────────────────────────────────────────

describe('AnimationQueue bonus steps', () => {
  it('completes immediately without producing animations', () => {
    const bonusStep: BonusStep = { kind: StepKind.Bonus, bonusKind: 'level', pointsAwarded: 500 };
    const { queue, stepStarts, stepCompletes, completeCount } = makeQueue([bonusStep]);

    queue.tick(0);

    expect(stepStarts).toEqual([{ step: bonusStep, now: 0 }]);
    expect(stepCompletes).toEqual([bonusStep]);
    expect(completeCount()).toBe(1);
    expect(queue.isDone()).toBe(true);
    expect(queue.getActiveAnimations()).toEqual([]);
  });
});

// ─── Fall step with no moves ────────────────────────────────────────────────

describe('AnimationQueue empty Fall step', () => {
  it('auto-advances immediately when there are no moved discs', () => {
    const fallStep: FallStep = { kind: StepKind.Fall, moves: [] };
    const { queue, stepStarts, stepCompletes, completeCount } = makeQueue([fallStep]);

    queue.tick(0);

    // startStep's `if (step.moves.length === 0) { this.advance(now); return; }`
    // fires synchronously inside the same tick call, so start/complete/onComplete
    // all land on this single tick, exactly like a Bonus step.
    expect(stepStarts).toEqual([{ step: fallStep, now: 0 }]);
    expect(stepCompletes).toEqual([fallStep]);
    expect(completeCount()).toBe(1);
    expect(queue.isDone()).toBe(true);
    expect(queue.getActiveAnimations()).toEqual([]);
  });
});

// ─── Push offset ─────────────────────────────────────────────────────────────

describe('pushBoardOffsetY', () => {
  const PUSH_MS = 420;

  beforeEach(() => {
    setGridSize(7, 7);
  });

  function buildPushStep(): PushStep {
    const newRow = Array.from({ length: gridCols() }, (_, i) => makeDisc(i + 1, DiscKind.DoubleCracked));
    return { kind: StepKind.Push, newRow };
  }

  it('is 0 before the push step starts moving', () => {
    const { queue } = makeQueue([buildPushStep()]);
    queue.tick(0);
    expect(pushBoardOffsetY(queue.getActiveAnimations())).toBe(0);
  });

  it('matches the easeOutCubic-interpolated offset mid-flight', () => {
    const { queue } = makeQueue([buildPushStep()]);
    queue.tick(0);
    queue.tick(PUSH_MS / 2);

    const fromY = cellCenterY(gridRows());
    const toY = cellCenterY(gridRows() - 1);
    const expected = (toY - fromY) * easeOutCubic(0.5);

    expect(pushBoardOffsetY(queue.getActiveAnimations())).toBeCloseTo(expected, 5);
    expect(pushBoardOffsetY(queue.getActiveAnimations())).toBeLessThan(0);
  });

  it('returns to 0 once the push step completes', () => {
    const { queue } = makeQueue([buildPushStep()]);
    queue.tick(0);
    queue.tick(PUSH_MS);

    expect(queue.isDone()).toBe(true);
    expect(queue.getActiveAnimations()).toEqual([]);
    expect(pushBoardOffsetY(queue.getActiveAnimations())).toBe(0);
  });

  it('returns 0 for an empty animation list', () => {
    expect(pushBoardOffsetY([])).toBe(0);
  });

  it('returns 0 when no active animation is in the Pushing phase', () => {
    const anims = [fakeAnim(AnimPhase.Dropping), fakeAnim(AnimPhase.Falling), fakeAnim(AnimPhase.Flashing)];
    expect(pushBoardOffsetY(anims)).toBe(0);
  });
});
