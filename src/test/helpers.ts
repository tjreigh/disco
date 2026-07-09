// Shared helpers for NEW test files. Existing suites intentionally keep their
// own local copies (e.g. engine.test.ts's numberedFactory) — this file is not
// a refactor target, just a place for new tests to avoid re-deriving the same
// small factories.
import { makeDisc } from '../game/disc.js';
import { DiscKind } from '../game/model.js';
import type { Disc } from '../game/model.js';

/** Cycling deterministic DiscFactory, same shape as engine.test.ts's local numberedFactory. */
export function numberedFactory(...values: number[]): () => Disc {
  let index = 0;
  return () => makeDisc(values[index++ % values.length]!, DiscKind.Numbered);
}

/** DoubleCracked discs never clear on their own — useful for filling a board without triggering pushes/clears. */
export function doubleCrackedFactory(value = 7): () => Disc {
  return () => makeDisc(value, DiscKind.DoubleCracked);
}
