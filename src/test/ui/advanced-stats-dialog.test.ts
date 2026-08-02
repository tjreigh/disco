// @vitest-environment happy-dom

import { beforeEach, describe, expect, test, vi } from 'vitest';
import { CLASSIC_MODE, GRAVITY_MODE } from '../../game/modes/index.js';
import { emptyStats } from '../../game/stats.js';
import { AdvancedStatsDialog } from '../../ui/advanced-stats-dialog.js';

describe('AdvancedStatsDialog', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  test('renders all-mode and per-mode completed-run totals and rates', () => {
    const dialog = new AdvancedStatsDialog();
    dialog.open({
      modes: [
        {
          mode: CLASSIC_MODE,
          stats: {
            ...emptyStats(), gamesPlayed: 2, totalScore: 900, totalPlayTimeMs: 120_000,
            totalDiscsDropped: 30, totalDiscsBroken: 12,
          },
        },
        { mode: GRAVITY_MODE, stats: emptyStats() },
      ],
    });

    const root = document.querySelector<HTMLElement>('.advanced-stats-dialog')!;
    expect(root.classList).toContain('advanced-stats-dialog--open');
    expect(root.textContent).toContain('ALL MODES');
    expect(root.textContent).toContain('Time played2m');
    expect(root.textContent).toContain('Score / min450');
    expect(root.textContent).toContain('Dropped / min15');
    expect(root.textContent).toContain('Broken / min6');
    expect(root.textContent).toContain('—');
    const modeSection = document.querySelector<HTMLElement>('#advanced-stats-mode-classic')!;
    modeSection.focus();
    expect(modeSection.classList).not.toContain('advanced-stats-dialog__section--jump-target');
  });

  test('jumps to and focuses a requested mode and closes with Escape', () => {
    const scrollIntoView = vi.fn();
    vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(scrollIntoView);
    const dialog = new AdvancedStatsDialog();

    dialog.open({
      modes: [
        { mode: CLASSIC_MODE, stats: emptyStats() },
        { mode: GRAVITY_MODE, stats: emptyStats() },
      ],
      modeId: GRAVITY_MODE.id,
    });

    const section = document.querySelector<HTMLElement>('#advanced-stats-mode-gravity')!;
    expect(document.activeElement).toBe(section);
    expect(section.classList).toContain('advanced-stats-dialog__section--jump-target');
    expect(scrollIntoView).toHaveBeenCalledOnce();
    document.querySelector<HTMLButtonElement>('.advanced-stats-dialog__close')!.focus();
    expect(section.classList).toContain('advanced-stats-dialog__section--jump-target');
    section.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(dialog.isOpen()).toBe(false);
  });
});
