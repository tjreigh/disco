// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModalController } from '../../ui/modal-controller.js';

afterEach(() => {
  document.body.replaceChildren();
});

function createModal(onEscape = vi.fn()) {
  const opener = document.createElement('button');
  const background = document.createElement('main');
  const root = document.createElement('section');
  const first = document.createElement('button');
  const last = document.createElement('button');
  root.append(first, last);
  document.body.append(opener, background, root);

  const modal = new ModalController(root, {
    openClass: 'is-open',
    initialFocus: () => first,
    inertTargets: [background],
    onEscape,
  });
  return { modal, root, opener, background, first, last, onEscape };
}

describe('ModalController', () => {
  it('opens with an inert background and initial focus', () => {
    const { modal, root, opener, background, first } = createModal();
    opener.focus();

    modal.open();

    expect(root.classList.contains('is-open')).toBe(true);
    expect(root.getAttribute('aria-hidden')).toBe('false');
    expect(background.inert).toBe(true);
    expect(opener.inert).toBe(true);
    expect(document.activeElement).toBe(first);
  });

  it('traps focus at both ends of the modal', () => {
    const { modal, first, last } = createModal();
    modal.open();

    last.focus();
    last.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(document.activeElement).toBe(first);

    first.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Tab',
      shiftKey: true,
      bubbles: true,
    }));
    expect(document.activeElement).toBe(last);
  });

  it('delegates Escape and restores background and opener state when closed', () => {
    const { modal, opener, background, first, onEscape } = createModal();
    background.inert = true;
    opener.focus();
    modal.open();

    first.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(onEscape).toHaveBeenCalledOnce();

    modal.close();
    expect(background.inert).toBe(true);
    expect(document.activeElement).toBe(opener);
  });
});
