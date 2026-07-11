import { test, expect } from '@playwright/test';
import { cellAt, gotoSeeded, openDebugPanel, playMode, readLiveBoard, readSummary, waitForPhase } from './helpers.js';

test.use({
  viewport: { width: 393, height: 852 },
  isMobile: true,
  hasTouch: true,
});

test.describe('mobile playability', () => {
  test('Classic exposes the HUD and touch controls, and a tap drops a disc', async ({ page }) => {
    await gotoSeeded(page);
    await playMode(page, 'Classic');

    await expect(page.locator('.game-hud')).toBeVisible();
    await expect(page.locator('.game-controls')).toBeVisible();
    await expect(page.locator('[data-control="drop"]')).toBeVisible();

    await openDebugPanel(page);
    await page.locator('[data-control="drop"]').tap();
    await waitForPhase(page, 'waiting');

    expect((await readSummary(page)).drops).toBe('1');
    const board = await readLiveBoard(page, 7);
    expect(cellAt(board, 7, 6, 3).text).not.toBe('·');
  });

  test('Gravity shows lane controls in waiting, tilt controls in aiming, and can confirm a turn', async ({ page }) => {
    await gotoSeeded(page);
    await playMode(page, 'Gravity');

    await expect(page.locator('.game-controls')).toBeVisible();
    await expect(page.locator('[data-control="previous"]')).toBeVisible();
    await expect(page.locator('[data-control="drop"]')).toBeVisible();

    await page.locator('[data-control="tilt-clockwise"]').tap();
    await openDebugPanel(page);
    await waitForPhase(page, 'aiming');
    await expect(page.locator('[data-control="cancel"]')).toBeVisible();
    await expect(page.locator('[data-control="confirm"]')).toBeVisible();
    await expect(page.locator('[data-control="previous"]')).toBeHidden();

    await page.locator('[aria-label="Close debugger"]').tap();
    await page.locator('[data-control="confirm"]').tap();
    await openDebugPanel(page);
    await waitForPhase(page, 'waiting');
    expect((await readSummary(page)).drops).toBe('1');
  });

  test('resize keeps HUD geometry variables aligned with the canvas and board', async ({ page }) => {
    await gotoSeeded(page);
    await playMode(page, 'Classic');

    const before = await page.locator('.game-stage').evaluate(stage => ({
      canvasWidth: stage.style.getPropertyValue('--game-canvas-width'),
      canvasHeight: stage.style.getPropertyValue('--game-canvas-height'),
      gridWidth: stage.style.getPropertyValue('--game-grid-width'),
    }));
    await page.setViewportSize({ width: 375, height: 667 });
    await page.waitForTimeout(50);
    const after = await page.locator('.game-stage').evaluate(stage => ({
      canvasWidth: stage.style.getPropertyValue('--game-canvas-width'),
      canvasHeight: stage.style.getPropertyValue('--game-canvas-height'),
      gridWidth: stage.style.getPropertyValue('--game-grid-width'),
    }));

    expect(after.canvasWidth).not.toBe(before.canvasWidth);
    expect(after.canvasHeight).not.toBe(before.canvasHeight);
    expect(Number.parseFloat(after.gridWidth)).toBeLessThanOrEqual(Number.parseFloat(after.canvasWidth));
    await expect(page.locator('.game-hud')).toBeVisible();
  });
});
