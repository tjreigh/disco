/**
 * Runtime values used by the multiplayer wire contracts, the wire parser,
 * and the API's shared-board match adapter (via the #multiplayer-contracts
 * package import).
 *
 * This is deliberately NOT imported by src/game: api/tsconfig.contracts.json
 * compiles src/shared in isolation (rootDir "../src/shared") and
 * api/tsconfig.game.json compiles src/game in isolation (rootDir
 * "../src/game") — each build's own tsc invocation rejects a raw relative
 * import that crosses into the other tree, in either direction. The two
 * builds are stitched together only one level up, in api/src, via the
 * #game- and #multiplayer- subpath imports that resolve to each tree's
 * already-compiled dist output.
 *
 * src/game/turn-types.ts's GAME_OVER_REASONS is the game engine's own,
 * intentionally-duplicated copy of this same vocabulary — see its
 * docstring for why a single cross-imported source isn't possible here.
 */

export const GAME_OVER_REASONS = ['push-overflow', 'board-full'] as const;
export type GameOverReason = (typeof GAME_OVER_REASONS)[number];

const GAME_OVER_REASON_SET: ReadonlySet<string> = new Set(GAME_OVER_REASONS);

export function isGameOverReason(value: unknown): value is GameOverReason {
  return typeof value === 'string' && GAME_OVER_REASON_SET.has(value);
}
