// @vitest-environment happy-dom

import { beforeEach, describe, expect, test, vi } from 'vitest';
import { CLASSIC_MODE, GRAVITY_MODE } from '../../game/modes/index.js';
import type { GameModeConfig } from '../../game/modes/mode.js';
import type { GameStats } from '../../game/stats.js';
import { HomeScreen } from '../../ui/home-screen.js';
import type { AccountStatsState } from '../../platform/account-stats-store.js';

function stats(overrides: Partial<GameStats> = {}): GameStats {
  return {
    highScore: 0,
    longestStreak: 0,
    averageScore: 0,
    gamesPlayed: 0,
    totalScore: 0,
    ...overrides,
  };
}

function auth(overrides: Partial<AccountStatsState> = {}): AccountStatsState {
  return {
    loading: false,
    apiAvailable: true,
    account: null,
    identities: [],
    ...overrides,
  };
}

function createHome(options: {
  authState?: AccountStatsState;
  loadStats?: (modeId: string) => GameStats;
  onSelectMode?: (mode: GameModeConfig) => void;
  onLogin?: () => void;
  onLogout?: () => void;
} = {}): HomeScreen {
  return new HomeScreen(
    [CLASSIC_MODE, GRAVITY_MODE],
    options.onSelectMode ?? vi.fn(),
    options.loadStats ?? (() => stats()),
    () => options.authState ?? auth(),
    options.onLogin ?? vi.fn(),
    options.onLogout ?? vi.fn(),
  );
}

describe('HomeScreen', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  test('renders mode cards and refreshes stats when opened', () => {
    const loadStats = vi.fn((modeId: string) => modeId === CLASSIC_MODE.id
      ? stats({ highScore: 1200, gamesPlayed: 2 })
      : stats());
    const home = createHome({ loadStats });

    home.open();

    expect(document.querySelector('.home-screen--open')).not.toBeNull();
    expect(document.body.textContent).toContain(CLASSIC_MODE.name);
    expect(document.body.textContent).toContain(GRAVITY_MODE.name);
    expect(document.body.textContent).toContain('Best 1200');
    expect(document.body.textContent).toContain('Not played yet');
    expect(loadStats).toHaveBeenCalledWith(CLASSIC_MODE.id);
  });

  test('starts normal play from the full card, keyboard, and play button', () => {
    const onSelectMode = vi.fn();
    const home = createHome({ onSelectMode });
    home.open();

    const card = document.querySelector<HTMLElement>('.home-mode-card')!;
    const playButton = document.querySelector<HTMLButtonElement>('.home-mode-action--play')!;

    card.click();
    card.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    card.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    playButton.click();

    expect(onSelectMode).toHaveBeenCalledTimes(4);
    expect(onSelectMode).toHaveBeenCalledWith(CLASSIC_MODE);
    expect(card.role).toBe('button');
    expect(card.tabIndex).toBe(0);
  });

  test('tutorial button starts tutorial without also starting normal play', () => {
    const onSelectMode = vi.fn();
    const onRequestTutorial = vi.fn();
    const home = createHome({ onSelectMode });
    home.onRequestTutorial = onRequestTutorial;
    home.open();

    const tutorialButton = Array.from(document.querySelectorAll<HTMLButtonElement>('.home-mode-action'))
      .find(button => button.textContent === 'TUTORIAL')!;
    tutorialButton.click();

    expect(onRequestTutorial).toHaveBeenCalledTimes(1);
    expect(onRequestTutorial).toHaveBeenCalledWith(CLASSIC_MODE);
    expect(onSelectMode).not.toHaveBeenCalled();
  });

  test('auth button calls login or logout based on account state', () => {
    const onLogin = vi.fn();
    const onLogout = vi.fn();
    const signedOut = createHome({ authState: auth(), onLogin, onLogout });

    document.querySelector<HTMLButtonElement>('.home-auth-button')!.click();
    expect(onLogin).toHaveBeenCalledTimes(1);
    expect(onLogout).not.toHaveBeenCalled();

    document.body.replaceChildren();
    createHome({
      authState: auth({ account: { id: 'acct-1', displayName: 'Ada' } }),
      onLogin,
      onLogout,
    });

    expect(document.body.textContent).toContain('Signed in as Ada');
    document.querySelector<HTMLButtonElement>('.home-auth-button')!.click();
    expect(onLogout).toHaveBeenCalledTimes(1);
  });

  test('open, close, and game menu callbacks update menu state', () => {
    const home = createHome();
    const onResume = vi.fn();
    const onRestart = vi.fn();
    const onHome = vi.fn();
    const onToggleSound = vi.fn();
    home.onRequestResume = onResume;
    home.onRequestRestart = onRestart;
    home.onRequestHome = onHome;
    home.onRequestToggleSound = onToggleSound;

    home.open();
    home.close();
    expect(document.querySelector('.home-back-button--visible')).not.toBeNull();

    home.openGameMenu();
    expect(home.isGameMenuOpen()).toBe(true);
    expect(document.querySelector('.game-menu--open')).not.toBeNull();

    for (const label of ['RESUME', 'RESTART', 'HOME', 'SOUND ON']) {
      Array.from(document.querySelectorAll<HTMLButtonElement>('.game-menu-button'))
        .find(button => button.textContent === label)!
        .click();
    }

    expect(onResume).toHaveBeenCalledTimes(1);
    expect(onRestart).toHaveBeenCalledTimes(1);
    expect(onHome).toHaveBeenCalledTimes(1);
    expect(onToggleSound).toHaveBeenCalledTimes(1);

    home.closeGameMenu();
    expect(home.isGameMenuOpen()).toBe(false);
  });

  test('mode actions are buttons but mode cards are not nested buttons', () => {
    createHome();

    for (const card of document.querySelectorAll('.home-mode-card')) {
      expect(card.tagName).toBe('DIV');
      expect(card.querySelectorAll('button')).toHaveLength(2);
      expect(card.querySelector('button button')).toBeNull();
    }
  });
});
