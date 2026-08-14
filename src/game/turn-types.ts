/**
 * Rejected-turn reasons are game-internal presentation values that never
 * cross the network. GravitySystem.stageDrop and GameEngine.stageGravityDrop
 * share this type rather than each declaring their own matching union.
 */
export type RejectedTurnReason =
  | 'game-over'
  | 'wrong-phase'
  | 'invalid-column'
  | 'full-column'
  | 'tilt-required';

/**
 * The game engine's own copy of the game-over-reason vocabulary, kept
 * separate from src/shared/game-values.ts's identical GAME_OVER_REASONS.
 *
 * This can't be a single cross-imported source: api/tsconfig.game.json
 * compiles src/game in isolation with rootDir "../src/game", and
 * api/tsconfig.contracts.json compiles src/shared in isolation with rootDir
 * "../src/shared" — a raw relative import from one tree into the other
 * fails that rootDir containment check in either direction. The two copies
 * are intentional, test-enforced duplication (see
 * src/test/game/modes.test.ts's "game-over reason vocabulary stays in sync
 * between src/game and src/shared" case), not an oversight.
 */
export const GAME_OVER_REASONS = ['push-overflow', 'board-full'] as const;
export type GameOverReason = (typeof GAME_OVER_REASONS)[number];
