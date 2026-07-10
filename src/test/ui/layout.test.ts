// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  canvasLogicalHeight, canvasLogicalWidth, cellSize, gridPadding,
  gridW, setGridSize, updateCellSize,
} from '../../ui/rendering/layout.js';

function setViewport(width: number, height: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
}

describe('responsive stage layout', () => {
  beforeEach(() => setGridSize(7, 7));
  afterEach(() => vi.restoreAllMocks());

  test('iPhone SE stage fits the board and canvas without horizontal overflow', () => {
    updateCellSize({ width: 375, height: 667 });

    expect(cellSize()).toBe(53);
    expect(gridPadding()).toBe(2);
    expect(canvasLogicalWidth()).toBeLessThanOrEqual(375);
    expect(canvasLogicalHeight()).toBeLessThanOrEqual(667);
  });

  test('modern phone stage uses its measured bounds', () => {
    updateCellSize({ width: 393, height: 852 });

    expect(cellSize()).toBe(56);
    expect(canvasLogicalWidth()).toBeLessThanOrEqual(393);
    expect(canvasLogicalHeight()).toBeLessThanOrEqual(852);
  });

  test('desktop stage preserves the wide centered canvas', () => {
    setViewport(1440, 900);
    updateCellSize({ width: 1440, height: 900 });

    expect(cellSize()).toBe(72);
    expect(gridW()).toBe(504);
    expect(gridPadding()).toBe(468);
    expect(canvasLogicalWidth()).toBe(1440);
    expect(canvasLogicalHeight()).toBe(696);
  });
});
