import type { PhysicsStep } from '../events.js';
import { StepKind } from '../events.js';

export interface OwnerScoreDelta {
  /** Points awarded to the player who triggered the cascade (played the disc). */
  readonly triggerDelta: number;
  /** Points awarded to the other player. */
  readonly opponentDelta: number;
}

export interface OwnerAttributionOpts {
  /** The player ID that triggered the cascade (played the disc). */
  readonly triggerPlayerId: string;
  /** The opponent's player ID. */
  readonly opponentPlayerId: string;
  /** Number of opponent-owned discs in a single chain level that triggers a steal. */
  readonly disruptionThreshold: number;
}

/**
 * Computes per-player score deltas from a sequence of physics steps produced by
 * one drop. Each ClearStep already carries pointsAwarded (the total owner award
 * for that chain level). The trigger bonus is an additional equal-magnitude
 * award for the player who triggered the cascade.
 *
 * Disruption mechanic: if ≥threshold opponent-owned discs clear in a single
 * chain level, those discs' owner points are stolen by the trigger player.
 *
 * Neutral discs (ownerId === undefined) award points to no one.
 */
export function computeOwnerScoreDelta(
  steps: readonly PhysicsStep[],
  opts: OwnerAttributionOpts,
): OwnerScoreDelta {
  let triggerDelta = 0;
  let opponentDelta = 0;

  for (const step of steps) {
    if (step.kind !== StepKind.Clear) continue;

    const { discs, pointsAwarded } = step;
    if (discs.length === 0 || pointsAwarded === 0) continue;

    const triggerDiscs = discs.filter(d => d.ownerId === opts.triggerPlayerId).length;
    const opponentDiscs = discs.filter(d => d.ownerId === opts.opponentPlayerId).length;
    const pointsPerDisc = pointsAwarded / discs.length;

    if (opponentDiscs >= opts.disruptionThreshold) {
      // Steal: the trigger claims their own discs' award plus the opponent's
      // stolen award. Neutral discs in the same chain still go to no one.
      triggerDelta += Math.floor(pointsPerDisc * (triggerDiscs + opponentDiscs));
    } else {
      triggerDelta += Math.floor(pointsPerDisc * triggerDiscs);
      opponentDelta += Math.floor(pointsPerDisc * opponentDiscs);
    }

    triggerDelta += pointsAwarded;
  }

  return { triggerDelta, opponentDelta };
}
