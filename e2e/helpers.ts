import { expect, type Locator, type Page } from '@playwright/test';

// Clicking a <button> leaves it focused; InputHandler's keydown listener
// ignores keys while focus is on any element with tabIndex >= 0 (so the
// debug panel's own focusable controls don't steal game input) — which
// means a real click on PLAY or the debug toggle would silently swallow
// the next keyboard-driven game action unless we blur it back off first.
export async function clickAndBlur(locator: Locator): Promise<void> {
  await locator.click();
  await locator.evaluate(el => (el as HTMLElement).blur());
}

export async function playMode(page: Page, modeName: string): Promise<void> {
  const card = page.locator('.home-mode-card', { hasText: modeName });
  await clickAndBlur(card.locator('.home-mode-action--play'));
}

export async function openDebugPanel(page: Page): Promise<void> {
  const panel = page.locator('.debug-panel');
  const isOpen = await panel.evaluate(el => el.classList.contains('debug-panel--open'));
  if (!isOpen) {
    await clickAndBlur(page.locator('.debug-toggle'));
  }
}

// Default cursor column for a 7-wide board (Math.floor(cols / 2)).
export const DEFAULT_CURSOR_COL = 3;

// ?seed=1 makes disc generation deterministic (via game-controller.ts's
// debugSeedOverride testability hook) instead of random-per-playthrough.
// Verified headlessly against public/dist: the first several discs for both
// Classic and Gravity are 6,7,3,4,5,... — no lone 1 (auto-clears alone) and
// no adjacent pair summing to a 2-run, so none of this suite's drop/stack
// scenarios trigger an incidental clear that would make an assertion flaky.
export async function gotoSeeded(page: Page): Promise<void> {
  await page.goto('/?seed=1');
}

export async function moveCursorTo(page: Page, targetLane: number, fromLane = DEFAULT_CURSOR_COL): Promise<void> {
  const delta = targetLane - fromLane;
  const key = delta > 0 ? 'ArrowRight' : 'ArrowLeft';
  for (let i = 0; i < Math.abs(delta); i++) await page.keyboard.press(key);
}

export interface DebugCellInfo {
  row: number;
  col: number;
  text: string; // '·' for empty, else discText() output (e.g. "7", "3╱", "3╳")
  kind: 'numbered' | 'single-cracked' | 'double-cracked' | null;
}

// Reads GameState.board directly from the debug panel's "Committed board"
// grid — this is the authoritative, already-final post-physics board (set
// synchronously by GameEngine.drop/confirmDrop, rendered via recordTurn()
// before any animation plays), not the animated visual board. Assertions
// against it don't need to wait for animation timing.
export async function readLiveBoard(page: Page, cols: number): Promise<DebugCellInfo[]> {
  const raw = await page.locator('h2:has-text("Committed board") + .debug-grid').evaluate(grid =>
    Array.from(grid.children).map(cell => ({
      text: (cell.textContent ?? '').trim(),
      className: cell.className,
    }))
  );
  return raw.map((c, i) => {
    const kindMatch = c.className.match(/debug-cell--(numbered|single-cracked|double-cracked)/);
    return {
      row: Math.floor(i / cols),
      col: i % cols,
      text: c.text,
      kind: (kindMatch?.[1] as DebugCellInfo['kind']) ?? null,
    };
  });
}

export function cellAt(board: readonly DebugCellInfo[], cols: number, row: number, col: number): DebugCellInfo {
  return board[row * cols + col]!;
}

// A resolved turn sets state.phase to Animating synchronously and only flips
// it back to WaitingForDrop inside AnimationQueue's onComplete, which fires
// asynchronously once the (real-time) animation finishes — so a turn's true
// end state isn't observable until this resolves.
export async function waitForPhase(page: Page, phase: string): Promise<void> {
  await expect(page.locator('.debug-summary')).toContainText(`phase=${phase}`, { timeout: 5000 });
}

// Parses the "phase=waiting  score=0  drops=1  level=1  turnsLeft=29/30" summary line.
export async function readSummary(page: Page): Promise<Record<string, string>> {
  const text = await page.locator('.debug-summary').textContent();
  const out: Record<string, string> = {};
  for (const match of (text ?? '').matchAll(/(\w+)=(\S+)/g)) {
    out[match[1]!] = match[2]!;
  }
  return out;
}
