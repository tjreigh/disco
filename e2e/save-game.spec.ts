import { test, expect } from '@playwright/test';
import { gotoSeeded, openDebugPanel, playMode, readLiveBoard, readSummary, waitForPhase } from './helpers.js';

test.describe('local save game', () => {
  test('reload exposes and resumes the latest completed turn', async ({ page }) => {
    await gotoSeeded(page);
    await playMode(page, 'Classic');
    await openDebugPanel(page);

    await page.keyboard.press('ArrowDown');
    await waitForPhase(page, 'waiting');
    const before = await readSummary(page);
    const boardBefore = await readLiveBoard(page, 7);
    expect(before.drops).toBe('1');

    await page.reload();

    const resume = page.locator('.home-saved-game-button');
    await expect(resume).toBeVisible();
    await expect(page.locator('.home-saved-game-context')).toContainText('Classic · Score');
    await resume.click();
    await openDebugPanel(page);
    await waitForPhase(page, 'waiting');

    const after = await readSummary(page);
    expect(after.drops).toBe(before.drops);
    expect(after.score).toBe(before.score);
    expect(await readLiveBoard(page, 7)).toEqual(boardBefore);
  });
});
