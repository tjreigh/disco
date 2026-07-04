import { describe, expect, test } from 'vitest';
import { CLASSIC_MODE, GAME_MODES } from '../../game/modes/index.js';
import { turnsForLevel, unnumberedProbabilityForLevel } from '../../game/modes/mode.js';
import { makeEmptyBoard, placeDisc } from '../../game/board.js';
import { makeDisc } from '../../game/disc.js';
import { DiscKind } from '../../game/model.js';

describe('CLASSIC_MODE', () => {
  test('retains the classic rule configuration', () => {
    expect(CLASSIC_MODE.board).toEqual({ cols: 7, rows: 7 });
    expect(CLASSIC_MODE.pointsPerDisc).toBe(7);
    expect(CLASSIC_MODE.chainExponent).toBe(2.5);
    expect(CLASSIC_MODE.discValueMin).toBe(1);
    expect(CLASSIC_MODE.discValueMax).toBe(7);
    expect(CLASSIC_MODE.initialUnnumberedProbability).toBe(0.30);
    expect(CLASSIC_MODE.unnumberedProbabilityLevelStep).toBe(0.02);
    expect(CLASSIC_MODE.maxUnnumberedProbability).toBe(0.60);
    expect(CLASSIC_MODE.initialTurnsPerLevel).toBe(30);
    expect(CLASSIC_MODE.turnsPerLevelStep).toBe(1);
    expect(CLASSIC_MODE.minTurnsPerLevel).toBe(8);
  });

  test('increases the unnumbered chance by level and caps it at 60%', () => {
    expect(unnumberedProbabilityForLevel(CLASSIC_MODE, 1)).toBeCloseTo(0.30);
    expect(unnumberedProbabilityForLevel(CLASSIC_MODE, 2)).toBeCloseTo(0.32);
    expect(unnumberedProbabilityForLevel(CLASSIC_MODE, 10)).toBeCloseTo(0.48);
    expect(unnumberedProbabilityForLevel(CLASSIC_MODE, 16)).toBeCloseTo(0.60);
    expect(unnumberedProbabilityForLevel(CLASSIC_MODE, 100)).toBeCloseTo(0.60);
  });

  test('is the only entry in GAME_MODES', () => {
    expect(GAME_MODES).toEqual([CLASSIC_MODE]);
  });

  test('isClearable: a numbered disc clears when value equals its run length', () => {
    const board = makeEmptyBoard();
    placeDisc(board, 6, 0, makeDisc(1, DiscKind.Numbered));
    expect(CLASSIC_MODE.isClearable(board, 6, 0, board[6]![0]!)).toBe(true);
  });

  test('isClearable: a cracked disc never clears directly', () => {
    const board = makeEmptyBoard();
    placeDisc(board, 6, 0, makeDisc(1, DiscKind.SingleCracked));
    expect(CLASSIC_MODE.isClearable(board, 6, 0, board[6]![0]!)).toBe(false);
  });

  test('revealAdjacent: degrades an orthogonally adjacent cracked disc by one layer', () => {
    const board = makeEmptyBoard();
    placeDisc(board, 6, 1, makeDisc(5, DiscKind.DoubleCracked));
    const reveal = CLASSIC_MODE.revealAdjacent(board, [{ row: 6, col: 0 }]);
    expect(reveal.positions).toContainEqual({ row: 6, col: 1 });
    expect(board[6]![1]!.kind).toBe(DiscKind.SingleCracked);
  });

  test('isGameOver: true only when row 0 has a disc', () => {
    const empty = makeEmptyBoard();
    expect(CLASSIC_MODE.isGameOver(empty)).toBe(false);

    const full = makeEmptyBoard();
    placeDisc(full, 0, 3, makeDisc(1, DiscKind.Numbered));
    expect(CLASSIC_MODE.isGameOver(full)).toBe(true);
  });
});

describe('turnsForLevel', () => {
  test('shrinks by the configured step down to the configured floor', () => {
    expect(turnsForLevel(CLASSIC_MODE, 1)).toBe(30);
    expect(turnsForLevel(CLASSIC_MODE, 5)).toBe(26);
    expect(turnsForLevel(CLASSIC_MODE, 22)).toBe(9);
    expect(turnsForLevel(CLASSIC_MODE, 23)).toBe(8);
    expect(turnsForLevel(CLASSIC_MODE, 100)).toBe(8);
  });
});
