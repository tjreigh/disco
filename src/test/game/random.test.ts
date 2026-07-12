import { describe, expect, test } from 'vitest';
import type { RandomSource } from '../../game/random.js';
import { createSeededRandom } from '../../game/random.js';

describe('createSeededRandom', () => {
  test('remains usable anywhere a callable RandomSource is expected', () => {
    const consume = (random: RandomSource): number => random();

    expect(consume(createSeededRandom(42))).toBeTypeOf('number');
  });

  test('restores the exact continuation point', () => {
    const random = createSeededRandom(12345);
    random();
    random();
    const snapshot = random.snapshot();
    const expected = Array.from({ length: 8 }, () => random());

    random.restore(snapshot);

    expect(Array.from({ length: 8 }, () => random())).toEqual(expected);
  });

  test('normalizes seeds and restored states to unsigned 32-bit integers', () => {
    const fromNegativeSeed = createSeededRandom(-1);
    const fromUnsignedSeed = createSeededRandom(0xffff_ffff);
    expect(fromNegativeSeed.snapshot()).toBe(0xffff_ffff);
    expect(fromNegativeSeed()).toBe(fromUnsignedSeed());

    const restored = createSeededRandom(0);
    restored.restore(-1);
    expect(restored.snapshot()).toBe(0xffff_ffff);
    expect(restored()).toBe(createSeededRandom(0xffff_ffff)());
  });
});
