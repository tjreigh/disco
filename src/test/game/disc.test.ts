import { afterEach, describe, expect, test, vi } from 'vitest';
import { createDiscFactories, DiscQueue, makeCrackedDisc, makeDisc, makeRandomDisc } from '../../game/disc.js';
import { DiscKind } from '../../game/model.js';
import { CLASSIC_MODE } from '../../game/modes/index.js';

afterEach(() => vi.restoreAllMocks());

describe('makeRandomDisc', () => {
  test('never deals a SingleCracked disc', () => {
    for (let i = 0; i < 500; i++) {
      expect(makeRandomDisc().kind).not.toBe(DiscKind.SingleCracked);
    }
  });

  test('uses the level-specific numbered probability boundary', () => {
    const factory = createDiscFactories(CLASSIC_MODE).discFactory;

    vi.spyOn(Math, 'random')
      .mockReturnValueOnce(0)    // value roll
      .mockReturnValueOnce(0.78) // below level 2's 79% numbered chance
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0.79);

    expect(factory(2).kind).toBe(DiscKind.Numbered);
    expect(factory(2).kind).toBe(DiscKind.DoubleCracked);
  });
});

describe('DiscQueue', () => {
  test('generates only the appended tail with the newly supplied level', () => {
    const generatedAt: number[] = [];
    const queue = new DiscQueue(level => {
      generatedAt.push(level);
      return makeDisc(level, DiscKind.Numbered);
    }, 1);
    const current = queue.peek();
    const next = queue.peekNext();

    queue.advance(2);

    expect(generatedAt).toEqual([1, 1, 1, 2]);
    expect(queue.peek()).toBe(next);
    expect(queue.peekNext()).not.toBe(current);
    expect(queue.peekNext().value).toBe(1);
  });

  test('reset refills the entire queue at level 1', () => {
    const generatedAt: number[] = [];
    const queue = new DiscQueue(level => {
      generatedAt.push(level);
      return makeDisc(level, DiscKind.Numbered);
    }, 3);

    queue.reset(1);

    expect(generatedAt).toEqual([3, 3, 3, 1, 1, 1]);
    expect(queue.peek().value).toBe(1);
    expect(queue.peekNext().value).toBe(1);
  });
});

describe('makeCrackedDisc', () => {
  test('push-row discs always spawn DoubleCracked, never SingleCracked', () => {
    // SingleCracked only ever exists as the result of a DoubleCracked disc
    // degrading once from an adjacent clear — it's never spawned directly.
    for (let i = 0; i < 500; i++) {
      expect(makeCrackedDisc().kind).toBe(DiscKind.DoubleCracked);
    }
  });
});
