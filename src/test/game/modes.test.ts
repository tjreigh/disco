import { describe, expect, test } from 'vitest';
import { CLASSIC_MODE, GAME_MODES, GRAVITY_MODE, STACK_MODE } from '../../game/modes/index.js';
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
    expect(CLASSIC_MODE.initialUnnumberedProbability).toBe(0.20);
    expect(CLASSIC_MODE.unnumberedProbabilityLevelStep).toBe(0.01);
    expect(CLASSIC_MODE.maxUnnumberedProbability).toBe(0.40);
    expect(CLASSIC_MODE.levelBonus).toBe(7_000);
    expect(CLASSIC_MODE.boardClearBonus).toBe(70_000);
    expect(CLASSIC_MODE.initialTurnsPerLevel).toBe(30);
    expect(CLASSIC_MODE.turnsPerLevelStep).toBe(1);
    expect(CLASSIC_MODE.minTurnsPerLevel).toBe(8);
  });

  test('increases the unnumbered chance by level and caps it at 40%', () => {
    expect(unnumberedProbabilityForLevel(CLASSIC_MODE, 1)).toBeCloseTo(0.20);
    expect(unnumberedProbabilityForLevel(CLASSIC_MODE, 2)).toBeCloseTo(0.21);
    expect(unnumberedProbabilityForLevel(CLASSIC_MODE, 10)).toBeCloseTo(0.29);
    expect(unnumberedProbabilityForLevel(CLASSIC_MODE, 21)).toBeCloseTo(0.40);
    expect(unnumberedProbabilityForLevel(CLASSIC_MODE, 100)).toBeCloseTo(0.40);
  });

  test('has no gravity config', () => {
    expect(CLASSIC_MODE.gravity).toBeUndefined();
  });

  test('GAME_MODES contains Classic, Gravity, and Stack', () => {
    expect(GAME_MODES).toEqual([CLASSIC_MODE, GRAVITY_MODE, STACK_MODE]);
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

describe('STACK_MODE', () => {
  test('keeps Classic rules, removes dropped hazards, and changes scoring to stack awards', () => {
    expect(STACK_MODE.board).toEqual(CLASSIC_MODE.board);
    expect(STACK_MODE.discValueMin).toBe(CLASSIC_MODE.discValueMin);
    expect(STACK_MODE.discValueMax).toBe(CLASSIC_MODE.discValueMax);
    expect(STACK_MODE.discGeneration).toEqual(CLASSIC_MODE.discGeneration);
    expect(STACK_MODE.initialTurnsPerLevel).toBe(CLASSIC_MODE.initialTurnsPerLevel);
    expect(STACK_MODE.turnsPerLevelStep).toBe(CLASSIC_MODE.turnsPerLevelStep);
    expect(STACK_MODE.minTurnsPerLevel).toBe(CLASSIC_MODE.minTurnsPerLevel);
    expect(STACK_MODE.isClearable).toBe(CLASSIC_MODE.isClearable);
    expect(STACK_MODE.revealAdjacent).toBe(CLASSIC_MODE.revealAdjacent);
    expect(STACK_MODE.scoring).toEqual({ kind: 'stack', pointsPerStackUnit: 10 });
    expect(unnumberedProbabilityForLevel(STACK_MODE, 1)).toBe(0);
    expect(unnumberedProbabilityForLevel(STACK_MODE, 100)).toBe(0);
    expect(STACK_MODE.levelBonus).toBe(CLASSIC_MODE.levelBonus);
    expect(STACK_MODE.boardClearBonus).toBe(CLASSIC_MODE.boardClearBonus);
  });
});

describe('GRAVITY_MODE', () => {
  test('has the default gravity config', () => {
    expect(GRAVITY_MODE.gravity).toEqual({ initialAngleDeg: 0, maxTiltDeltaDeg: 45 });
  });

  test('reuses Classic scoring, generation, and board size', () => {
    expect(GRAVITY_MODE.board).toEqual(CLASSIC_MODE.board);
    expect(GRAVITY_MODE.pointsPerDisc).toBe(CLASSIC_MODE.pointsPerDisc);
    expect(GRAVITY_MODE.chainExponent).toBe(CLASSIC_MODE.chainExponent);
    expect(GRAVITY_MODE.discGeneration).toEqual(CLASSIC_MODE.discGeneration);
  });

  test('reuses Classic revealAdjacent', () => {
    expect(GRAVITY_MODE.revealAdjacent).toBe(CLASSIC_MODE.revealAdjacent);
  });

  // isClearable is gravity-specific (checks runs along the current gravity
  // angle, not always grid rows/columns — see gravity.test.ts for the
  // diagonal-angle cases) but at the default angle 0 it's exactly equivalent
  // to Classic's grid-based rule.
  test('isClearable at angle 0 matches Classic\'s grid-based rule', () => {
    const board = makeEmptyBoard();
    placeDisc(board, 6, 0, makeDisc(1, DiscKind.Numbered));
    expect(GRAVITY_MODE.isClearable(board, 6, 0, board[6]![0]!, 0)).toBe(true);
    expect(GRAVITY_MODE.isClearable(board, 6, 0, board[6]![0]!)).toBe(true); // angleDeg defaults to 0
  });

  test('isClearable: a cracked disc never clears directly', () => {
    const board = makeEmptyBoard();
    placeDisc(board, 6, 0, makeDisc(1, DiscKind.SingleCracked));
    expect(GRAVITY_MODE.isClearable(board, 6, 0, board[6]![0]!, 0)).toBe(false);
  });

  test('isGameOver is a genuine full-board scan, not a row-0 shortcut', () => {
    const rowZeroOnly = makeEmptyBoard();
    for (let c = 0; c < 7; c++) placeDisc(rowZeroOnly, 0, c, makeDisc(1, DiscKind.Numbered));
    expect(GRAVITY_MODE.isGameOver(rowZeroOnly)).toBe(false);

    const fullBoard = makeEmptyBoard();
    for (let r = 0; r < 7; r++) for (let c = 0; c < 7; c++) placeDisc(fullBoard, r, c, makeDisc(1, DiscKind.Numbered));
    expect(GRAVITY_MODE.isGameOver(fullBoard)).toBe(true);
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
