import { test, expect } from '@playwright/test';
import { gotoSeeded, readSummary, waitForPhase } from './helpers.js';

// Regression tests for audit-2 finding #2: a real mouse click on any overlay
// button must hand focus back so document-level game keys keep working, and
// closed overlays must not remain focusable/Tab-reachable.
test.describe('overlay buttons do not steal keyboard input', () => {
  test('plain click on PLAY, then keyboard play works immediately', async ({ page }) => {
    await gotoSeeded(page);
    await page.locator('.home-mode-card', { hasText: 'Classic' })
      .locator('.home-mode-action--play').click();

    const focusedClass = await page.evaluate(() => document.activeElement?.className ?? '');
    expect(focusedClass).not.toContain('home-mode-action');

    await page.keyboard.press('ArrowDown'); // drop key
    await waitForPhase(page, 'waiting');
    expect((await readSummary(page)).drops).toBe('1');

    // Enter must drop again — not re-activate the hidden PLAY button,
    // which would restart the game and reset drops to 0.
    await page.keyboard.press('Enter');
    await waitForPhase(page, 'waiting');
    expect((await readSummary(page)).drops).toBe('2');
  });

  test('hidden home-screen buttons are unfocusable mid-game', async ({ page }) => {
    await gotoSeeded(page);
    await page.locator('.home-mode-card', { hasText: 'Classic' })
      .locator('.home-mode-action--play').click();
    await page.waitForTimeout(400); // let the close fade finish so visibility:hidden applies

    const tookFocus = await page.evaluate(() => {
      const el = document.querySelector<HTMLElement>('.home-mode-action--play')!;
      el.focus();
      return document.activeElement === el;
    });
    expect(tookFocus).toBe(false);
  });

  test('MENU round-trip leaves keyboard alive and Space does not reopen the menu', async ({ page }) => {
    await gotoSeeded(page);
    await page.locator('.home-mode-card', { hasText: 'Classic' })
      .locator('.home-mode-action--play').click();

    await page.locator('.home-back-button').click(); // open in-game menu
    await page.locator('.game-menu-button', { hasText: 'RESUME' }).click();
    await page.waitForTimeout(400);

    await page.keyboard.press('ArrowDown');
    await waitForPhase(page, 'waiting');
    expect((await readSummary(page)).drops).toBe('1');

    await page.keyboard.press('Space'); // drop key; must not re-activate MENU/RESUME
    await waitForPhase(page, 'waiting');
    expect((await readSummary(page)).drops).toBe('2');
    const menuOpen = await page.locator('.game-menu')
      .evaluate(el => el.classList.contains('game-menu--open'));
    expect(menuOpen).toBe(false);
  });

  test('tutorial RETRY click does not capture Enter', async ({ page }) => {
    await gotoSeeded(page);
    await page.locator('.home-mode-card', { hasText: 'Classic' })
      .locator('.home-mode-action', { hasText: 'TUTORIAL' }).click();
    await page.locator('.tutorial-button', { hasText: 'RETRY' }).click();

    const focusedClass = await page.evaluate(() => document.activeElement?.className ?? '');
    expect(focusedClass).not.toContain('tutorial-button');
  });
});
