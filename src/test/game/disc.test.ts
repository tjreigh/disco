import { afterEach, describe, expect, test, vi } from 'vitest';
import { createDiscFactories, DiscQueue, makeCrackedDisc, makeDisc, makeRandomDisc, PlayableDiscGenerator } from '../../game/disc.js';
import type { Board } from '../../game/model.js';
import { DiscKind } from '../../game/model.js';
import { CLASSIC_MODE, STACK_MODE } from '../../game/modes/index.js';
import { createGameSeed, createSeededRandom } from '../../game/random.js';
import { makeEmptyBoard } from '../../game/board.js';

afterEach(() => vi.restoreAllMocks());

describe('makeRandomDisc', () => {
  test('never deals a SingleCracked disc', () => {
    for (let i = 0; i < 500; i++) {
      expect(makeRandomDisc().kind).not.toBe(DiscKind.SingleCracked);
    }
  });

  test('uses the level-specific numbered probability boundary', () => {
    const factory = createDiscFactories(CLASSIC_MODE).discFactory;
    const board = makeEmptyBoard();

    vi.spyOn(Math, 'random')
      .mockReturnValueOnce(0.2)  // value roll
      .mockReturnValueOnce(0.78) // below level 2's 79% numbered chance
      .mockReturnValueOnce(0.2)
      .mockReturnValueOnce(0.79);

    expect(factory(2, board).kind).toBe(DiscKind.Numbered);
    expect(factory(2, board).kind).toBe(DiscKind.DoubleCracked);
  });

  // #12: makeRandomDisc used to roll Math.random() directly, bypassing any
  // injected RandomSource — a seeding trap for anything trying to reproduce a
  // sequence involving it.
  describe('with an explicit RandomSource', () => {
    test('the same seed produces identical discs across independent calls', () => {
      const first = makeRandomDisc(undefined, createSeededRandom(42));
      const second = makeRandomDisc(undefined, createSeededRandom(42));
      expect(first.value).toBe(second.value);
      expect(first.kind).toBe(second.kind);
    });

    test('both the value and kind rolls consume the seeded source, not Math.random', () => {
      const randomSpy = vi.spyOn(Math, 'random');
      makeRandomDisc(undefined, createSeededRandom(1));
      expect(randomSpy).not.toHaveBeenCalled();
    });

    test('default argument still falls back to Math.random', () => {
      vi.spyOn(Math, 'random').mockReturnValue(0);
      const disc = makeRandomDisc();
      expect(disc.value).toBe(1); // valueMin(1) + floor(0 * 7)
      expect(disc.kind).toBe(DiscKind.Numbered); // 0 < probNumbered(0.70)
    });
  });
});

describe('PlayableDiscGenerator', () => {
  test('restores history for an identical continuation and snapshots defensively', () => {
    const first = new PlayableDiscGenerator(CLASSIC_MODE, createSeededRandom(111));
    const secondRandom = createSeededRandom(111);
    const second = new PlayableDiscGenerator(CLASSIC_MODE, secondRandom);
    const board = makeEmptyBoard();

    Array.from({ length: 12 }, () => first.generate(2, board));
    Array.from({ length: 12 }, () => second.generate(2, board));
    const history = first.snapshot();
    const randomState = secondRandom.snapshot();

    Array.from({ length: 5 }, () => second.generate(2, board));

    second.restore(history);
    secondRandom.restore(randomState);
    history.recentValues.fill(99);
    history.recentKinds.fill(DiscKind.SingleCracked);

    const signature = (disc: ReturnType<typeof makeDisc>) => [disc.value, disc.kind];
    expect(Array.from({ length: 20 }, () => signature(second.generate(2, board))))
      .toEqual(Array.from({ length: 20 }, () => signature(first.generate(2, board))));
  });

  test('returns snapshot arrays that cannot mutate generator history', () => {
    const random = createSeededRandom(222);
    const generator = new PlayableDiscGenerator(CLASSIC_MODE, random);
    Array.from({ length: 10 }, () => generator.generate(2));
    const before = generator.snapshot();
    const exposed = generator.snapshot();

    exposed.recentValues.fill(99);
    exposed.recentKinds.fill(DiscKind.SingleCracked);

    expect(generator.snapshot()).toEqual(before);
  });

  test('enforces value and kind streak limits', () => {
    const generator = new PlayableDiscGenerator(CLASSIC_MODE, createSeededRandom(12345));
    const discs = Array.from({ length: 10_000 }, () => generator.generate(1));
    let valueRun = 0;
    let numberedRun = 0;
    let crackedRun = 0;

    for (let index = 0; index < discs.length; index++) {
      const disc = discs[index]!;
      valueRun = index > 0 && discs[index - 1]!.value === disc.value ? valueRun + 1 : 1;
      numberedRun = disc.kind === DiscKind.Numbered ? numberedRun + 1 : 0;
      crackedRun = disc.kind === DiscKind.DoubleCracked ? crackedRun + 1 : 0;
      expect(valueRun).toBeLessThanOrEqual(3);
      expect(numberedRun).toBeLessThanOrEqual(6);
      expect(crackedRun).toBeLessThanOrEqual(2);
    }
  });

  test('keeps long-run kind frequency near the level target', () => {
    const generator = new PlayableDiscGenerator(CLASSIC_MODE, createSeededRandom(54321));
    // Level 2 (past minLevelForBoardClearBonus): generate(level) with no board
    // defaults to a fresh empty board on every single call, which at level 1
    // would keep the empty-board value guard permanently active and distort
    // this steady-state distribution check — an artificial worst case, not
    // how real play (a board that actually fills up) exercises the guard.
    const discs = Array.from({ length: 20_000 }, () => generator.generate(2));
    const numberedRate = discs.filter(disc => disc.kind === DiscKind.Numbered).length / discs.length;
    expect(numberedRate).toBeGreaterThan(0.76);
    expect(numberedRate).toBeLessThan(0.83);
    for (let value = 1; value <= 7; value++) {
      const valueRate = discs.filter(disc => disc.value === value).length / discs.length;
      expect(valueRate).toBeGreaterThan(0.12);
      expect(valueRate).toBeLessThan(0.16);
    }
  });

  test('Stack mode never deals a DoubleCracked player disc, including past the normal numbered streak cap', () => {
    const generator = new PlayableDiscGenerator(STACK_MODE, createSeededRandom(24680));
    const discs = Array.from({ length: 20 }, () => generator.generate(10));

    expect(discs.every(disc => disc.kind === DiscKind.Numbered)).toBe(true);
  });

  test('re-rolls a value that would immediately clear an empty board, without touching kind', () => {
    const generator = new PlayableDiscGenerator(CLASSIC_MODE, () => 0);
    const disc = generator.generate(1, makeEmptyBoard());

    // On a genuinely empty board only value 1 could chain-clear it straight
    // back to empty, so it's excluded from the candidate pool entirely — the
    // roll lands on a different, still-uniformly-weighted value instead of
    // surviving and then having its kind forced down to DoubleCracked.
    expect(disc.value).not.toBe(1);
    expect(disc.kind).toBe(DiscKind.Numbered); // kind still follows the mode's normal probability
  });

  // The guard is gated by `level < mode.minLevelForBoardClearBonus`
  // (minLevelForBoardClearBonus is 2 for Classic), so it's active only at
  // level 1 and lifts from level 2 onward. Both tests below drive real
  // production seeds (createGameSeed, the same crypto-backed 32-bit source
  // GameEngine uses to start a real game) through createSeededRandom, rather
  // than small hand-picked literals — a handful of low integers like 1, 2,
  // 42 sample only a negligible sliver of the ~4.29 billion-value seed space
  // production actually draws from.
  test('level 1: never deals a value-1 Numbered disc that would empty the board, across many real production seeds', () => {
    // Mirrors DiscQueue's real prefill: several discs generated back-to-back
    // against the same still-empty board before any drop happens. This is
    // exactly the shape of the reported bug (a lone 2 next to a lone 1, both
    // dealt onto an empty board, chain-clearing on contact) — the guard has
    // to hold for every disc dealt while level 1's board stays empty, not
    // just the very first one.
    const seeds = Array.from({ length: 500 }, () => createGameSeed());

    for (const seed of seeds) {
      const generator = new PlayableDiscGenerator(CLASSIC_MODE, createSeededRandom(seed));
      const board = makeEmptyBoard();
      for (let i = 0; i < 5; i++) {
        const disc = generator.generate(1, board);
        if (disc.kind === DiscKind.Numbered) expect(disc.value).not.toBe(1);
      }
    }
  });

  test('above minLevelForBoardClearBonus: a value-1 Numbered disc can be dealt onto a still-empty board again, across many real production seeds', () => {
    // Proves the guard is genuinely level-scoped rather than a de facto
    // permanent exclusion of value 1 on an empty board: once level reaches
    // the mode's threshold, the same still-empty-board setup that's exercised
    // above must be able to produce a value-1 Numbered disc again.
    const seeds = Array.from({ length: 500 }, () => createGameSeed());
    let sawNumberedOne = false;

    for (const seed of seeds) {
      const generator = new PlayableDiscGenerator(CLASSIC_MODE, createSeededRandom(seed));
      const board = makeEmptyBoard();
      for (let i = 0; i < 5; i++) {
        const disc = generator.generate(CLASSIC_MODE.minLevelForBoardClearBonus, board);
        if (disc.kind === DiscKind.Numbered && disc.value === 1) sawNumberedOne = true;
      }
    }

    expect(sawNumberedOne).toBe(true);
  });

  test('can still deal numbered 1 once the board is not empty', () => {
    const board = makeEmptyBoard();
    board[6]![0] = makeDisc(7, DiscKind.DoubleCracked);
    const generator = new PlayableDiscGenerator(CLASSIC_MODE, () => 0);
    const disc = generator.generate(1, board);

    expect(disc.value).toBe(1);
    expect(disc.kind).toBe(DiscKind.Numbered);
  });

  test('the empty-board value guard only applies below minLevelForBoardClearBonus', () => {
    const generator = new PlayableDiscGenerator(CLASSIC_MODE, () => 0);
    const disc = generator.generate(CLASSIC_MODE.minLevelForBoardClearBonus, makeEmptyBoard());

    expect(disc.value).toBe(1); // guard is off at/after this level, so the raw uniform roll can land on 1 again
  });

  test('falls back to the unfiltered candidate pool if every remaining value would be unsafe', () => {
    const singleValueMode = { ...CLASSIC_MODE, discValueMin: 1, discValueMax: 1 };
    const generator = new PlayableDiscGenerator(singleValueMode, () => 0);

    const disc = generator.generate(1, makeEmptyBoard());

    expect(disc.value).toBe(1); // the only value in range — generation must not throw or stall
  });

  test('is deterministic for a seed and keeps push rolls out of playable history', () => {
    const makeFactories = () => createDiscFactories(
      CLASSIC_MODE,
      createSeededRandom(111),
      createSeededRandom(222),
    );
    const uninterrupted = makeFactories();
    const withPushes = makeFactories();
    const signature = (disc: ReturnType<typeof makeDisc>) => `${disc.value}:${disc.kind}`;
    const board = makeEmptyBoard();

    const expected = Array.from({ length: 20 }, (_, index) => signature(uninterrupted.discFactory(index < 10 ? 1 : 5, board)));
    const actual = Array.from({ length: 20 }, (_, index) => {
      if (index === 10) Array.from({ length: 21 }, () => withPushes.crackedDiscFactory());
      return signature(withPushes.discFactory(index < 10 ? 1 : 5, board));
    });

    expect(actual).toEqual(expected);
  });

  test('favors smaller values as the highest stack rises without excluding any value', () => {
    const lowBoard = makeEmptyBoard();
    const highBoard = makeEmptyBoard();
    for (let row = 0; row < 7; row++) highBoard[row]![6] = makeDisc(7, DiscKind.DoubleCracked);
    const lowGenerator = new PlayableDiscGenerator(CLASSIC_MODE, createSeededRandom(9876));
    const highGenerator = new PlayableDiscGenerator(CLASSIC_MODE, createSeededRandom(9876));

    // Level 2 (past minLevelForBoardClearBonus): lowBoard is reused untouched
    // across every call, so at level 1 the empty-board value guard would fire
    // on every single draw and permanently exclude value 1 — an artificial
    // worst case unrelated to what this test is checking (board pressure).
    const lowValues = Array.from({ length: 20_000 }, () => lowGenerator.generate(2, lowBoard).value);
    const highValues = Array.from({ length: 20_000 }, () => highGenerator.generate(2, highBoard).value);
    const mean = (values: readonly number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;

    expect(mean(lowValues)).toBeGreaterThan(3.9);
    expect(mean(lowValues)).toBeLessThan(4.1);
    expect(mean(highValues)).toBeLessThan(mean(lowValues) - 0.25);
    for (let value = 1; value <= 7; value++) {
      expect(highValues.filter(item => item === value).length / highValues.length).toBeGreaterThan(0.02);
    }
  });

  test('boosts values that can clear in more legal drop columns', () => {
    const relevanceOnlyMode = {
      ...CLASSIC_MODE,
      discGeneration: {
        ...CLASSIC_MODE.discGeneration,
        valueBalanceStrength: 0,
        boardPressureStrength: 0,
      },
    };
    const relevantBoard = makeEmptyBoard();
    const irrelevantBoard = makeEmptyBoard();
    for (let row = 1; row < 7; row++) {
      relevantBoard[row]![6] = makeDisc(7, DiscKind.DoubleCracked);
      irrelevantBoard[row]![6] = makeDisc(7, DiscKind.DoubleCracked);
    }
    relevantBoard[6]![0] = makeDisc(1, DiscKind.Numbered);
    relevantBoard[6]![1] = makeDisc(2, DiscKind.Numbered);
    irrelevantBoard[6]![0] = makeDisc(1, DiscKind.Numbered);
    irrelevantBoard[6]![3] = makeDisc(2, DiscKind.Numbered);
    const relevantGenerator = new PlayableDiscGenerator(relevanceOnlyMode, createSeededRandom(4567));
    const irrelevantGenerator = new PlayableDiscGenerator(relevanceOnlyMode, createSeededRandom(4567));

    // The source is seeded, so this comparison is deterministic rather than a
    // probabilistic confidence test. 5,000 draws keeps the observed advantage
    // comfortably above the 5% assertion while avoiding a multi-second test
    // that can exceed Vitest's timeout when suites run concurrently.
    const sampleSize = 5_000;
    const relevantThrees = Array.from(
      { length: sampleSize },
      () => relevantGenerator.generate(1, relevantBoard).value,
    ).filter(value => value === 3).length;
    const irrelevantThrees = Array.from(
      { length: sampleSize },
      () => irrelevantGenerator.generate(1, irrelevantBoard).value,
    ).filter(value => value === 3).length;

    expect(relevantThrees).toBeGreaterThan(irrelevantThrees * 1.05);
  });

  test('does not mutate the board while evaluating projected runs', () => {
    const board = makeEmptyBoard();
    board[6]![0] = makeDisc(2, DiscKind.SingleCracked);
    board[5]![0] = makeDisc(4, DiscKind.Numbered);
    board[6]![1] = makeDisc(3, DiscKind.DoubleCracked);
    const before = board.map(row => row.map(cell => cell == null ? null : { ...cell }));

    new PlayableDiscGenerator(CLASSIC_MODE, createSeededRandom(1)).generate(1, board);

    expect(board).toEqual(before);
  });
});

describe('DiscQueue', () => {
  test('snapshots exactly three queued discs without runtime IDs', () => {
    let value = 0;
    const queue = new DiscQueue(
      () => makeDisc(++value, DiscKind.Numbered),
      1,
      makeEmptyBoard(),
    );

    expect(queue.snapshot()).toEqual([
      { value: 1, kind: DiscKind.Numbered },
      { value: 2, kind: DiscKind.Numbered },
      { value: 3, kind: DiscKind.Numbered },
    ]);
  });

  test('restores defensive queue copies with fresh runtime IDs', () => {
    const queue = new DiscQueue(
      () => makeDisc(7, DiscKind.Numbered),
      1,
      makeEmptyBoard(),
    );
    const snapshot = queue.snapshot();
    const oldIds = [queue.peek().id, queue.peekNext().id];

    queue.restore(snapshot);
    snapshot[0].value = 99;

    expect(queue.peek()).toMatchObject({ value: 7, kind: DiscKind.Numbered });
    expect(queue.peekNext()).toMatchObject({ value: 7, kind: DiscKind.Numbered });
    expect(oldIds).not.toContain(queue.peek().id);
    expect(oldIds).not.toContain(queue.peekNext().id);
  });

  test('rejects snapshots that do not contain exactly three entries', () => {
    const queue = new DiscQueue(
      () => makeDisc(7, DiscKind.Numbered),
      1,
      makeEmptyBoard(),
    );

    expect(() => queue.restore([])).toThrow('exactly three discs');
    expect(() => queue.restore([
      { value: 1, kind: DiscKind.Numbered },
      { value: 2, kind: DiscKind.Numbered },
    ])).toThrow('exactly three discs');
  });

  test('generates only the appended tail with the newly supplied level', () => {
    const generatedAt: number[] = [];
    const board = makeEmptyBoard();
    const queue = new DiscQueue(level => {
      generatedAt.push(level);
      return makeDisc(level, DiscKind.Numbered);
    }, 1, board);
    const current = queue.peek();
    const next = queue.peekNext();

    queue.advance(2, board);

    expect(generatedAt).toEqual([1, 1, 1, 2]);
    expect(queue.peek()).toBe(next);
    expect(queue.peekNext()).not.toBe(current);
    expect(queue.peekNext().value).toBe(1);
  });

  test('reset refills the entire queue at level 1', () => {
    const generatedAt: number[] = [];
    const board = makeEmptyBoard();
    const queue = new DiscQueue(level => {
      generatedAt.push(level);
      return makeDisc(level, DiscKind.Numbered);
    }, 3, board);

    queue.reset(1, board);

    expect(generatedAt).toEqual([3, 3, 3, 1, 1, 1]);
    expect(queue.peek().value).toBe(1);
    expect(queue.peekNext().value).toBe(1);
  });

  test('uses the supplied board for prefill, advance, and reset generation', () => {
    const initialBoard = makeEmptyBoard();
    const settledBoard = makeEmptyBoard();
    settledBoard[6]![0] = makeDisc(7, DiscKind.DoubleCracked);
    const resetBoard = makeEmptyBoard();
    resetBoard[6]![1] = makeDisc(6, DiscKind.DoubleCracked);
    const generatedWith: Board[] = [];
    const queue = new DiscQueue((_level, board) => {
      generatedWith.push(board);
      return makeDisc(7, DiscKind.Numbered);
    }, 1, initialBoard);

    queue.advance(1, settledBoard);
    queue.reset(1, resetBoard);

    expect(generatedWith).toEqual([
      initialBoard, initialBoard, initialBoard,
      settledBoard,
      resetBoard, resetBoard, resetBoard,
    ]);
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
