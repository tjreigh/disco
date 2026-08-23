/**
 * Per-step animation durations shared between the client's AnimationQueue
 * (src/ui/rendering/animation-queue.ts, which times the actual on-screen
 * playback) and the multiplayer server (which estimates how long that
 * playback will take, to withhold the next turn's deadline until it's done).
 * Single-sourced here so the two can never drift out of sync.
 */
export const DROP_MS_PER_ROW = 60;
export const FLASH_MS = 280;
export const CLEAR_MS = 320;
export const FALL_MS_PER_ROW = 55;
export const REVEAL_MS = 350;
export const PUSH_MS = 420;

export interface GridPosLike {
  readonly row: number;
  readonly col: number;
}

export function gridDistance(from: GridPosLike, to: GridPosLike): number {
  return Math.max(Math.abs(to.row - from.row), Math.abs(to.col - from.col));
}
