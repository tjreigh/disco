// @vitest-environment happy-dom

import { beforeEach, describe, expect, test, vi } from 'vitest';
import { CLASSIC_MODE, GRAVITY_MODE, STACK_MODE } from '../../game/modes/index.js';
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
  mount?: HTMLElement;
  modalBackground?: readonly HTMLElement[];
} = {}): HomeScreen {
  return new HomeScreen(
    [CLASSIC_MODE, GRAVITY_MODE, STACK_MODE],
    options.onSelectMode ?? vi.fn(),
    options.loadStats ?? (() => stats()),
    () => options.authState ?? auth(),
    options.onLogin ?? vi.fn(),
    options.onLogout ?? vi.fn(),
    options.mount,
    options.modalBackground,
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
    expect(document.querySelector('[data-mode-id="classic"]')?.textContent).toContain('HIGH 1200');
    expect(document.querySelector('.home-mode-detail')?.textContent).toContain('1200');
    expect(document.body.textContent).toContain('NEW');
    expect(loadStats).toHaveBeenCalledWith(CLASSIC_MODE.id);
  });

  test('selects a mode separately from starting it', () => {
    const onSelectMode = vi.fn();
    const home = createHome({ onSelectMode });
    home.open();

    const cards = document.querySelectorAll<HTMLButtonElement>('.home-mode-card');
    const gravityCard = cards[1]!;
    gravityCard.click();

    expect(onSelectMode).not.toHaveBeenCalled();
    expect(gravityCard.getAttribute('aria-checked')).toBe('false');
    const selectedCard = document.querySelector<HTMLButtonElement>('[data-mode-id="gravity"]')!;
    expect(selectedCard.getAttribute('aria-checked')).toBe('true');
    expect(document.querySelector('.home-mode-detail')?.textContent).toContain(GRAVITY_MODE.tagline);

    const playButton = document.querySelector<HTMLButtonElement>('.home-mode-action--play')!;
    playButton.click();

    expect(onSelectMode).toHaveBeenCalledOnce();
    expect(onSelectMode).toHaveBeenCalledWith(GRAVITY_MODE);
    expect(playButton.textContent).toBe('PLAY');
  });

  test('supports roving keyboard navigation across mode choices', () => {
    const home = createHome();
    home.open();

    const classicCard = document.querySelector<HTMLButtonElement>('[data-mode-id="classic"]')!;
    classicCard.focus();
    classicCard.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));

    const gravityCard = document.querySelector<HTMLButtonElement>('[data-mode-id="gravity"]')!;
    expect(gravityCard.getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(gravityCard);
    expect(classicCard.isConnected).toBe(false);
  });

  test('shows the appropriate secondary record for chain and Stack modes', () => {
    const home = createHome({
      loadStats: modeId => {
        if (modeId === STACK_MODE.id) {
          return stats({ highScore: 810, longestStreak: 9, gamesPlayed: 1, totalScore: 810, averageScore: 810 });
        }
        if (modeId === CLASSIC_MODE.id) {
          return stats({ highScore: 1200, longestStreak: 4, gamesPlayed: 2, totalScore: 1800, averageScore: 900 });
        }
        return stats();
      },
    });

    home.open();
    let details = document.querySelector('.home-mode-detail');
    expect(details?.textContent).toContain('HIGH SCORE1200');
    expect(details?.textContent).toContain('BEST CHAIN4 WAVES');

    document.querySelector<HTMLButtonElement>('[data-mode-id="stack"]')!.click();

    details = document.querySelector('.home-mode-detail');
    expect(details?.textContent).toContain('HIGH SCORE810');
    expect(details?.textContent).toContain('One drop, one cascade');
    expect(details?.textContent).toContain('BEST TURN9 CLEARED');
    expect(details?.textContent).not.toContain('BEST CHAIN');
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

  test('isolates the active home and game-menu layers from background UI', () => {
    const background = document.createElement('main');
    const mount = document.createElement('div');
    const peerOverlay = document.createElement('aside');
    peerOverlay.inert = true;
    mount.append(peerOverlay);
    document.body.append(background, mount);
    const home = createHome({ mount, modalBackground: [background] });
    const overlay = mount.querySelector<HTMLElement>('.home-screen')!;
    const menuButton = mount.querySelector<HTMLElement>('.home-back-button')!;

    home.open();
    expect(overlay.getAttribute('aria-hidden')).toBe('false');
    expect(background.inert).toBe(true);
    expect(peerOverlay.inert).toBe(true);

    home.close();
    expect(overlay.getAttribute('aria-hidden')).toBe('true');
    expect(menuButton.getAttribute('aria-hidden')).toBe('false');
    expect(background.inert).toBe(false);
    expect(peerOverlay.inert).toBe(true);

    const onResume = vi.fn(() => home.closeGameMenu());
    home.onRequestResume = onResume;
    menuButton.focus();
    home.openGameMenu();
    const menu = mount.querySelector<HTMLElement>('.game-menu')!;
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(onResume).toHaveBeenCalledOnce();
    expect(background.inert).toBe(false);
    expect(overlay.inert).toBe(false);
    expect(document.activeElement).not.toBe(menuButton);
  });

  test('clicking the play button hands focus back so game keys stay alive', () => {
    const home = createHome();
    home.open();

    const playButton = document.querySelector<HTMLButtonElement>('.home-mode-action--play')!;
    playButton.focus();
    playButton.click();

    expect(document.activeElement).not.toBe(playButton);
  });

  test('mode choices and shared actions are separate buttons', () => {
    createHome();

    for (const card of document.querySelectorAll<HTMLElement>('.home-mode-card')) {
      expect(card.tagName).toBe('BUTTON');
      expect(card.getAttribute('role')).toBe('radio');
      expect(card.querySelector('button')).toBeNull();
    }
    expect(document.querySelector('.home-mode-detail')?.querySelectorAll('button')).toHaveLength(2);
  });

  test('disables play while cloud saves are loading without disabling tutorials', () => {
    const home = createHome();
    home.setSaveLoading(true);

    const play = document.querySelector<HTMLButtonElement>('.home-mode-action--play')!;
    const tutorial = Array.from(document.querySelectorAll<HTMLButtonElement>('.home-mode-action'))
      .find(button => button.textContent === 'TUTORIAL')!;
    expect(document.querySelector('.home-saved-game')).toBeNull();
    expect(play.disabled).toBe(true);
    expect(play.textContent).toBe('CHECKING SAVES…');
    expect(tutorial.disabled).toBe(false);
    expect(document.querySelector<HTMLButtonElement>('.home-mode-card')?.disabled).toBe(false);

    home.setSaveLoading(false);
    const enabledPlay = document.querySelector<HTMLButtonElement>('.home-mode-action--play')!;
    expect(enabledPlay.disabled).toBe(false);
    expect(enabledPlay.textContent).toBe('PLAY');
  });
});
