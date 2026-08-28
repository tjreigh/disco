import { test, expect } from '@playwright/test';

// Waits until the service worker controls this page, so an offline reload is
// served from its precache.
async function waitForServiceWorkerControl(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
}

test.describe('PWA', () => {
  test('serves a valid web app manifest linked from the document', async ({ page, request }) => {
    await page.goto('/');

    expect(await page.locator('link[rel="manifest"]').getAttribute('href')).toBe('manifest.webmanifest');
    expect(await page.locator('meta[name="theme-color"]').getAttribute('content')).toBe('#1a1a2e');

    const response = await request.get('/manifest.webmanifest');
    expect(response.ok()).toBeTruthy();
    const manifest = JSON.parse(await response.text());
    expect(manifest.start_url).toBe('/');
    expect(manifest.scope).toBe('/');
    expect(manifest.display).toBe('standalone');
    expect(manifest.theme_color).toBe('#1a1a2e');

    // Every declared icon, and the favicon links, resolve.
    const iconPaths = [
      ...manifest.icons.map((icon: { src: string }) => `/${icon.src}`),
      await page.locator('link[rel="icon"][type="image/svg+xml"]').getAttribute('href'),
      await page.locator('link[rel="apple-touch-icon"]').getAttribute('href'),
    ];
    for (const path of iconPaths) {
      expect((await request.get(path!)).ok(), `${path} should resolve`).toBeTruthy();
    }
  });

  test('registers a service worker that becomes active', async ({ page }) => {
    await page.goto('/');
    const state = await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.ready;
      return registration.active?.state ?? null;
    });
    expect(['activating', 'activated']).toContain(state);
  });

  test('solo play still works after going offline', async ({ page, context }) => {
    await page.goto('/');
    await waitForServiceWorkerControl(page);

    await context.setOffline(true);
    await page.reload();

    // Shell renders from cache.
    await page.waitForSelector('.home-mode-card');
    await expect(page.locator('.home-mode-card')).toHaveCount(4);

    // A solo game boots and takes input offline.
    await page.locator('.home-mode-card', { hasText: 'Classic' }).click();
    await page.locator('.home-mode-action--play').click();
    await expect(page.locator('.home-screen')).not.toHaveClass(/home-screen--open/);

    await page.keyboard.press('Enter');
    await expect(page.locator('.game-hud__score')).toBeVisible();

    await context.setOffline(false);
  });

  test('multiplayer controls are disabled with an explanation when offline', async ({ page, context }) => {
    await page.goto('/');
    await page.waitForSelector('.home-multiplayer__modes');

    await expect(page.locator('.home-multiplayer__offline')).toBeHidden();
    await expect(page.locator('[data-multiplayer-action="create"]')).toBeEnabled();

    await context.setOffline(true);
    await page.waitForFunction(() => navigator.onLine === false);
    // Nudge the event too, so the assertion doesn't hinge on dispatch timing.
    await page.evaluate(() => window.dispatchEvent(new Event('offline')));

    await expect(page.locator('.home-multiplayer__offline')).toBeVisible();
    await expect(page.locator('[data-multiplayer-action="create"]')).toBeDisabled();
    await expect(page.locator('[data-multiplayer-action="join"]')).toBeDisabled();

    await context.setOffline(false);
    await page.waitForFunction(() => navigator.onLine === true);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));

    await expect(page.locator('.home-multiplayer__offline')).toBeHidden();
    await expect(page.locator('[data-multiplayer-action="create"]')).toBeEnabled();
  });
});
