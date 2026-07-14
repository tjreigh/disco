// @vitest-environment happy-dom

import { beforeEach, describe, expect, test, vi } from 'vitest';
import { DiscKind } from '../../game/model.js';
import { RewindDialog } from '../../ui/rewind-dialog.js';

describe('RewindDialog', () => {
  beforeEach(() => document.body.replaceChildren());

  test('explains the exact cost and requires explicit confirmation', () => {
    const dialog = new RewindDialog();
    const confirm = vi.fn();
    const cancel = vi.fn();
    dialog.onConfirm = confirm;
    dialog.onCancel = cancel;
    dialog.show({
      board: [], cursorCol: 2, score: 50, dropCount: 4, level: 1,
      turnsPerLevel: 30, turnsRemaining: 26,
      currentDisc: { value: 2, kind: DiscKind.Numbered },
      nextDisc: { value: 4, kind: DiscKind.DoubleCracked },
      anchor: { row: 6, col: 2 }, rescuesGameOver: true,
      instabilityBefore: 4, instabilityAfter: 5,
      fractures: [
        { position: { row: 6, col: 1 }, discId: 11, discValue: 6, resultingKind: DiscKind.DoubleCracked },
        { position: { row: 5, col: 2 }, discId: 12, discValue: 4, resultingKind: DiscKind.DoubleCracked },
      ],
    });

    const root = document.querySelector<HTMLElement>('.rewind-dialog')!;
    expect(root.classList).toContain('rewind-dialog--open');
    expect(root.textContent).toContain('Instability 4 → 5');
    expect(root.textContent).toContain('Highlighted discs: 6 and 4 → two layers of temporal damage each');
    expect(root.textContent).toContain('rescues the run from game over');
    expect(root.getAttribute('aria-describedby')).toBe('rewind-dialog-consequence');
    const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>('button'));
    buttons.find(button => button.textContent === 'CONFIRM REWIND')!.click();
    buttons.find(button => button.textContent === 'KEEP TURN')!.click();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
