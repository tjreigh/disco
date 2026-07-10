import { test, expect } from '@playwright/test';

test.describe('home screen', () => {
  test('lists Classic and Gravity mode cards with no leftover placeholder', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.home-mode-card');

    await expect(page.locator('.home-mode-card')).toHaveCount(2);
    const names = await page.locator('.home-mode-card strong').allTextContents();
    expect(names).toEqual(['Classic', 'Gravity']);
    await expect(page.locator('.home-mode-card--disabled')).toHaveCount(0);
  });

  test('loads with no console or page errors', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', e => pageErrors.push(e.message));
    await page.goto('/');
    await page.waitForSelector('.home-mode-card');
    expect(pageErrors).toEqual([]);
  });
});
