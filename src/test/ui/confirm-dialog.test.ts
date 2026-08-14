// @vitest-environment happy-dom

import { afterEach, describe, expect, test, vi } from 'vitest';
import { ConfirmDialog } from '../../ui/confirm-dialog.js';

afterEach(() => {
  document.body.replaceChildren();
});

function createDialog(overrides: Partial<{
  title: string;
  description: string;
  confirmLabel: string;
  onConfirm: () => void;
  modalBackground: readonly HTMLElement[];
}> = {}) {
  const background = document.createElement('main');
  document.body.append(background);
  const onConfirm = overrides.onConfirm ?? vi.fn();
  const dialog = new ConfirmDialog(document.body, overrides.modalBackground ?? [background], {
    title: overrides.title ?? 'RESTART GAME?',
    description: overrides.description ?? 'Your current run will be replaced.',
    confirmLabel: overrides.confirmLabel ?? 'RESTART GAME',
    onConfirm,
  });
  // The last `.restart-confirmation` in the DOM, not the first — a test may
  // construct more than one dialog (see "two dialogs on the same page").
  const root = Array.from(document.querySelectorAll<HTMLElement>('.restart-confirmation')).at(-1)!;
  const cancelButton = Array.from(root.querySelectorAll<HTMLButtonElement>('button'))
    .find(button => button.textContent === 'CANCEL')!;
  const confirmButton = root.querySelector<HTMLButtonElement>('.restart-confirmation__button--danger')!;
  return { dialog, root, background, cancelButton, confirmButton, onConfirm };
}

describe('ConfirmDialog', () => {
  test('renders the given copy and opens as an alertdialog with focus on cancel', () => {
    const { dialog, root, cancelButton } = createDialog({
      title: 'FORFEIT MATCH?',
      description: "Your opponent will be declared the winner. This can't be undone.",
      confirmLabel: 'FORFEIT',
    });

    dialog.open();

    expect(root.classList.contains('restart-confirmation--open')).toBe(true);
    expect(root.getAttribute('role')).toBe('alertdialog');
    expect(root.textContent).toContain('FORFEIT MATCH?');
    expect(root.textContent).toContain("Your opponent will be declared the winner. This can't be undone.");
    expect(document.activeElement).toBe(cancelButton);
  });

  test('cancel closes without confirming', () => {
    const { dialog, root, cancelButton, onConfirm } = createDialog();
    dialog.open();

    cancelButton.click();

    expect(root.classList.contains('restart-confirmation--open')).toBe(false);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  test('confirm closes and fires onConfirm exactly once', () => {
    const { dialog, root, confirmButton, onConfirm } = createDialog();
    dialog.open();

    confirmButton.click();

    expect(root.classList.contains('restart-confirmation--open')).toBe(false);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  test('the confirm button carries the danger styling and given label', () => {
    const { confirmButton } = createDialog({ confirmLabel: 'FORFEIT' });
    expect(confirmButton.classList.contains('restart-confirmation__button--danger')).toBe(true);
    expect(confirmButton.textContent).toBe('FORFEIT');
  });

  test('Escape closes the dialog without confirming', () => {
    const { dialog, root, cancelButton, onConfirm } = createDialog();
    dialog.open();

    cancelButton.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(root.classList.contains('restart-confirmation--open')).toBe(false);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  test('background targets become inert while open and are restored on close', () => {
    const { dialog, background } = createDialog();
    dialog.open();
    expect(background.inert).toBe(true);

    dialog.close();
    expect(background.inert).toBe(false);
  });

  test('two dialogs on the same page get distinct title/description ids', () => {
    const { root: firstRoot } = createDialog({ title: 'RESTART GAME?' });
    const { root: secondRoot } = createDialog({ title: 'FORFEIT MATCH?' });

    const firstLabelledBy = firstRoot.getAttribute('aria-labelledby');
    const secondLabelledBy = secondRoot.getAttribute('aria-labelledby');
    expect(firstLabelledBy).not.toBe(secondLabelledBy);
    expect(document.querySelectorAll(`#${firstLabelledBy}`)).toHaveLength(1);
    expect(document.querySelectorAll(`#${secondLabelledBy}`)).toHaveLength(1);
  });

  test('destroy removes the dialog from the DOM', () => {
    const { dialog, root } = createDialog();
    expect(document.body.contains(root)).toBe(true);
    dialog.destroy();
    expect(document.body.contains(root)).toBe(false);
  });
});
