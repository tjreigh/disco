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
