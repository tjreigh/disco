import { test, expect, type Page, type Route } from '@playwright/test';
import { gotoSeeded, openDebugPanel, playMode, readLiveBoard, readSummary, waitForPhase } from './helpers.js';

interface FakeCloudState {
  slot: {
    modeId: string;
    revision: number;
    runId: string | null;
    save: any;
    updatedAt: string;
  } | null;
  rejectSaveWrites: boolean;
}

const corsHeaders = {
  'access-control-allow-origin': 'http://localhost:3000',
  'access-control-allow-credentials': 'true',
  'access-control-allow-methods': 'GET, POST, PUT, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'content-type': 'application/json',
};

async function json(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, headers: corsHeaders, body: JSON.stringify(body) });
}

async function installFakeAccountApi(page: Page): Promise<FakeCloudState> {
  const state: FakeCloudState = { slot: null, rejectSaveWrites: false };
  await page.route('http://localhost:8787/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: corsHeaders });
    } else if (path === '/me') {
      await json(route, { account: { id: 'e2e-account', displayName: 'Cloud Player' }, identities: [] });
    } else if (path === '/stats' && request.method() === 'GET') {
      await json(route, { stats: [] });
    } else if (path.startsWith('/stats/') && request.method() === 'PUT') {
      const modeId = path.slice('/stats/'.length);
      await json(route, {
        stats: {
          ...request.postDataJSON(), accountId: 'e2e-account', modeId,
          updatedAt: '2026-07-13T18:30:00.000Z',
        },
      });
    } else if (path === '/saves' && request.method() === 'GET') {
      await json(route, { saves: state.slot ? [state.slot] : [] });
    } else if (path === '/saves/classic' && request.method() === 'PUT') {
      if (state.rejectSaveWrites) {
        await route.abort('failed');
        return;
      }
      const body = request.postDataJSON() as { expectedRevision: number; runId: string | null; save: any };
      const currentRevision = state.slot?.revision ?? 0;
      if (body.expectedRevision !== currentRevision) {
        await json(route, { error: 'save_conflict', current: state.slot }, 409);
        return;
      }
      state.slot = {
        modeId: 'classic', revision: currentRevision + 1,
        runId: body.runId, save: body.save, updatedAt: '2026-07-13T18:30:00.000Z',
      };
      await json(route, { save: state.slot });
    } else {
      await json(route, { error: 'not_found' }, 404);
    }
  });
  return state;
}

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

    await page.getByRole('button', { name: 'PLAY', exact: true }).first().click();
    const dialog = page.locator('.saved-game-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('CONTINUE CLASSIC?');
    await expect(dialog).toContainText('Turns played');
    await dialog.getByRole('button', { name: 'RESUME GAME' }).click();
    expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe('BUTTON');
    await openDebugPanel(page);
    await waitForPhase(page, 'waiting');

    const after = await readSummary(page);
    expect(after.drops).toBe(before.drops);
    expect(after.score).toBe(before.score);
    expect(await readLiveBoard(page, 7)).toEqual(boardBefore);
  });

  test('recovers a cloud-only save after local storage is cleared', async ({ page }) => {
    const cloud = await installFakeAccountApi(page);
    await gotoSeeded(page);
    await playMode(page, 'Classic');
    await page.keyboard.press('ArrowDown');
    await waitForPhase(page, 'waiting');
    await expect.poll(() => cloud.slot?.save.state.dropCount).toBe(1);

    await page.evaluate(() => {
      for (const key of Object.keys(localStorage)) {
        if (key.startsWith('disco.save-sync.')) localStorage.removeItem(key);
      }
    });
    await page.reload();

    await page.getByRole('button', { name: 'PLAY', exact: true }).first().click();
    const dialog = page.locator('.saved-game-dialog');
    await expect(dialog).toContainText('CONTINUE CLASSIC?');
    await dialog.getByRole('button', { name: 'RESUME GAME' }).click();
    await openDebugPanel(page);
    await waitForPhase(page, 'waiting');
    expect((await readSummary(page)).drops).toBe('1');
  });

  test('keeps independent autosaves for Classic and Gravity', async ({ page }) => {
    await gotoSeeded(page);
    await playMode(page, 'Classic');
    await openDebugPanel(page);
    await page.keyboard.press('ArrowDown');
    await waitForPhase(page, 'waiting');

    await page.getByRole('button', { name: 'MENU', exact: true }).click();
    await page.locator('.game-menu').getByRole('button', { name: 'HOME' }).click();
    await playMode(page, 'Gravity');
    await page.keyboard.press('Enter');
    await waitForPhase(page, 'aiming');
    await page.keyboard.press('e');
    await page.keyboard.press('Enter');
    await waitForPhase(page, 'waiting');

    await page.reload();
    await playMode(page, 'Classic');
    const dialog = page.locator('.saved-game-dialog');
    await expect(dialog).toContainText('CONTINUE CLASSIC?');
    await dialog.getByRole('button', { name: 'CANCEL' }).click();
    await playMode(page, 'Gravity');
    await expect(dialog).toContainText('CONTINUE GRAVITY?');
  });

  test('defers a cross-device conflict and resumes the chosen cloud save', async ({ page }) => {
    const cloud = await installFakeAccountApi(page);
    await gotoSeeded(page);
    await playMode(page, 'Classic');
    await page.keyboard.press('ArrowDown');
    await waitForPhase(page, 'waiting');
    await expect.poll(() => cloud.slot?.revision).toBe(1);

    cloud.rejectSaveWrites = true;
    await page.keyboard.press('ArrowDown');
    await waitForPhase(page, 'waiting');
    const remote = structuredClone(cloud.slot!);
    remote.revision = 2;
    remote.save.state.score += 777;
    remote.save.savedAt += 1_000;
    cloud.slot = remote;
    cloud.rejectSaveWrites = false;

    await page.reload();
    await page.getByRole('button', { name: 'PLAY', exact: true }).first().click();
    const dialog = page.locator('.saved-game-dialog');
    await expect(dialog).toContainText('TWO CLASSIC SAVES FOUND');
    await dialog.getByRole('button', { name: 'USE CLOUD SAVE' }).click();
    await openDebugPanel(page);
    await waitForPhase(page, 'waiting');
    expect(Number((await readSummary(page)).score)).toBe(remote.save.state.score);
  });
});
