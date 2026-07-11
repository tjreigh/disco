import { test, expect } from '@playwright/test';
import { cellAt, DEFAULT_CURSOR_COL, gotoSeeded, openDebugPanel, playMode, readLiveBoard, readSummary, waitForPhase } from './helpers.js';

test.describe('Classic mode', () => {
  test.beforeEach(async ({ page }) => {
    await gotoSeeded(page);
    await playMode(page, 'Classic');
    await openDebugPanel(page);
  });

  test('an instant drop resolves and lands at the bottom of the column', async ({ page }) => {
    await page.keyboard.press('Enter'); // drop into the default column
    await waitForPhase(page, 'waiting'); // wait out the drop animation

    const summary = await readSummary(page);
    expect(summary.drops).toBe('1');

    const board = await readLiveBoard(page, 7);
    expect(cellAt(board, 7, 6, DEFAULT_CURSOR_COL).text).not.toBe('·');
    for (let r = 0; r < 6; r++) expect(cellAt(board, 7, r, DEFAULT_CURSOR_COL).text).toBe('·');
  });

  test('a second drop in the same column stacks on top of the first', async ({ page }) => {
    await page.keyboard.press('Enter');
    await waitForPhase(page, 'waiting');
    await page.keyboard.press('Enter');
    await waitForPhase(page, 'waiting');

    const summary = await readSummary(page);
    expect(summary.drops).toBe('2');

    const board = await readLiveBoard(page, 7);
    expect(cellAt(board, 7, 6, DEFAULT_CURSOR_COL).text).not.toBe('·');
    expect(cellAt(board, 7, 5, DEFAULT_CURSOR_COL).text).not.toBe('·');
    expect(cellAt(board, 7, 4, DEFAULT_CURSOR_COL).text).toBe('·');
  });

  test('has no Aiming phase — turns resolve in one step, not staged', async ({ page }) => {
    // No 'aiming' phase should ever be observable for an instant-turnStyle mode.
    await page.keyboard.press('Enter');
    const summary = await readSummary(page);
    expect(summary.phase).not.toBe('aiming');
  });

  test('desktop keeps touch controls hidden while the DOM HUD remains visible', async ({ page }) => {
    await expect(page.locator('.game-hud')).toBeVisible();
    await expect(page.locator('.game-controls')).toBeHidden();
    await expect(page.locator('.game-hud__score')).toBeVisible();
  });
});
