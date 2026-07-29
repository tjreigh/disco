import { test, expect } from '@playwright/test';
import { gotoSeeded, openDebugPanel, playMode, readLiveBoard, readSummary, waitForPhase } from './helpers.js';

test.describe('Paradox mode', () => {
  test.beforeEach(async ({ page }) => {
    await gotoSeeded(page);
    await playMode(page, 'Paradox');
  });

  test('previews the cost, rewinds one turn, fractures the restored board, and consumes history', async ({ page }) => {
    await openDebugPanel(page);
    await expect(page.locator('.game-hud__instability-value')).toHaveText('INSTABILITY 0');

    await page.keyboard.press('Enter');
    await waitForPhase(page, 'waiting');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter');
    await waitForPhase(page, 'waiting');
    expect((await readSummary(page)).drops).toBe('2');

    await page.keyboard.press('z');
    const dialog = page.locator('.rewind-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Instability 0 → 1');
    await expect(dialog).toContainText(/Highlighted disc: \d → one layer of temporal damage/);
    // Preview is non-destructive until the player explicitly confirms.
    expect((await readSummary(page)).drops).toBe('2');

    await dialog.locator('.rewind-panel__button--primary').click();
    await waitForPhase(page, 'waiting');
    expect((await readSummary(page)).drops).toBe('1');
    await expect(page.locator('.game-hud__instability-value')).toHaveText('INSTABILITY 1');
    await expect(page.locator('[data-control="rewind"]')).toBeDisabled();

    const board = await readLiveBoard(page, 7);
    expect(board.filter(cell => cell.kind === 'single-cracked')).toHaveLength(1);
  });

  test('Keep Turn cancels without changing progress or instability', async ({ page }) => {
    await openDebugPanel(page);
    await page.keyboard.press('Enter');
    await waitForPhase(page, 'waiting');
    await page.keyboard.press('z');
    await page.locator('.rewind-panel__button', { hasText: 'KEEP TURN' }).click();

    await expect(page.locator('.rewind-dialog')).toBeHidden();
    expect((await readSummary(page)).drops).toBe('1');
    await expect(page.locator('.game-hud__instability-value')).toHaveText('INSTABILITY 0');
  });

  test('reload preserves the rewind checkpoint and its cost', async ({ page }) => {
    await openDebugPanel(page);
    await page.keyboard.press('Enter');
    await waitForPhase(page, 'waiting');
    await page.reload();
    await playMode(page, 'Paradox');
    const savedDialog = page.locator('.saved-game-dialog');
    await expect(savedDialog).toBeVisible();
    await savedDialog.getByRole('button', { name: /resume/i }).click();
    await openDebugPanel(page);
    expect((await readSummary(page)).drops).toBe('1');

    await page.keyboard.press('z');
    await expect(page.locator('.rewind-dialog')).toBeVisible();
    await expect(page.locator('.rewind-dialog')).toContainText('Instability 0 → 1');
  });

  test('physical Z works without debugger focus and may be pressed during the animation', async ({ page }) => {
    const rewindButton = page.locator('[data-control="rewind"]');
    await expect(rewindButton).toBeVisible();
    await expect(rewindButton).toBeDisabled();

    await page.keyboard.press('Enter');
    await page.keyboard.press('z');
    await expect(page.locator('.rewind-dialog')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('.rewind-dialog')).toContainText('Instability 0 → 1');

    await page.locator('.rewind-panel__button', { hasText: 'KEEP TURN' }).click();
    await expect(rewindButton).toBeEnabled();
    await rewindButton.focus();
    await rewindButton.evaluate(button => {
      button.addEventListener('keydown', event => event.stopPropagation());
    });
    await page.keyboard.press('z');
    await expect(page.locator('.rewind-dialog')).toBeVisible();

    await page.locator('.rewind-panel__button', { hasText: 'KEEP TURN' }).click();
    await rewindButton.click();
    await expect(page.locator('.rewind-dialog')).toBeVisible();
  });
});
