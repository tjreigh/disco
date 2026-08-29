/**
 * Runtime game values for the isolated shared-contract build. The game build
 * keeps a test-enforced copy because neither build may cross the other's root.
 */

export const GAME_OVER_REASONS = ['push-overflow', 'board-full', 'imbalance'] as const;
export type GameOverReason = (typeof GAME_OVER_REASONS)[number];

const GAME_OVER_REASON_SET: ReadonlySet<string> = new Set(GAME_OVER_REASONS);

export function isGameOverReason(value: unknown): value is GameOverReason {
  return typeof value === 'string' && GAME_OVER_REASON_SET.has(value);
}
