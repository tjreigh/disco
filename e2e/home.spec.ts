import { test, expect } from '@playwright/test';

test.describe('home screen', () => {
  test('lists every playable mode card with no leftover placeholder', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.home-mode-card');

    await expect(page.locator('.home-mode-card')).toHaveCount(4);
    const names = await page.locator('.home-mode-card strong').allTextContents();
    expect(names).toEqual(['Classic', 'Gravity', 'Stack', 'Paradox']);
    await expect(page.locator('.home-mode-card[aria-checked="true"]')).toHaveText(/Classic/);
    await expect(page.locator('.home-mode-record dt')).toHaveText(['HIGH SCORE', 'BEST CHAIN', 'GAMES']);

    await page.locator('.home-mode-card', { hasText: 'Stack' }).click();
    await expect(page.locator('.home-mode-record dt')).toHaveText(['HIGH SCORE', 'BEST TURN', 'GAMES']);
  });

  test('selects a compact mode before launching it from shared actions', async ({ page }) => {
    await page.goto('/');
    await page.locator('.home-mode-card', { hasText: 'Paradox' }).click();

    await expect(page.locator('.home-mode-detail h3')).toHaveText('Paradox');
    await expect(page.locator('.home-mode-action--play')).toHaveText('PLAY');
    await expect(page.locator('.home-mode-card', { hasText: 'Paradox' })).toHaveAttribute('aria-checked', 'true');
  });

  test('uses side-by-side browsing on desktop and a compact grid above details on mobile', async ({ page }) => {
    await page.goto('/');
    const desktopList = await page.locator('.home-mode-list').boundingBox();
    const desktopDetail = await page.locator('.home-mode-detail').boundingBox();
    expect(desktopList).not.toBeNull();
    expect(desktopDetail).not.toBeNull();
    expect(desktopDetail!.x).toBeGreaterThan(desktopList!.x + desktopList!.width);

    await page.setViewportSize({ width: 393, height: 852 });
    const mobileList = await page.locator('.home-mode-list').boundingBox();
    const mobileDetail = await page.locator('.home-mode-detail').boundingBox();
    const cards = await page.locator('.home-mode-card').evaluateAll(elements => elements.map(element => {
      const rect = element.getBoundingClientRect();
      return { x: rect.x, y: rect.y };
    }));

    expect(mobileDetail!.y).toBeGreaterThan(mobileList!.y + mobileList!.height);
    expect(cards[0]!.y).toBe(cards[1]!.y);
    expect(cards[0]!.x).toBeLessThan(cards[1]!.x);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });

  test('loads with no console or page errors', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', e => pageErrors.push(e.message));
    await page.goto('/');
    await page.waitForSelector('.home-mode-card');
    expect(pageErrors).toEqual([]);
  });
});
