import { test, expect } from '@playwright/test';
import { gotoSeeded, openDebugPanel, playMode, readLiveBoard, readSummary, waitForPhase } from './helpers.js';

test.describe('Gravity mode', () => {
  test.beforeEach(async ({ page }) => {
    await gotoSeeded(page);
    await playMode(page, 'Gravity');
    await openDebugPanel(page);
  });

  test('a drop stages first and requires a tilt before it resolves', async ({ page }) => {
    await page.keyboard.press('Enter');
    await waitForPhase(page, 'aiming');
    expect((await readSummary(page)).drops).toBe('0');

    await page.keyboard.press('e');
    await page.keyboard.press('Enter');
    await waitForPhase(page, 'waiting');

    expect((await readSummary(page)).drops).toBe('1');
    const board = await readLiveBoard(page, 7);
    expect(board.some(cell => cell.text !== '·')).toBe(true);
  });

  test('two 45-degree inputs allow a 90-degree tilt in one staged turn', async ({ page }) => {
    await page.keyboard.press('Enter');
    await waitForPhase(page, 'aiming');
    await page.keyboard.press('e');
    await page.keyboard.press('e');
    await page.keyboard.press('Enter');
    await waitForPhase(page, 'waiting');

    expect((await readSummary(page)).drops).toBe('1');
  });

  test('cancelling a staged drop is free', async ({ page }) => {
    await page.keyboard.press('Enter');
    await waitForPhase(page, 'aiming');
    await page.keyboard.press('q');
    await page.keyboard.press('Escape');
    await waitForPhase(page, 'waiting');

    expect((await readSummary(page)).drops).toBe('0');
  });
});
