// @vitest-environment happy-dom

import { afterEach, describe, expect, test, vi } from 'vitest';
import { MultiplayerPauseMenu } from '../../ui/multiplayer-pause-menu.js';

afterEach(() => {
  document.body.replaceChildren();
});

function createPauseMenu() {
  const background = document.createElement('main');
  document.body.append(background);
  const menu = new MultiplayerPauseMenu(document.body, [background]);
  return { menu, background };
}

function findButton(label: string): HTMLButtonElement {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('.game-menu-button'))
    .find(button => button.textContent === label)!;
}

describe('MultiplayerPauseMenu forfeit confirmation', () => {
  test('forfeit opens an alertdialog naming the consequence, with focus on cancel', () => {
    const { menu } = createPauseMenu();
    const onForfeit = vi.fn();
    menu.onRequestForfeit = onForfeit;
    menu.open();

    findButton('FORFEIT MATCH').click();
    const dialog = document.querySelector<HTMLElement>('.restart-confirmation')!;
    const cancelButton = Array.from(dialog.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent === 'CANCEL')!;
    const confirmButton = dialog.querySelector<HTMLButtonElement>('.restart-confirmation__button--danger')!;

    expect(dialog.classList.contains('restart-confirmation--open')).toBe(true);
    expect(dialog.getAttribute('role')).toBe('alertdialog');
    expect(dialog.textContent).toContain('Your opponent will be declared the winner');
    expect(document.activeElement).toBe(cancelButton);
    expect(confirmButton.textContent).toBe('FORFEIT');
    expect(onForfeit).not.toHaveBeenCalled();
  });

  test('cancel closes the confirmation without forfeiting or closing the pause menu', () => {
    const { menu } = createPauseMenu();
    const onForfeit = vi.fn();
    menu.onRequestForfeit = onForfeit;
    menu.open();
    findButton('FORFEIT MATCH').click();

    const dialog = document.querySelector<HTMLElement>('.restart-confirmation')!;
    const cancelButton = Array.from(dialog.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent === 'CANCEL')!;
    cancelButton.click();

    expect(dialog.classList.contains('restart-confirmation--open')).toBe(false);
    expect(menu.isOpen()).toBe(true);
    expect(onForfeit).not.toHaveBeenCalled();
  });

  test('confirming forfeit closes the confirmation and the pause menu, then fires onRequestForfeit once', () => {
    const { menu } = createPauseMenu();
    const onForfeit = vi.fn();
    menu.onRequestForfeit = onForfeit;
    menu.open();
    findButton('FORFEIT MATCH').click();

    const dialog = document.querySelector<HTMLElement>('.restart-confirmation')!;
    const confirmButton = dialog.querySelector<HTMLButtonElement>('.restart-confirmation__button--danger')!;
    confirmButton.click();

    expect(dialog.classList.contains('restart-confirmation--open')).toBe(false);
    expect(menu.isOpen()).toBe(false);
    expect(onForfeit).toHaveBeenCalledTimes(1);
  });

  test('forceClose closes both the menu and any open forfeit confirmation without firing onRequestResume', () => {
    const { menu } = createPauseMenu();
    const onResume = vi.fn();
    menu.onRequestResume = onResume;
    menu.open();
    findButton('FORFEIT MATCH').click();

    menu.forceClose();

    const dialog = document.querySelector<HTMLElement>('.restart-confirmation')!;
    expect(dialog.classList.contains('restart-confirmation--open')).toBe(false);
    expect(menu.isOpen()).toBe(false);
    expect(onResume).not.toHaveBeenCalled();
  });
});

describe('MultiplayerPauseMenu sound/HUD/zoom controls', () => {
  test('open fires onRequestOpen and toggles reach their callbacks', () => {
    const { menu } = createPauseMenu();
    const onOpen = vi.fn();
    const onToggleSound = vi.fn();
    const onToggleAdvancedHud = vi.fn();
    menu.onRequestOpen = onOpen;
    menu.onRequestToggleSound = onToggleSound;
    menu.onRequestToggleAdvancedHud = onToggleAdvancedHud;

    menu.open();
    expect(onOpen).toHaveBeenCalledTimes(1);

    findButton('SOUND ON').click();
    expect(onToggleSound).toHaveBeenCalledTimes(1);

    menu.setAdvancedHudEnabled(true);
    const advancedHud = document.querySelector<HTMLButtonElement>('[data-pause-menu-action="advanced-hud"]')!;
    expect(advancedHud.textContent).toBe('ADVANCED HUD ON');
    expect(advancedHud.getAttribute('aria-pressed')).toBe('true');
    advancedHud.click();
    expect(onToggleAdvancedHud).toHaveBeenCalledTimes(1);
  });
});
