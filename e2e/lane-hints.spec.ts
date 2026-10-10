import { expect, test } from '@playwright/test';
import { gotoSeeded, playMode } from './helpers.js';

const laneHints = '[data-game-menu-action="lane-hints"]';

test.describe('Ration lane hints', () => {
  test('is not offered outside Ration', async ({ page }) => {
    await gotoSeeded(page);
    await playMode(page, 'Classic');
    await page.locator('.home-back-button').click();
    await expect(page.locator(laneHints)).toBeHidden();
  });

  test('toggling in a Ration run removes the lane hint rows and survives a reload', async ({ page }) => {
    await gotoSeeded(page);
    await playMode(page, 'Ration');
    await expect(page.locator('.game-hud__hint-action[aria-label="#: Lane breaks"]')).toBeVisible();

    await page.locator('.home-back-button').click();
    const button = page.locator(laneHints);
    await expect(button).toBeVisible();
    await expect(button).toHaveText('LANE HINTS ON');
    await button.click();
    await expect(button).toHaveText('LANE HINTS OFF');
    await expect(button).toHaveAttribute('aria-pressed', 'false');
    await page.locator('.game-menu-close').click();
    await expect(page.locator('.game-hud__hint-action[aria-label="X: Purge lane"]')).toBeVisible();
    await expect(page.locator('.game-hud__hint-action[aria-label="#: Lane breaks"]')).toHaveCount(0);

    await gotoSeeded(page);
    await playMode(page, 'Ration');
    await expect(page.locator('.game-hud__hint-action[aria-label="#: Lane breaks"]')).toHaveCount(0);
    await page.locator('.home-back-button').click();
    await expect(page.locator(laneHints)).toHaveText('LANE HINTS OFF');
  });
});
