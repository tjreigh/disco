import { test, expect } from '@playwright/test';
import { cellAt, gotoSeeded, openDebugPanel, playMode, readLiveBoard, readSummary, waitForPhase } from './helpers.js';

test.use({
  viewport: { width: 393, height: 852 },
  isMobile: true,
  hasTouch: true,
});

test.describe('mobile playability', () => {
  test('Classic exposes the HUD and touch controls, and a tap drops a disc', async ({ page }) => {
    await gotoSeeded(page);
    await playMode(page, 'Classic');

    await expect(page.locator('.game-hud')).toBeVisible();
    await expect(page.locator('.game-controls')).toBeVisible();
    await expect(page.locator('[data-control="drop"]')).toBeVisible();

    await openDebugPanel(page);
    await page.locator('[data-control="drop"]').tap();
    await waitForPhase(page, 'waiting');

    expect((await readSummary(page)).drops).toBe('1');
    const board = await readLiveBoard(page, 7);
    expect(cellAt(board, 7, 6, 3).text).not.toBe('·');
  });

  test('Gravity stages a lane, then exposes tilt controls before confirming a turn', async ({ page }) => {
    await gotoSeeded(page);
    await playMode(page, 'Gravity');

    await expect(page.locator('.game-controls')).toBeVisible();
    await expect(page.locator('[data-control="previous"]')).toBeVisible();
    await expect(page.locator('[data-control="drop"]')).toBeVisible();

    await page.locator('[data-control="drop"]').tap();
    await openDebugPanel(page);
    await waitForPhase(page, 'aiming');
    await expect(page.locator('[data-control="cancel"]')).toBeVisible();
    await expect(page.locator('[data-control="confirm"]')).toBeVisible();
    await expect(page.locator('[data-control="previous"]')).toBeHidden();
    await expect(page.locator('[data-control="tilt-counter-clockwise"]')).toHaveClass(/game-control--attention/);
    await expect(page.locator('[data-control="tilt-clockwise"]')).toHaveClass(/game-control--attention/);

    await page.locator('[aria-label="Close debugger"]').tap();
    await page.locator('[data-control="tilt-clockwise"]').tap();
    await expect(page.locator('[data-control="tilt-counter-clockwise"]')).not.toHaveClass(/game-control--attention/);
    await expect(page.locator('[data-control="tilt-clockwise"]')).not.toHaveClass(/game-control--attention/);
    await page.locator('[data-control="confirm"]').tap();
    await openDebugPanel(page);
    await waitForPhase(page, 'waiting');
    expect((await readSummary(page)).drops).toBe('1');
  });

  test('Paradox exposes a touch Rewind control that enables after a completed turn', async ({ page }) => {
    await gotoSeeded(page);
    await playMode(page, 'Paradox');
    const rewind = page.locator('[data-control="rewind"]');
    await expect(rewind).toBeVisible();
    await expect(rewind).toBeDisabled();

    await page.locator('[data-control="drop"]').tap();
    await openDebugPanel(page);
    await waitForPhase(page, 'waiting');
    await expect(rewind).toBeEnabled();
  });

  test('Paradox top utilities stay separated on an iPhone 16 Pro viewport', async ({ page }) => {
    await page.setViewportSize({ width: 402, height: 874 });
    await gotoSeeded(page);
    await playMode(page, 'Paradox');

    const menu = page.locator('.home-back-button');
    const instability = page.locator('.game-hud__instability');
    const score = page.locator('.game-hud__score');
    const controls = page.locator('.game-controls');
    const footer = page.locator('.home-footer');
    const [menuBox, instabilityBox, scoreBox, controlsBox, footerBox] = await Promise.all([
      menu.boundingBox(),
      instability.boundingBox(),
      score.boundingBox(),
      controls.boundingBox(),
      footer.boundingBox(),
    ]);

    expect(menuBox).not.toBeNull();
    expect(instabilityBox).not.toBeNull();
    expect(scoreBox).not.toBeNull();
    expect(controlsBox).not.toBeNull();
    expect(footerBox).not.toBeNull();
    expect(menuBox!.width).toBeGreaterThanOrEqual(44);
    expect(menuBox!.height).toBeGreaterThanOrEqual(44);
    expect(menuBox!.x + menuBox!.width).toBeLessThan(instabilityBox!.x);
    expect(menuBox!.x + menuBox!.width).toBeLessThan(scoreBox!.x);
    expect(scoreBox!.x + scoreBox!.width).toBeLessThan(instabilityBox!.x);
    expect(controlsBox!.y + controlsBox!.height).toBeLessThanOrEqual(footerBox!.y);
    expect(footerBox!.y + footerBox!.height).toBeLessThanOrEqual(874);
  });

  test('resize keeps HUD geometry variables aligned with the canvas and board', async ({ page }) => {
    await gotoSeeded(page);
    await playMode(page, 'Classic');

    // --game-canvas-width/height and --game-grid-width are set on
    // .zoom-layer (the content/transform layer inside the fixed, clipping
    // .game-stage viewport), not .game-stage itself — see ui-root.template.html.
    const before = await page.locator('.zoom-layer').evaluate(stage => ({
      canvasWidth: stage.style.getPropertyValue('--game-canvas-width'),
      canvasHeight: stage.style.getPropertyValue('--game-canvas-height'),
      gridWidth: stage.style.getPropertyValue('--game-grid-width'),
    }));
    await page.setViewportSize({ width: 375, height: 667 });
    await page.waitForTimeout(50);
    const after = await page.locator('.zoom-layer').evaluate(stage => ({
      canvasWidth: stage.style.getPropertyValue('--game-canvas-width'),
      canvasHeight: stage.style.getPropertyValue('--game-canvas-height'),
      gridWidth: stage.style.getPropertyValue('--game-grid-width'),
    }));

    expect(after.canvasWidth).not.toBe(before.canvasWidth);
    expect(after.canvasHeight).not.toBe(before.canvasHeight);
    expect(Number.parseFloat(after.gridWidth)).toBeLessThanOrEqual(Number.parseFloat(after.canvasWidth));
    await expect(page.locator('.game-hud')).toBeVisible();
  });

  test('zooming in never moves or resizes the outer clipping viewport, even on the smallest phones', async ({ page }) => {
    // At 320x568 the MIN_CELL_SIZE-floored board can already exceed the
    // available stage height before any zoom is applied (see layout.ts) —
    // the outer .game-stage must stay a fixed clipping viewport regardless,
    // or a pan could move the clip boundary itself and reveal empty page
    // background past the board's edges instead of only panning within it.
    // .zoom-layer, nested inside it, is what actually gets transformed.
    await page.setViewportSize({ width: 320, height: 568 });
    await gotoSeeded(page);
    await playMode(page, 'Classic');

    const rect = () => page.locator('.game-stage').evaluate(el => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    });
    const stageRectBefore = await rect();

    await page.locator('.home-back-button').click();
    await expect(page.locator('.game-menu')).toHaveClass(/game-menu--open/);
    await page.locator('[data-game-menu-action="zoom-in"]').click();
    await page.locator('[data-game-menu-action="zoom-in"]').click();
    await page.waitForTimeout(200); // let the button-driven transition settle

    const zoomLayerScale = await page.locator('.zoom-layer').evaluate(el => {
      const match = /scale\(([^)]+)\)/.exec(el.style.transform);
      return match ? Number.parseFloat(match[1]!) : 1;
    });
    expect(zoomLayerScale).toBeGreaterThan(1); // sanity: a real zoom happened

    expect(await rect()).toEqual(stageRectBefore);
  });
});
