// @vitest-environment happy-dom

import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { SaveGameV1 } from '../../game/save.js';
import { CLASSIC_MODE } from '../../game/modes/classic.js';
import { STACK_MODE } from '../../game/modes/stack.js';
import { SavedGameDialog } from '../../ui/saved-game-dialog.js';

function savedGame(overrides: {
  modeId?: string;
  score?: number;
  level?: number;
  dropCount?: number;
  longestStreak?: number;
  savedAt?: number;
} = {}): SaveGameV1 {
  return {
    version: 1,
    rulesVersion: 1,
    savedAt: overrides.savedAt ?? Date.UTC(2026, 6, 13, 18, 30),
    modeId: overrides.modeId ?? 'classic',
    state: {
      phase: 'waiting',
      board: [],
      cursorCol: 0,
      score: overrides.score ?? 12_450,
      dropCount: overrides.dropCount ?? 37,
      level: overrides.level ?? 4,
      turnsPerLevel: 20,
      turnsRemaining: 10,
    },
    generation: {
      source: 'seeded',
      seed: 1,
      queue: [],
      playableGenerator: { recentValues: [], recentKinds: [] },
      random: { playableState: 1, pushState: 2 },
    },
    session: { longestStreak: overrides.longestStreak ?? 6 },
    meta: { source: 'autosave' },
  };
}

function root(): HTMLElement {
  const element = document.querySelector<HTMLElement>('.saved-game-dialog');
  if (!element) throw new Error('Saved game dialog not found');
  return element;
}

function button(label: string): HTMLButtonElement {
  const match = Array.from(root().querySelectorAll<HTMLButtonElement>('button'))
    .find(candidate => candidate.textContent === label);
  if (!match) throw new Error(`Button not found: ${label}`);
  return match;
}

describe('SavedGameDialog', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  test('renders a mode save summary and resumes through the primary action', () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    const dialog = new SavedGameDialog();
    const save = savedGame();
    const onResume = vi.fn();
    dialog.onResume = onResume;

    dialog.showSave(CLASSIC_MODE, save);

    const overlay = root();
    const resume = button('RESUME GAME');
    expect(overlay.getAttribute('role')).toBe('dialog');
    expect(overlay.getAttribute('aria-modal')).toBe('true');
    expect(overlay.getAttribute('aria-hidden')).toBe('false');
    expect(overlay.getAttribute('aria-labelledby')).toBeTruthy();
    expect(overlay.getAttribute('aria-describedby')).toBeTruthy();
    expect(overlay.textContent).toContain('CONTINUE CLASSIC?');
    expect(overlay.textContent).toContain('ModeClassic');
    expect(overlay.textContent).toContain('Score12,450');
    expect(overlay.textContent).toContain('Level4');
    expect(overlay.textContent).toContain('Turns played37');
    expect(overlay.textContent).toContain('Longest streak6');
    expect(overlay.textContent).toContain('Last played');
    expect(overlay.querySelector('time')?.dateTime).toBe('2026-07-13T18:30:00.000Z');
    expect(document.activeElement).toBe(resume);

    resume.click();

    expect(onResume).toHaveBeenCalledWith(save);
    expect(overlay.getAttribute('aria-hidden')).toBe('true');
    expect(document.activeElement).toBe(opener);
  });

  test('uses Best stack for Stack mode and routes start-new and cancel actions', () => {
    const dialog = new SavedGameDialog();
    const onStartNew = vi.fn();
    const onCancel = vi.fn();
    dialog.onStartNew = onStartNew;
    dialog.onCancel = onCancel;

    dialog.showSave(STACK_MODE, savedGame({ modeId: 'stack', longestStreak: 8 }));
    expect(root().textContent).toContain('Best stack8');
    expect(root().textContent).not.toContain('Longest streak');
    button('START NEW GAME').click();
    expect(onStartNew).toHaveBeenCalledTimes(1);

    dialog.showSave(STACK_MODE, savedGame({ modeId: 'stack' }));
    button('CANCEL').click();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  test('compares device and cloud saves and routes either resolution', () => {
    const dialog = new SavedGameDialog();
    const local = savedGame({ score: 14_200 });
    const cloud = savedGame({ score: 11_800 });
    const onChooseLocal = vi.fn();
    const onChooseCloud = vi.fn();
    dialog.onChooseLocal = onChooseLocal;
    dialog.onChooseCloud = onChooseCloud;

    dialog.showConflict(CLASSIC_MODE, local, cloud);

    expect(root().textContent).toContain('TWO CLASSIC SAVES FOUND');
    expect(root().textContent).toContain('This Device');
    expect(root().textContent).toContain('Cloud Save');
    expect(root().textContent).toContain('14,200');
    expect(root().textContent).toContain('11,800');
    expect(document.activeElement).toBe(button('USE THIS DEVICE'));
    button('USE THIS DEVICE').click();
    expect(onChooseLocal).toHaveBeenCalledWith(local);

    dialog.showConflict(CLASSIC_MODE, local, cloud);
    button('USE CLOUD SAVE').click();
    expect(onChooseCloud).toHaveBeenCalledWith(cloud);
  });

  test('supports a tombstone on either side without offering an empty save', () => {
    const dialog = new SavedGameDialog();
    const cloud = savedGame({ score: 900 });
    const onChooseCloud = vi.fn();
    dialog.onChooseCloud = onChooseCloud;

    dialog.showConflict(CLASSIC_MODE, null, cloud);

    expect(root().textContent).toContain('No saved game');
    expect(root().querySelectorAll('.saved-game-dialog__save-card--empty')).toHaveLength(1);
    expect(() => button('USE THIS DEVICE')).toThrow();
    expect(document.activeElement).toBe(button('USE CLOUD SAVE'));
    button('USE CLOUD SAVE').click();
    expect(onChooseCloud).toHaveBeenCalledWith(cloud);

    dialog.showConflict(CLASSIC_MODE, savedGame(), null);
    expect(() => button('USE CLOUD SAVE')).toThrow();
    expect(document.activeElement).toBe(button('USE THIS DEVICE'));
  });

  test('explains an incompatible cloud save and requires an explicit choice', () => {
    const dialog = new SavedGameDialog();
    const onStartNew = vi.fn();
    const onCancel = vi.fn();
    dialog.onStartNew = onStartNew;
    dialog.onCancel = onCancel;

    dialog.showUnavailable(CLASSIC_MODE);

    expect(root().textContent).toContain('CLASSIC SAVE UNAVAILABLE');
    expect(root().textContent).toContain('cloud save is incompatible');
    expect(root().textContent).toContain('Starting a new game will replace this saved game.');
    expect(document.activeElement).toBe(button('START NEW GAME'));
    button('CANCEL').click();
    expect(onStartNew).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  test('allows a valid device save to replace an incompatible cloud save', () => {
    const dialog = new SavedGameDialog();
    const local = savedGame({ score: 17_500 });
    const onChooseLocal = vi.fn();
    dialog.onChooseLocal = onChooseLocal;

    dialog.showUnavailable(CLASSIC_MODE, local);

    expect(document.activeElement).toBe(button('USE THIS DEVICE'));
    button('USE THIS DEVICE').click();
    expect(onChooseLocal).toHaveBeenCalledWith(local);
  });

  test('Escape cancels, restores focus, and Tab cannot leave the modal', () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    const dialog = new SavedGameDialog();
    const onCancel = vi.fn();
    dialog.onCancel = onCancel;
    dialog.showSave(CLASSIC_MODE, savedGame());

    const resume = button('RESUME GAME');
    const cancel = button('CANCEL');
    cancel.focus();
    cancel.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Tab', bubbles: true, cancelable: true,
    }));
    expect(document.activeElement).toBe(resume);

    resume.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Tab', shiftKey: true, bubbles: true, cancelable: true,
    }));
    expect(document.activeElement).toBe(cancel);

    root().dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape', bubbles: true, cancelable: true,
    }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(dialog.isOpen()).toBe(false);
    expect(document.activeElement).toBe(opener);
  });
});
