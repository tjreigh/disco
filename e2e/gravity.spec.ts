import { test, expect } from '@playwright/test';
import { cellAt, DEFAULT_CURSOR_COL, gotoSeeded, openDebugPanel, playMode, readLiveBoard, readSummary, waitForPhase } from './helpers.js';

test.describe('Gravity mode', () => {
  test.beforeEach(async ({ page }) => {
    await gotoSeeded(page);
    await playMode(page, 'Gravity');
    await openDebugPanel(page);
  });

  test('a drop with no tilt resolves instantly, straight down like Classic', async ({ page }) => {
    await page.keyboard.press('Enter'); // drop into the default column, angle is untouched at 0
    await waitForPhase(page, 'waiting');

    const summary = await readSummary(page);
    expect(summary.drops).toBe('1');

    const board = await readLiveBoard(page, 7);
    expect(cellAt(board, 7, 6, DEFAULT_CURSOR_COL).text).not.toBe('·');
  });

  test('tilting begins Aiming without touching the board or spending a turn', async ({ page }) => {
    await page.keyboard.press('e'); // begins a tilt action
    await waitForPhase(page, 'aiming');

    const summary = await readSummary(page);
    expect(summary.drops).toBe('0'); // nothing committed yet

    const board = await readLiveBoard(page, 7);
    expect(board.every(c => c.text === '·')).toBe(true); // state.board itself is untouched during Aiming
  });

  test('cancelling a tilt is free — no turn spent, phase returns to waiting', async ({ page }) => {
    await page.keyboard.press('e');
    await page.keyboard.press('e');
    await waitForPhase(page, 'aiming');

    await page.keyboard.press('Escape');
    await waitForPhase(page, 'waiting');

    const summary = await readSummary(page);
    expect(summary.drops).toBe('0');
  });

  test('committing a tilt costs a turn even with nothing on the board', async ({ page }) => {
    await page.keyboard.press('e');
    await waitForPhase(page, 'aiming');
    await page.keyboard.press('Enter'); // commit
    await waitForPhase(page, 'waiting');

    const summary = await readSummary(page);
    expect(summary.drops).toBe('1'); // a turn was spent, even though no disc was dropped
  });

  // The mechanic that actually distinguishes this from Drop7: an
  // already-placed disc gets moved by a LATER, unrelated tilt turn — not
  // just discs entering diagonally on their own drop.
  //
  // Settling only produces a shape the clear-checker fully recognizes as a
  // line at exactly 8 angles, so GameEngine.commitTilt snaps the angle
  // itself to the nearest of those 8 (0/45/90/.../315) — a raw drag can't
  // land anywhere in between once committed. That means from a 0deg start, a
  // single tilt action (clamped to +/-45deg) can only ever commit to exactly
  // 0deg or 45deg, never something in between like the old 40deg this test
  // used to use.
  //
  // Hand-verified via gravity.ts's ray-march (also exercised directly by the
  // 'tilt is clamped' test above, which validates the first two steps below):
  //   1. Tilt (clamped) to 45deg and commit (empty board, still costs a
  //      turn). At exactly 45deg the entry edge snaps to 'left' (nearest
  //      cardinal to 45 rounds up to 90), so the default cursor (3) now
  //      selects ROW 3, not column 3.
  //   2. Drop into row 3 under 45deg: from (3,0), the ray steps to
  //      (4,1)[dup at t=2]->(5,2)->(6,3) — lands at (row 6, col 3).
  //   3. Tilt again, this time to 90deg (turnStartAngle is now 45, so
  //      clamping +45 from there reaches exactly 90) and commit: straight
  //      rightward gravity slides the disc from (6,3) along row 6 to the
  //      right wall, landing at (row 6, col 6).
  test('tilting after a drop moves the already-placed disc, not just new ones', async ({ page }) => {
    for (let i = 0; i < 30; i++) await page.keyboard.press('e'); // clamps to 45deg
    await waitForPhase(page, 'aiming');
    await page.keyboard.press('Enter'); // commit tilt #1 at 45deg
    await waitForPhase(page, 'waiting');

    await page.keyboard.press('Enter'); // drop into row 3 under 45deg
    await waitForPhase(page, 'waiting');
    let board = await readLiveBoard(page, 7);
    expect(cellAt(board, 7, 6, 3).text).not.toBe('·');

    for (let i = 0; i < 30; i++) await page.keyboard.press('e'); // clamps to 45+45=90deg
    await waitForPhase(page, 'aiming');
    await page.keyboard.press('Enter'); // commit tilt #2 at 90deg
    await waitForPhase(page, 'waiting');

    const summary = await readSummary(page);
    expect(summary.drops).toBe('3'); // tilt, drop, tilt — three turns total

    board = await readLiveBoard(page, 7);
    expect(cellAt(board, 7, 6, 3).text).toBe('·'); // no longer where it landed
    expect(cellAt(board, 7, 6, 6).text).not.toBe('·'); // slid right along the floor
  });

  test('tilt is clamped to +/-45deg from the start of that tilt action', async ({ page }) => {
    for (let i = 0; i < 30; i++) await page.keyboard.press('e'); // 30*5=150deg requested, clamps to 45
    await waitForPhase(page, 'aiming');
    await page.keyboard.press('Enter'); // commit at the clamped 45deg
    await waitForPhase(page, 'waiting');

    // At exactly 45deg the entry edge snaps to 'left' (nearest cardinal to
    // 45 rounds up to 90/right), so the default cursor (3) now selects ROW 3,
    // not column 3 — entry position (row 3, col 0).
    await page.keyboard.press('Enter'); // drop into row 3 under the clamped 45deg
    await waitForPhase(page, 'waiting');

    const board = await readLiveBoard(page, 7);
    // Ray-march from (row 3, col 0) at 45deg: (3,0)->(4,1)[dup at t=2]->(5,2)->(6,3).
    expect(cellAt(board, 7, 6, 3).text).not.toBe('·');
  });
});
