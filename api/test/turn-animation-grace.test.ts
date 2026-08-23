import { describe, expect, test } from 'vitest';
import { estimateTurnAnimationMs } from '../src/multiplayer/turn-animation-grace.js';
import type { WireDisc, WireStep } from '#multiplayer-contracts';

const DROP_MS_PER_ROW = 60;
const FLASH_MS = 280;
const CLEAR_MS = 320;
const FALL_MS_PER_ROW = 55;
const REVEAL_MS = 350;
const PUSH_MS = 420;

const disc = (id: number): WireDisc => ({ id, value: 1, kind: 'numbered' });

describe('estimateTurnAnimationMs', () => {
  test('a plain drop scales with the distance fallen, floored at 120ms', () => {
    const oneRow: WireStep = { kind: 'drop', disc: disc(1), entryPos: { row: -1, col: 0 }, landPos: { row: 0, col: 0 } };
    expect(estimateTurnAnimationMs([oneRow])).toBe(120); // 60*1 = 60, floored to 120

    const sixRows: WireStep = { kind: 'drop', disc: disc(1), entryPos: { row: -1, col: 0 }, landPos: { row: 5, col: 0 } };
    expect(estimateTurnAnimationMs([sixRows])).toBe(DROP_MS_PER_ROW * 6);
  });

  test('a clear step costs the flash+clear duration regardless of how many discs clear', () => {
    const clearOne: WireStep = { kind: 'clear', cleared: [{ row: 0, col: 0 }], discs: [disc(1)], chainLevel: 0, pointsAwarded: 10 };
    const clearThree: WireStep = {
      kind: 'clear',
      cleared: [{ row: 0, col: 0 }, { row: 0, col: 1 }, { row: 0, col: 2 }],
      discs: [disc(1), disc(2), disc(3)],
      chainLevel: 0,
      pointsAwarded: 30,
    };
    expect(estimateTurnAnimationMs([clearOne])).toBe(FLASH_MS + CLEAR_MS);
    expect(estimateTurnAnimationMs([clearThree])).toBe(FLASH_MS + CLEAR_MS);
  });

  test('an empty clear step (should never happen, but matches the client\'s stall-safe handling) costs nothing', () => {
    const empty: WireStep = { kind: 'clear', cleared: [], discs: [], chainLevel: 0, pointsAwarded: 0 };
    expect(estimateTurnAnimationMs([empty])).toBe(0);
  });

  test('a fall step scales with the longest concurrent move, not the sum of all moves', () => {
    const fall: WireStep = {
      kind: 'fall',
      moves: [
        { from: { row: 0, col: 0 }, to: { row: 1, col: 0 }, disc: disc(1) }, // distance 1
        { from: { row: 0, col: 1 }, to: { row: 4, col: 1 }, disc: disc(2) }, // distance 4 — the longest
      ],
    };
    expect(estimateTurnAnimationMs([fall])).toBe(FALL_MS_PER_ROW * 4);
  });

  test('a fall step floors at 80ms and a fall with no moves costs nothing', () => {
    const shortFall: WireStep = { kind: 'fall', moves: [{ from: { row: 0, col: 0 }, to: { row: 1, col: 0 }, disc: disc(1) }] };
    expect(estimateTurnAnimationMs([shortFall])).toBe(80); // 55*1 = 55, floored to 80

    const noFall: WireStep = { kind: 'fall', moves: [] };
    expect(estimateTurnAnimationMs([noFall])).toBe(0);
  });

  test('a reveal step costs a fixed duration only when something is actually revealed', () => {
    const reveal: WireStep = { kind: 'reveal', positions: [{ row: 0, col: 0 }], discs: [disc(1)] };
    expect(estimateTurnAnimationMs([reveal])).toBe(REVEAL_MS);

    const emptyReveal: WireStep = { kind: 'reveal', positions: [], discs: [] };
    expect(estimateTurnAnimationMs([emptyReveal])).toBe(0);
  });

  test('a push step always costs a fixed duration', () => {
    const push: WireStep = { kind: 'push', edge: 'top', newDiscs: [disc(1), disc(2)] };
    expect(estimateTurnAnimationMs([push])).toBe(PUSH_MS);
  });

  test('a bonus step costs nothing — it never holds up board animation playback', () => {
    const bonus: WireStep = { kind: 'bonus', bonusKind: 'level', pointsAwarded: 50 };
    expect(estimateTurnAnimationMs([bonus])).toBe(0);
  });

  test('a chain of steps sums sequentially, mirroring AnimationQueue playing them one at a time', () => {
    const steps: WireStep[] = [
      { kind: 'drop', disc: disc(1), entryPos: { row: -1, col: 0 }, landPos: { row: 6, col: 0 } }, // 60*7=420
      { kind: 'clear', cleared: [{ row: 6, col: 0 }], discs: [disc(1)], chainLevel: 0, pointsAwarded: 10 }, // 600
      { kind: 'fall', moves: [{ from: { row: 5, col: 0 }, to: { row: 6, col: 0 }, disc: disc(2) }] }, // 80
    ];
    expect(estimateTurnAnimationMs(steps)).toBe(420 + (FLASH_MS + CLEAR_MS) + 80);
  });

  test('no steps at all costs nothing', () => {
    expect(estimateTurnAnimationMs([])).toBe(0);
  });
});
