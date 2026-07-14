import { test, expect } from '@playwright/test';
import { gotoSeeded } from './helpers.js';

test.describe('Gravity tutorial prompts', () => {
  test('staging swaps to the Aiming prompt and cancel restores the step prompt', async ({ page }) => {
    await gotoSeeded(page);
    await page.locator('.home-mode-card', { hasText: 'Gravity' }).click();
    await page.locator('.home-mode-action', { hasText: 'TUTORIAL' }).click();

    const prompt = page.locator('.tutorial-prompt');
    await expect(prompt).toContainText('Move to the highlighted lane');

    await page.keyboard.press('Enter');
    await expect(prompt).toContainText('Lane staged — nothing drops until you tilt');

    await page.keyboard.press('Escape');
    await expect(prompt).toContainText('Move to the highlighted lane');
  });
});

test.describe('Stack tutorial scoring', () => {
  test('explains the turn total before distinguishing falling from clearing', async ({ page }) => {
    await gotoSeeded(page);
    await page.locator('.home-mode-card', { hasText: 'Stack' }).click();
    await expect(page.locator('.home-mode-tagline')).toContainText('One drop, one cascade');
    await page.locator('.home-mode-action', { hasText: 'TUTORIAL' }).click();

    const title = page.locator('.tutorial-title');
    const prompt = page.locator('.tutorial-prompt');
    await expect(title).toHaveText('Build a turn total');
    await expect(prompt).toContainText('turn total is 3');

    await page.keyboard.press('Enter');
    await expect(title).toHaveText('Square the total', { timeout: 5000 });
    await expect(prompt).toContainText('10 × total²');

    await page.keyboard.press('Enter');
    await expect(title).toHaveText('Falling versus clearing', { timeout: 5000 });
    await expect(prompt).toContainText('Falling scores nothing by itself');
    await expect(prompt).toContainText('joins the same turn total');
  });
});
