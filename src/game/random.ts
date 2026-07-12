export type RandomSource = () => number;

/** A callable random source whose exact continuation point can be persisted. */
export interface SnapshotRandomSource extends RandomSource {
  snapshot(): number;
  restore(state: number): void;
}

/** Stable 32-bit PRNG used to make a complete game reproducible from its seed. */
export function createSeededRandom(seed: number): SnapshotRandomSource {
  let state = seed >>> 0;
  const random = () => {
    // mulberry32 algorithm. 0x6d2b79f5 is odd, so adding it repeatedly cycles
    // through all 2^32 values before repeating (unlike e.g. adding 2, which
    // would only hit half of them).
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    // Scrambles the incrementing counter above so consecutive outputs don't
    // look like a straight line - the exact constants aren't important, they
    // just need to mix bits well.
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000; // divide by 2^32 to land in [0, 1)
  };
  random.snapshot = () => state;
  random.restore = (nextState: number) => {
    state = nextState >>> 0;
  };
  return random;
}

/** Produces a fresh unsigned 32-bit seed for a normal game. */
export function createGameSeed(): number {
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    return globalThis.crypto.getRandomValues(new Uint32Array(1))[0]!;
  }
  return Math.floor(Math.random() * 0x1_0000_0000) >>> 0;
}

/** Derives independent streams so one subsystem cannot perturb another. */
export function deriveSeed(seed: number, stream: number): number {
  let value = (seed ^ stream) >>> 0;
  // murmur3-style finalizer (hash-prospector's "lowbias32"): scrambles bits so
  // nearby (seed, stream) pairs produce unrelated-looking seeds. The two hex
  // constants are arbitrary mixing values.
  value = Math.imul(value ^ (value >>> 16), 0x21f0aaad);
  value = Math.imul(value ^ (value >>> 15), 0x735a2d97);
  return (value ^ (value >>> 15)) >>> 0;
}
