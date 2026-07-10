import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AnimationQueue,
  interpolateX,
  interpolateY,
  pushBoardOffsetX,
  pushBoardOffsetY,
  spawnScoreIndicator,
  spawnScorePopups,
  tickScoreIndicators,
  tickScorePopups,
} from '../../ui/rendering/animation-queue.js';
import { AnimPhase } from '../../ui/rendering/animation-types.js';
import type { RichDiscAnimation } from '../../ui/rendering/animation-types.js';
import { cellCenterX, cellCenterY, gridCols, gridRows, setGridSize } from '../../ui/rendering/layout.js';
import { makeDisc } from '../../game/disc.js';
import { DiscKind } from '../../game/model.js';
import type { DropStep, ClearStep, FallStep, PushStep, BonusStep, RevealStep } from '../../game/events.js';
import { StepKind } from '../../game/events.js';

// Mirrors the module's private easeOutCubic so expected mid-flight values are
// derived independently of the helpers under test.
function easeOutCubic(t: number): number {
  return 1 - (1 - t) ** 3;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.stubGlobal('window', { innerWidth: 420, innerHeight: 800 });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function makeQueue(
  steps: Array<DropStep | ClearStep | FallStep | PushStep | BonusStep | RevealStep>,
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
    phase,
    startTime: 0,
    duration: 100,
    fromX: 0,
    toX: 0,
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
    const dropStep: DropStep = {
      kind: StepKind.Drop, disc: makeDisc(3, DiscKind.Numbered),
      entryPos: { row: -1, col: 2 }, landPos: { row: 0, col: 2 },
    };
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

    // Drop duration: max(120, 60 * distance(entryPos, landPos)) = max(120, 60 * 1) = 120.
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
    const dropStep: DropStep = {
      kind: StepKind.Drop, disc: makeDisc(3, DiscKind.Numbered),
      entryPos: { row: -1, col: 2 }, landPos: { row: 1, col: 2 },
    };
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

  it('ignores non-positive or non-finite time shifts', () => {
    const dropStep: DropStep = {
      kind: StepKind.Drop, disc: makeDisc(3, DiscKind.Numbered),
      entryPos: { row: -1, col: 2 }, landPos: { row: 1, col: 2 },
    };
    const { queue } = makeQueue([dropStep]);

    queue.tick(0);
    queue.tick(60);
    const before = queue.getActiveAnimations()[0]!.startTime;

    queue.shiftTime(0);
    queue.shiftTime(-100);
    queue.shiftTime(Number.NaN);
    queue.shiftTime(Number.POSITIVE_INFINITY);

    expect(queue.getActiveAnimations()[0]!.startTime).toBe(before);
    expect(queue.getActiveAnimations()[0]!.progress).toBeCloseTo(0.5, 5);
  });

  it('stores explicit X endpoints for vertical Classic movement', () => {
    const fallDisc = makeDisc(2, DiscKind.Numbered);
    const fallStep: FallStep = {
      kind: StepKind.Fall,
      moves: [{ from: { row: 0, col: 3 }, to: { row: 2, col: 3 }, disc: fallDisc }],
    };
    const { queue } = makeQueue([fallStep]);

    queue.tick(0);

    const anim = queue.getActiveAnimations()[0]!;
    expect(anim.fromX).toBe(cellCenterX(3));
    expect(anim.toX).toBe(cellCenterX(3));
    expect(anim.fromY).toBe(cellCenterY(0));
    expect(anim.toY).toBe(cellCenterY(2));
  });

  // A move with a bent `path` (gravity mode routing around a pile across
  // several settle passes) should animate along that real route, not a
  // straight line from `from` to `to` — see settleContinuous's `path`.
  it('builds waypoints from a bent path and scales duration by the real distance traveled', () => {
    const fallDisc = makeDisc(6, DiscKind.Numbered);
    const fallStep: FallStep = {
      kind: StepKind.Fall,
      moves: [{
        from: { row: 4, col: 2 }, to: { row: 6, col: 4 }, disc: fallDisc,
        path: [{ row: 4, col: 2 }, { row: 5, col: 3 }, { row: 6, col: 4 }],
      }],
    };
    const { queue } = makeQueue([fallStep]);

    queue.tick(0);

    const anim = queue.getActiveAnimations()[0]!;
    expect(anim.waypoints).toEqual([
      { x: cellCenterX(2), y: cellCenterY(4) },
      { x: cellCenterX(3), y: cellCenterY(5) },
      { x: cellCenterX(4), y: cellCenterY(6) },
    ]);
    // Straight-line distance is 2 (chebyshev); the real bent path covers 1 + 1 = 2
    // hops here too, but in general a bent path can be longer than the straight
    // line — duration must be driven by the actual path, not gridDistance(from, to).
    expect(anim.duration).toBe(Math.max(80, 55 * 2));
  });

  it('falls back to a straight two-point path when no `path` is given', () => {
    const fallDisc = makeDisc(2, DiscKind.Numbered);
    const fallStep: FallStep = {
      kind: StepKind.Fall,
      moves: [{ from: { row: 0, col: 1 }, to: { row: 3, col: 1 }, disc: fallDisc }],
    };
    const { queue } = makeQueue([fallStep]);

    queue.tick(0);

    const anim = queue.getActiveAnimations()[0]!;
    expect(anim.waypoints).toBeUndefined();
  });
});

// ─── 2D interpolation ───────────────────────────────────────────────────────

describe('interpolateX', () => {
  it('interpolates between explicit X endpoints', () => {
    const anim = fakeAnim(AnimPhase.Falling);
    anim.fromX = 10;
    anim.toX = 30;
    anim.progress = 0.5;

    expect(interpolateX(anim)).toBeCloseTo(10 + (30 - 10) * easeOutCubic(0.5), 5);
  });

  it('follows a bent waypoint path instead of a straight line when present', () => {
    const anim = fakeAnim(AnimPhase.Falling);
    // A right-angle bend: straight-line X at the midpoint would be 50. The
    // real path instead holds X at 0 for the whole first (vertical) leg,
    // then moves from 0 to 100 along the second (horizontal) leg.
    anim.fromX = 0; anim.toX = 100;
    anim.waypoints = [{ x: 0, y: 0 }, { x: 0, y: 100 }, { x: 100, y: 100 }];
    anim.progress = 0.5;

    // Both legs are 100px, so eased progress t maps to distance t*200 along
    // the path; past the first 100px we're `t*200 - 100` into the second leg.
    const t = easeOutCubic(0.5);
    const expectedX = t * 200 - 100;
    expect(interpolateX(anim)).toBeCloseTo(expectedX, 5);
  });
});

describe('interpolateY', () => {
  it('interpolates between explicit Y endpoints', () => {
    const anim = fakeAnim(AnimPhase.Falling);
    anim.fromY = 100;
    anim.toY = 20;
    anim.progress = 0.25;

    expect(interpolateY(anim)).toBeCloseTo(100 + (20 - 100) * easeOutCubic(0.25), 5);
  });

  it('follows a bent waypoint path instead of a straight line when present', () => {
    const anim = fakeAnim(AnimPhase.Falling);
    anim.fromY = 0; anim.toY = 100;
    anim.waypoints = [{ x: 0, y: 0 }, { x: 0, y: 100 }, { x: 100, y: 100 }];
    anim.progress = 0.5;

    // easeOutCubic(0.5) is already most of the way (~0.875) along the total
    // 200px path, i.e. past the first (vertical) leg entirely — Y has
    // already covered its whole span and stays flat at 100 through the
    // second leg. A straight fromY/toY interpolation would instead show Y
    // still rising toward 100 at this progress.
    expect(interpolateY(anim)).toBeCloseTo(100, 5);
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

// ─── Reveal steps ───────────────────────────────────────────────────────────

describe('AnimationQueue reveal steps', () => {
  it('pulses revealed discs in place', () => {
    const disc = makeDisc(4, DiscKind.Numbered);
    const revealStep: RevealStep = {
      kind: StepKind.Reveal,
      positions: [{ row: 3, col: 5 }],
      discs: [disc],
    };
    const { queue, stepStarts, stepCompletes, completeCount } = makeQueue([revealStep]);

    queue.tick(10);
    expect(stepStarts).toEqual([{ step: revealStep, now: 10 }]);

    const anim = queue.getActiveAnimations()[0]!;
    expect(anim).toMatchObject({
      discId: disc.id,
      disc,
      phase: AnimPhase.Revealing,
      startTime: 10,
      duration: 350,
      fromX: cellCenterX(5),
      toX: cellCenterX(5),
      fromY: cellCenterY(3),
      toY: cellCenterY(3),
      alpha: 1,
    });

    queue.tick(185); // halfway through the 350ms reveal
    expect(queue.getActiveAnimations()[0]!.scale).toBeCloseTo(1.2, 5);
    expect(stepCompletes).toEqual([]);

    queue.tick(360);
    expect(stepCompletes).toEqual([revealStep]);
    expect(completeCount()).toBe(1);
  });

  it('auto-advances immediately when there are no revealed discs', () => {
    const revealStep: RevealStep = { kind: StepKind.Reveal, positions: [], discs: [] };
    const { queue, stepStarts, stepCompletes, completeCount } = makeQueue([revealStep]);

    queue.tick(0);

    expect(stepStarts).toEqual([{ step: revealStep, now: 0 }]);
    expect(stepCompletes).toEqual([revealStep]);
    expect(completeCount()).toBe(1);
    expect(queue.getActiveAnimations()).toEqual([]);
  });
});

// ─── Flashing clear properties ──────────────────────────────────────────────

describe('AnimationQueue clear flash properties', () => {
  it('keeps clear animations opaque during flash, then fades and shrinks them', () => {
    const disc = makeDisc(6, DiscKind.Numbered);
    const clearStep: ClearStep = {
      kind: StepKind.Clear,
      cleared: [{ row: 2, col: 1 }],
      discs: [disc],
      chainLevel: 1,
      pointsAwarded: 24,
    };
    const { queue } = makeQueue([clearStep]);

    queue.tick(0);
    queue.tick(140); // first half of FLASH_MS

    const flashing = queue.getActiveAnimations()[0]!;
    expect(flashing.phase).toBe(AnimPhase.Flashing);
    expect(flashing.alpha).toBe(1);
    expect(flashing.scale).toBeCloseTo(1, 5);

    queue.tick(440); // fade section: progress = 440 / 600, fade t = 0.5

    const fading = queue.getActiveAnimations()[0]!;
    expect(fading.alpha).toBeCloseTo(0.5, 5);
    expect(fading.scale).toBeCloseTo(0.7, 5);
  });
});

describe('AnimationQueue constructed with a genuinely empty steps array', () => {
  // A Gravity-mode tilt commit that moves nothing and clears nothing (e.g.
  // committing on an empty board) produces zero PhysicsSteps — not one empty
  // step, an empty array. isDone() (stepIndex >= steps.length) is already
  // true before the first tick ever runs, which used to mean onComplete
  // never fired and callers relying on it (like the game controller flipping
  // phase back to WaitingForDrop) hung forever.
  it('still fires onComplete exactly once', () => {
    const { queue, stepStarts, stepCompletes, completeCount } = makeQueue([]);

    expect(queue.isDone()).toBe(true); // true even before any tick()

    queue.tick(0);
    expect(completeCount()).toBe(1);
    expect(stepStarts).toEqual([]);
    expect(stepCompletes).toEqual([]);

    queue.tick(100); // further ticks must not double-fire onComplete
    expect(completeCount()).toBe(1);
  });
});

// ─── Push offset ─────────────────────────────────────────────────────────────

describe('pushBoardOffsetY', () => {
  const PUSH_MS = 420;

  beforeEach(() => {
    setGridSize(7, 7);
  });

  function buildPushStep(edge: PushStep['edge'] = 'bottom'): PushStep {
    const count = edge === 'top' || edge === 'bottom' ? gridCols() : gridRows();
    const newDiscs = Array.from({ length: count }, (_, i) => makeDisc(i + 1, DiscKind.DoubleCracked));
    return { kind: StepKind.Push, edge, newDiscs };
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

  // A push now enters from whichever edge gravity currently pulls toward
  // (Classic always 'bottom'; Gravity mode's floor edge changes with the
  // tilt — see computePushStep), not always the bottom.
  it('top edge: slides down from one row above the grid into row 0', () => {
    const { queue } = makeQueue([buildPushStep('top')]);
    queue.tick(0);

    const anim = queue.getActiveAnimations()[0]!;
    expect(anim.fromY).toBe(cellCenterY(-1));
    expect(anim.toY).toBe(cellCenterY(0));
    expect(anim.fromX).toBe(anim.toX); // still a vertical (row) push
  });

  it('does not move Y at all for a left/right (column) push', () => {
    const { queue } = makeQueue([buildPushStep('right')]);
    queue.tick(0);
    queue.tick(PUSH_MS / 2);
    expect(pushBoardOffsetY(queue.getActiveAnimations())).toBe(0);
  });
});

describe('pushBoardOffsetX', () => {
  const PUSH_MS = 420;

  beforeEach(() => {
    setGridSize(7, 7);
  });

  function buildPushStep(edge: PushStep['edge']): PushStep {
    const count = edge === 'top' || edge === 'bottom' ? gridCols() : gridRows();
    const newDiscs = Array.from({ length: count }, (_, i) => makeDisc(i + 1, DiscKind.DoubleCracked));
    return { kind: StepKind.Push, edge, newDiscs };
  }

  it('right edge: slides left from one column beyond the right edge into the rightmost column', () => {
    const { queue } = makeQueue([buildPushStep('right')]);
    queue.tick(0);

    const anim = queue.getActiveAnimations()[0]!;
    expect(anim.fromX).toBe(cellCenterX(gridCols()));
    expect(anim.toX).toBe(cellCenterX(gridCols() - 1));
    expect(anim.fromY).toBe(anim.toY); // still a horizontal (column) push
  });

  it('left edge: slides right from one column beyond the left edge into column 0', () => {
    const { queue } = makeQueue([buildPushStep('left')]);
    queue.tick(0);

    const anim = queue.getActiveAnimations()[0]!;
    expect(anim.fromX).toBe(cellCenterX(-1));
    expect(anim.toX).toBe(cellCenterX(0));
  });

  it('is negative mid-flight for a right-edge push (board visually shifts left)', () => {
    const { queue } = makeQueue([buildPushStep('right')]);
    queue.tick(0);
    queue.tick(PUSH_MS / 2);

    expect(pushBoardOffsetX(queue.getActiveAnimations())).toBeLessThan(0);
  });

  it('does not move X at all for a top/bottom (row) push', () => {
    const { queue } = makeQueue([buildPushStep('bottom')]);
    queue.tick(0);
    queue.tick(PUSH_MS / 2);
    expect(pushBoardOffsetX(queue.getActiveAnimations())).toBe(0);
  });

  it('returns 0 for an empty animation list', () => {
    expect(pushBoardOffsetX([])).toBe(0);
  });
});

// ─── Score popups and indicators ────────────────────────────────────────────

describe('score popups', () => {
  it('spawns one popup per cleared cell and advances/fades them independently', () => {
    const popups = spawnScorePopups([
      { row: 1, col: 2 },
      { row: 4, col: 5 },
    ], 12, 100);

    expect(popups).toEqual([
      { value: 12, col: 2, row: 1, startTime: 100, duration: 800, progress: 0, alpha: 1, yOffset: 0 },
      { value: 12, col: 5, row: 4, startTime: 100, duration: 800, progress: 0, alpha: 1, yOffset: 0 },
    ]);

    const midway = tickScorePopups(popups, 500);
    expect(midway).toHaveLength(2);
    expect(midway[0]!.progress).toBeCloseTo(0.5, 5);
    expect(midway[0]!.alpha).toBeCloseTo(0.5, 5);
    expect(midway[0]!.yOffset).toBeCloseTo(28 * easeOutCubic(0.5), 5);

    expect(tickScorePopups(popups, 900)).toEqual([]);
  });
});

describe('score indicators', () => {
  it('spawns, scales, fades, and prunes score indicators', () => {
    const indicator = spawnScoreIndicator('CHAIN 3', 'x9 +63', 200);

    expect(indicator).toEqual({
      title: 'CHAIN 3',
      detail: 'x9 +63',
      startTime: 200,
      duration: 1_100,
      progress: 0,
      alpha: 1,
      scale: 0.85,
    });

    const early = tickScoreIndicators([indicator], 310);
    expect(early).toHaveLength(1);
    expect(early[0]!.progress).toBeCloseTo(0.1, 5);
    expect(early[0]!.alpha).toBe(1);
    expect(early[0]!.scale).toBeGreaterThan(0.85);

    const fading = tickScoreIndicators([indicator], 1_020);
    expect(fading).toHaveLength(1);
    expect(fading[0]!.progress).toBeCloseTo((1_020 - 200) / 1_100, 5);
    expect(fading[0]!.alpha).toBeLessThan(1);
    expect(fading[0]!.scale).toBeCloseTo(1, 5);

    expect(tickScoreIndicators([indicator], 1_300)).toEqual([]);
  });
});
