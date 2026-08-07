import { test, expect } from '@playwright/test';
import { cellAt, gotoSeeded, openDebugPanel, playMode, readLiveBoard, waitForPhase } from './helpers.js';

const SETTINGS_KEY = 'disco.user-settings';

// .zoom-layer, not the outer .game-stage, is what ZoomControls transforms —
// .game-stage is the fixed, clipping viewport and is never itself
// transformed. See the class doc comment on ZoomControls.
async function currentScale(page: import('@playwright/test').Page): Promise<number> {
  const transform = await page.locator('.zoom-layer').evaluate(el => el.style.transform);
  const match = /scale\(([^)]+)\)/.exec(transform);
  return match ? Number.parseFloat(match[1]!) : 1;
}

// The zoom controls live in the in-game menu (styles/zoom-controls.css'
// .game-menu-zoom), not as floating on-screen buttons, so every interaction
// needs the menu open first.
async function openGameMenu(page: import('@playwright/test').Page): Promise<void> {
  await page.locator('.home-back-button').click();
  await expect(page.locator('.game-menu')).toHaveClass(/game-menu--open/);
}

async function closeGameMenu(page: import('@playwright/test').Page): Promise<void> {
  await page.locator('.game-menu-button', { hasText: 'RESUME' }).click();
  await expect(page.locator('.game-menu')).not.toHaveClass(/game-menu--open/);
}

test.describe('zoom controls', () => {
  test('zoom-in button scales the stage and persists across a reload', async ({ page }) => {
    await gotoSeeded(page);
    await playMode(page, 'Classic');

    expect(await currentScale(page)).toBe(1);
    await openGameMenu(page);
    await page.locator('[data-game-menu-action="zoom-in"]').click();
    const zoomedScale = await currentScale(page);
    expect(zoomedScale).toBeGreaterThan(1);

    await page.reload();
    await expect.poll(() => currentScale(page)).toBeCloseTo(zoomedScale, 5);
  });

  test('reset button snaps the stage back to 1x', async ({ page }) => {
    await gotoSeeded(page);
    await playMode(page, 'Classic');

    await openGameMenu(page);
    await page.locator('[data-game-menu-action="zoom-in"]').click();
    await page.locator('[data-game-menu-action="zoom-in"]').click();
    expect(await currentScale(page)).toBeGreaterThan(1);

    await page.locator('[data-game-menu-action="zoom-reset"]').click();
    await expect.poll(() => currentScale(page)).toBeCloseTo(1, 5);
  });

  test('zoom-in disables at the max zoom level, zoom-out/reset disable back at 1x', async ({ page }) => {
    await gotoSeeded(page);
    await playMode(page, 'Classic');
    await openGameMenu(page);

    const zoomIn = page.locator('[data-game-menu-action="zoom-in"]');
    const zoomOut = page.locator('[data-game-menu-action="zoom-out"]');
    const zoomReset = page.locator('[data-game-menu-action="zoom-reset"]');

    await expect(zoomOut).toBeDisabled();
    await expect(zoomReset).toBeDisabled();

    // Stop clicking as soon as it disables — clicking a disabled locator
    // hangs waiting for it to become actionable again, which it won't.
    for (let i = 0; i < 10 && !(await zoomIn.isDisabled()); i++) await zoomIn.click();
    await expect(zoomIn).toBeDisabled();
    await expect(zoomOut).toBeEnabled();

    await zoomReset.click();
    await expect(zoomOut).toBeDisabled();
    await expect(zoomReset).toBeDisabled();
    await expect(zoomIn).toBeEnabled();
  });

  test('a persisted zoom level from a previous session does not compound on load', async ({ page }) => {
    // Regression test for the Renderer.resize() feedback loop: measuring the
    // already-scaled stage would double the board on every subsequent load.
    await gotoSeeded(page);
    await page.evaluate(key => {
      localStorage.setItem(key, JSON.stringify({ advancedHud: false, zoomLevel: 2 }));
    }, SETTINGS_KEY);
    await page.reload();
    await playMode(page, 'Classic');

    expect(await currentScale(page)).toBe(2);
    const zoomedCanvasWidth = await page.locator('.zoom-layer')
      .evaluate(el => el.style.getPropertyValue('--game-canvas-width'));

    await page.evaluate(key => localStorage.removeItem(key), SETTINGS_KEY);
    await page.reload();
    await playMode(page, 'Classic');
    const unzoomedCanvasWidth = await page.locator('.zoom-layer')
      .evaluate(el => el.style.getPropertyValue('--game-canvas-width'));

    // The board's own logical size must be identical whether or not a 2x
    // zoom was already applied when Renderer.resize() ran — proving it
    // measured the stage's untransformed size, not the painted 2x size.
    expect(zoomedCanvasWidth).toBe(unzoomedCanvasWidth);
  });

  test('resizing the viewport while zoomed in keeps the board visible and leaves the zoom level untouched', async ({ page }) => {
    await gotoSeeded(page);
    await playMode(page, 'Classic');

    await openGameMenu(page);
    await page.locator('[data-game-menu-action="zoom-in"]').click();
    await page.locator('[data-game-menu-action="zoom-in"]').click();
    const zoomedScale = await currentScale(page);
    expect(zoomedScale).toBeGreaterThan(1);
    await closeGameMenu(page);

    await page.setViewportSize({ width: 500, height: 800 });
    await page.waitForTimeout(100); // let the resize listener's reclamp run

    await expect(page.locator('.game-hud')).toBeVisible();
    const canvasBox = await page.locator('canvas').boundingBox();
    expect(canvasBox).not.toBeNull();
    expect(canvasBox!.width).toBeGreaterThan(0);
    expect(canvasBox!.height).toBeGreaterThan(0);
    // A resize re-clamps pan, not scale — the zoom level itself must survive.
    expect(await currentScale(page)).toBeCloseTo(zoomedScale, 5);
  });

  // Click a specific, off-center column (1, not the default middle column 3)
  // and confirm the drop lands there — the critical regression for
  // pixelToCol's rect-relative hit-testing under a real CSS transform. The
  // click's x-fraction is derived from the grid's own exposed geometry
  // (--game-canvas-width/--game-grid-width, set by Renderer.resize())
  // rather than a guessed fraction of the whole canvas: on a wide desktop
  // viewport the grid is centered inside a much wider canvas, so a naive
  // small fraction like 0.15 can land in that empty margin instead of on
  // the board at all.
  const TARGET_COLUMN = 1;
  const COLS = 7;

  async function columnXFraction(page: import('@playwright/test').Page, targetColumn: number): Promise<number> {
    const { canvasWidth, gridWidth } = await page.locator('.zoom-layer').evaluate(el => ({
      canvasWidth: Number.parseFloat(el.style.getPropertyValue('--game-canvas-width')),
      gridWidth: Number.parseFloat(el.style.getPropertyValue('--game-grid-width')),
    }));
    const gridStartX = (canvasWidth - gridWidth) / 2;
    const cellWidth = gridWidth / COLS;
    const targetX = gridStartX + (targetColumn + 0.5) * cellWidth;
    return targetX / canvasWidth;
  }

  async function dropAtColumn(page: import('@playwright/test').Page, targetColumn: number): Promise<number> {
    const fraction = await columnXFraction(page, targetColumn);
    const canvas = page.locator('canvas');
    const bounds = await canvas.boundingBox();
    if (!bounds) throw new Error('Board is not visible');
    await canvas.click({ position: { x: bounds.width * fraction, y: bounds.height / 2 } });
    await waitForPhase(page, 'waiting');
    const board = await readLiveBoard(page, COLS);
    for (let c = 0; c < COLS; c++) {
      if (cellAt(board, COLS, 6, c).text !== '·') return c;
    }
    throw new Error('no disc landed in the bottom row');
  }

  test('a tap drops into the correct column at 1x (baseline for the zoomed case below)', async ({ page }) => {
    await gotoSeeded(page);
    await playMode(page, 'Classic');
    await openDebugPanel(page);

    expect(await dropAtColumn(page, TARGET_COLUMN)).toBe(TARGET_COLUMN);
  });

  test('a tap still drops into the correct column when zoomed in', async ({ page }) => {
    await gotoSeeded(page);
    await playMode(page, 'Classic');

    await openGameMenu(page);
    await page.locator('[data-game-menu-action="zoom-in"]').click();
    await page.locator('[data-game-menu-action="zoom-in"]').click();
    // Button-driven zoom animates over 150ms (.zoom-layer--transitioning,
    // styles/zoom-controls.css) — wait it out before reading boundingBox()
    // below, or the computed transform (and so the click position) would be
    // read mid-transition instead of at its settled scale.
    await page.waitForTimeout(200);
    await closeGameMenu(page); // the menu modal makes the board inert while open
    expect(await currentScale(page)).toBeGreaterThan(1);

    await openDebugPanel(page);
    expect(await dropAtColumn(page, TARGET_COLUMN)).toBe(TARGET_COLUMN);
  });
});
