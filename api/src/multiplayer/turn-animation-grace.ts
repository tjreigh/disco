import { DROP_MS_PER_ROW, FLASH_MS, CLEAR_MS, FALL_MS_PER_ROW, REVEAL_MS, PUSH_MS, gridDistance } from '#game-animation-timing';
import type { WireStep } from '#multiplayer-contracts';

/**
 * How long the client's AnimationQueue will take to play these steps in
 * sequence, using the same per-step duration formulas (shared via
 * #game-animation-timing so the two can't drift out of sync). The server
 * uses this only to size the bounded fallback for a missing client
 * acknowledgement. Normal activation is driven by post-animation
 * `turn-ready`, so thinking time starts after actual on-screen playback.
 *
 * Wire steps never carry AnimationQueue's optional bent `path` (see
 * WireFallMove), so falls are estimated as straight-line here, matching what
 * the client actually renders over multiplayer.
 */
export function estimateTurnAnimationMs(steps: readonly WireStep[]): number {
  let total = 0;
  for (const step of steps) {
    switch (step.kind) {
      case 'drop':
        total += Math.max(120, DROP_MS_PER_ROW * gridDistance(step.entryPos, step.landPos));
        break;
      case 'clear':
        if (step.cleared.length > 0) total += FLASH_MS + CLEAR_MS;
        break;
      case 'fall': {
        if (step.moves.length === 0) break;
        const longest = Math.max(...step.moves.map(move => gridDistance(move.from, move.to)));
        total += Math.max(80, FALL_MS_PER_ROW * longest);
        break;
      }
      case 'reveal':
        if (step.positions.length > 0) total += REVEAL_MS;
        break;
      case 'push':
        total += PUSH_MS;
        break;
      case 'bonus':
        // Score indicators have their own lifetime and don't hold up board
        // animation playback client-side (see animation-queue.ts) — no grace.
        break;
    }
  }
  return total;
}
