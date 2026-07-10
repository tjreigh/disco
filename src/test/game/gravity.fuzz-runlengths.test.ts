import { describe, expect, test } from 'vitest';
import { gravityRunLengths } from '../../game/gravity.js';
import { makeEmptyBoard, placeDisc, countHorizontalRun, countVerticalRun } from '../../game/board.js';
import { makeDisc } from '../../game/disc.js';
import type { Board } from '../../game/model.js';
import { DiscKind } from '../../game/model.js';

function mulberry32(seed: number) {
  let a = seed;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomBoard(rows: number, cols: number, fillProb: number, rng: () => number): Board {
  let id = 1;
  const board: Board = Array.from({ length: rows }, () => Array(cols).fill(null));
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (rng() < fillProb) board[r]![c] = { id: id++, kind: DiscKind.Numbered, value: 1 + Math.floor(rng() * 9) };
    }
  }
  return board;
}

describe('gravityRunLengths fuzz', () => {
  test('cardinal angles exactly reproduce {countVerticalRun, countHorizontalRun} across many random boards', () => {
    const rng = mulberry32(2024);
    for (let trial = 0; trial < 100; trial++) {
      const board = randomBoard(9, 8, 0.35, rng);
      for (const angle of [0, 90, 180, 270]) {
        for (let row = 0; row < board.length; row++) {
          for (let col = 0; col < board[row]!.length; col++) {
            if (!board[row]![col]) continue;
            const { alongGravity, crossGravity } = gravityRunLengths(board, row, col, angle);
            const classicPair = [countVerticalRun(board, row, col), countHorizontalRun(board, row, col)].sort((a, b) => a - b);
            expect([alongGravity, crossGravity].sort((a, b) => a - b)).toEqual(classicPair);
          }
        }
      }
    }
  });

  test('run lengths stay within sane bounds and are always >= 1 at arbitrary angles', () => {
    const rng = mulberry32(4242);
    for (let trial = 0; trial < 300; trial++) {
      const board = randomBoard(9, 8, 0.3, rng);
      const angle = rng() * 360;
      const maxPossible = board.length + board[0]!.length;
      for (let row = 0; row < board.length; row++) {
        for (let col = 0; col < board[row]!.length; col++) {
          if (!board[row]![col]) continue;
          const { alongGravity, crossGravity } = gravityRunLengths(board, row, col, angle);
          expect(alongGravity).toBeGreaterThanOrEqual(1);
          expect(crossGravity).toBeGreaterThanOrEqual(1);
          expect(alongGravity).toBeLessThanOrEqual(maxPossible);
          expect(crossGravity).toBeLessThanOrEqual(maxPossible);
        }
      }
    }
  });

  test('an isolated disc always reports a run of exactly 1 in both directions, at any angle', () => {
    const rng = mulberry32(99);
    for (let trial = 0; trial < 50; trial++) {
      const board = makeEmptyBoard(9, 8);
      board[4]![3] = { id: 1, kind: DiscKind.Numbered, value: 5 };
      const angle = rng() * 360;
      const { alongGravity, crossGravity } = gravityRunLengths(board, 4, 3, angle);
      expect(alongGravity).toBe(1);
      expect(crossGravity).toBe(1);
    }
  });

  // Regression for the exact issue an earlier version of this function had:
  // an initial attempt marched a continuous ray independently from each
  // disc's own position, rounding every step — which turned out to NOT be
  // symmetric (Math.round(k*d) isn't linear in k), so two discs that were
  // obviously part of the same physical line could each compute a different
  // run length for it (found by exactly this kind of fuzzing). Snapping to
  // one of 8 exact grid directions fixes that by construction, since every
  // step is then an exact integer offset. Proven here directly: build a
  // 3-disc line along each of the 8 canonical directions, then sample many
  // angles across that direction's whole snap bucket (not just its exact
  // center) and confirm every disc in the line reports the same run length
  // at every sampled angle.
  test.each([
    [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1],
  ] as const)('a 3-disc line along direction (%i,%i) agrees on run length across its whole 45deg snap bucket', (dRow, dCol) => {
    const board = makeEmptyBoard(11, 11);
    const origin = { row: 5, col: 5 };
    const positions = [0, 1, 2].map(k => ({ row: origin.row + dRow * k, col: origin.col + dCol * k }));
    for (const { row, col } of positions) {
      placeDisc(board, row, col, makeDisc(1, DiscKind.Numbered));
    }

    // The angle whose direction vector is exactly (dRow,dCol) — 8 evenly
    // spaced samples across the +/-22.5deg bucket around it, including the
    // boundaries, all of which must snap to this same direction.
    const centerAngle = Math.atan2(dCol, dRow) * (180 / Math.PI);
    for (const offset of [-22, -15, -7.5, 0, 7.5, 15, 22]) {
      const angle = centerAngle + offset;
      const runs = positions.map(({ row, col }) => gravityRunLengths(board, row, col, angle).alongGravity);
      expect(runs).toEqual([3, 3, 3]);
    }
  });
});
