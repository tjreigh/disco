import { describe, test, expect } from 'vitest';
import { computeOwnerScoreDelta } from '../../game/scoring/owner-attribution.js';
import type { ClearStep, PhysicsStep } from '../../game/events.js';
import { StepKind } from '../../game/events.js';
import { DiscKind } from '../../game/model.js';
import type { Disc } from '../../game/model.js';

const TRIGGER = 'player-a';
const OPPONENT = 'player-b';

let nextDiscId = 0;
function ownedDisc(ownerId: string | undefined): Disc {
  return { id: nextDiscId++, value: 3, kind: DiscKind.Numbered, ...(ownerId !== undefined ? { ownerId } : {}) };
}

function clearStep(discs: Disc[], pointsAwarded: number, chainLevel = 1): ClearStep {
  return {
    kind: StepKind.Clear,
    cleared: discs.map(() => ({ row: 0, col: 0 })),
    discs,
    chainLevel,
    pointsAwarded,
  };
}

const opts = { triggerPlayerId: TRIGGER, opponentPlayerId: OPPONENT, disruptionThreshold: 3 };

// Every clear step contributes two things to triggerDelta: its share of the
// owner award (split per-disc, or stolen wholesale from the opponent's share
// on a disruption), plus a flat trigger bonus equal to the whole step's
// pointsAwarded — awarded to the trigger regardless of who owned what cleared.

describe('computeOwnerScoreDelta', () => {
  test('below threshold: each disc pays its owner, neutral discs pay no one', () => {
    const steps: PhysicsStep[] = [
      clearStep([
        ownedDisc(TRIGGER),
        ownedDisc(OPPONENT),
        ownedDisc(OPPONENT),
        ownedDisc(undefined),
      ], 400),
    ];
    const result = computeOwnerScoreDelta(steps, opts);
    // 400 / 4 discs = 100/disc. Owner award: trigger owns 1 (100), opponent
    // owns 2 (200), 1 neutral disc's 100 is discarded. Trigger bonus: +400.
    expect(result.triggerDelta).toBe(100 + 400);
    expect(result.opponentDelta).toBe(200);
  });

  test('at/above threshold: opponent award is stolen by the trigger', () => {
    const steps: PhysicsStep[] = [
      clearStep([
        ownedDisc(OPPONENT),
        ownedDisc(OPPONENT),
        ownedDisc(OPPONENT),
        ownedDisc(TRIGGER),
      ], 400),
    ];
    const result = computeOwnerScoreDelta(steps, opts);
    // 400 / 4 discs = 100/disc. Steal: trigger claims their own 1 plus the
    // 3 stolen (400). Trigger bonus: +400.
    expect(result.triggerDelta).toBe(400 + 400);
    expect(result.opponentDelta).toBe(0);
  });

  test('a steal never awards a neutral disc\'s owner-award share to the trigger', () => {
    const steps: PhysicsStep[] = [
      clearStep([
        ownedDisc(OPPONENT),
        ownedDisc(OPPONENT),
        ownedDisc(OPPONENT),
        ownedDisc(undefined),
        ownedDisc(undefined),
      ], 500),
    ];
    const result = computeOwnerScoreDelta(steps, opts);
    // 500 / 5 discs = 100/disc. Steal only claims the 3 opponent discs
    // (300), not the 2 neutral discs' 200 share — that stays out of both
    // deltas' owner-award component. (A regression that stole the full
    // pointsAwarded here would total 500 + 500 = 1000, not 800.)
    expect(result.triggerDelta).toBe(300 + 500);
    expect(result.opponentDelta).toBe(0);
  });

  test('an all-neutral chain pays only the trigger bonus, no owner award', () => {
    const steps: PhysicsStep[] = [
      clearStep([ownedDisc(undefined), ownedDisc(undefined), ownedDisc(undefined)], 300),
    ];
    const result = computeOwnerScoreDelta(steps, opts);
    // No owner-award component (nobody owns any of the cleared discs), but
    // the trigger still collects the flat 300 trigger bonus for causing it.
    expect(result.triggerDelta).toBe(300);
    expect(result.opponentDelta).toBe(0);
  });

  test('a chain level with zero points awards nobody even with owned discs', () => {
    const steps: PhysicsStep[] = [
      clearStep([ownedDisc(TRIGGER), ownedDisc(OPPONENT)], 0),
    ];
    const result = computeOwnerScoreDelta(steps, opts);
    expect(result.triggerDelta).toBe(0);
    expect(result.opponentDelta).toBe(0);
  });

  test('multiple chain levels accumulate independently, mixing steal and non-steal', () => {
    const steps: PhysicsStep[] = [
      clearStep([ownedDisc(TRIGGER), ownedDisc(OPPONENT)], 200, 1),
      clearStep([ownedDisc(OPPONENT), ownedDisc(OPPONENT), ownedDisc(OPPONENT)], 300, 2),
    ];
    const result = computeOwnerScoreDelta(steps, opts);
    // Level 1 (no steal, 100/disc): owner award trigger 100 / opponent 100,
    // plus a 200 trigger bonus.
    // Level 2 (steal, 3 opponent discs, 100/disc): all 300 stolen by
    // trigger, plus a 300 trigger bonus.
    expect(result.triggerDelta).toBe((100 + 200) + (300 + 300));
    expect(result.opponentDelta).toBe(100);
  });

  test('non-clear steps are ignored', () => {
    const steps: PhysicsStep[] = [
      { kind: StepKind.Fall, moves: [] },
      clearStep([ownedDisc(TRIGGER)], 100),
    ];
    const result = computeOwnerScoreDelta(steps, opts);
    expect(result.triggerDelta).toBe(100 + 100);
    expect(result.opponentDelta).toBe(0);
  });
});
