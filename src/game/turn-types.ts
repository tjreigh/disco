/** Game-internal rejected-turn reasons; these never cross the network. */
export type RejectedTurnReason =
  | 'game-over'
  | 'wrong-phase'
  | 'invalid-column'
  | 'full-column'
  | 'tilt-required';

/** Intentionally duplicated across the isolated game and shared API builds. */
export const GAME_OVER_REASONS = ['push-overflow', 'board-full'] as const;
export type GameOverReason = (typeof GAME_OVER_REASONS)[number];
