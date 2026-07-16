// @vitest-environment happy-dom

import { beforeEach, describe, expect, test, vi } from 'vitest';
import { CLASSIC_MODE, GRAVITY_MODE, PARADOX_MODE, STACK_MODE } from '../../game/modes/index.js';
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
  modes?: readonly GameModeConfig[];
  authState?: AccountStatsState;
  loadStats?: (modeId: string) => GameStats;
  onSelectMode?: (mode: GameModeConfig) => void;
  onLogin?: () => void;
  onLogout?: () => void;
  mount?: HTMLElement;
  modalBackground?: readonly HTMLElement[];
} = {}): HomeScreen {
  return new HomeScreen(
    options.modes ?? [CLASSIC_MODE, GRAVITY_MODE, STACK_MODE],
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

  test('renders subdued project links and opens report/debug from the footer', () => {
    const home = createHome();
    const onRequestDebug = vi.fn();
    home.onRequestDebug = onRequestDebug;

    const footer = document.querySelector<HTMLElement>('.home-footer')!;
    const github = footer.querySelector<HTMLAnchorElement>('[href="https://github.com/tjreigh/disco"]')!;
    const report = footer.querySelector<HTMLButtonElement>('.home-footer__button')!;

    expect(footer.textContent).toContain(`© ${new Date().getFullYear()} Trevor Reigh`);
    expect(document.querySelector('.home-screen')?.contains(footer)).toBe(false);
    expect(github.textContent).toBe('GITHUB');
    expect(github.rel).toContain('noreferrer');
    report.click();
    expect(onRequestDebug).toHaveBeenCalledOnce();
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
    const onRequestDebug = vi.fn();
    home.onRequestResume = onResume;
    home.onRequestRestart = onRestart;
    home.onRequestHome = onHome;
    home.onRequestToggleSound = onToggleSound;
    home.onRequestDebug = onRequestDebug;

    home.open();
    home.close();
    expect(document.querySelector('.home-back-button--visible')).not.toBeNull();

    home.openGameMenu();
    expect(home.isGameMenuOpen()).toBe(true);
    expect(document.querySelector('.game-menu--open')).not.toBeNull();
    expect(document.querySelector('.home-footer')?.classList).toContain('home-footer--hidden');
    const closeMenuButton = document.querySelector<HTMLButtonElement>('.game-menu-close')!;
    const resumeButton = Array.from(document.querySelectorAll<HTMLButtonElement>('.game-menu-button'))
      .find(button => button.textContent === 'RESUME')!;
    const restartButton = Array.from(document.querySelectorAll<HTMLButtonElement>('.game-menu-button'))
      .find(button => button.textContent === 'RESTART')!;
    expect(closeMenuButton.getAttribute('aria-label')).toBe('Resume game');
    expect(resumeButton.classList).toContain('game-menu-button--primary');
    expect(document.querySelector('.game-menu-note')?.textContent).toBe('Progress saves automatically.');

    for (const label of ['RESUME', 'SAVE & EXIT', 'SOUND ON', 'REPORT / DEBUG']) {
      Array.from(document.querySelectorAll<HTMLButtonElement>('.game-menu-button'))
        .find(button => button.textContent === label)!
        .click();
    }
    closeMenuButton.click();

    restartButton.click();
    const restartDialog = document.querySelector<HTMLElement>('.restart-confirmation')!;
    const cancelRestart = Array.from(restartDialog.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent === 'CANCEL')!;
    const confirmRestart = Array.from(restartDialog.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent === 'RESTART GAME')!;
    expect(restartDialog.classList).toContain('restart-confirmation--open');
    expect(restartDialog.getAttribute('role')).toBe('alertdialog');
    expect(restartDialog.textContent).toContain('Your current run will be replaced.');
    expect(document.activeElement).toBe(cancelRestart);
    expect(confirmRestart.classList).toContain('restart-confirmation__button--danger');
    expect(onRestart).not.toHaveBeenCalled();

    cancelRestart.click();
    expect(restartDialog.classList).not.toContain('restart-confirmation--open');
    restartButton.click();
    confirmRestart.click();

    expect(onResume).toHaveBeenCalledTimes(2);
    expect(onRestart).toHaveBeenCalledTimes(1);
    expect(onHome).toHaveBeenCalledTimes(1);
    expect(onToggleSound).toHaveBeenCalledTimes(1);
    expect(onRequestDebug).toHaveBeenCalledTimes(1);

    home.closeGameMenu();
    expect(home.isGameMenuOpen()).toBe(false);
    expect(document.querySelector('.home-footer')?.classList).not.toContain('home-footer--hidden');
  });

  test('uses a labelled three-line menu icon while retaining the desktop label', () => {
    const home = createHome();
    home.close();

    const menu = document.querySelector<HTMLButtonElement>('.home-back-button')!;
    expect(menu.getAttribute('aria-label')).toBe('Game menu');
    expect(menu.querySelectorAll('.home-back-button__icon i')).toHaveLength(3);
    expect(menu.querySelector('.home-back-button__label')?.textContent).toBe('MENU');
  });

  test('shows a busy state and prevents competing menu actions while saving and exiting', () => {
    const home = createHome();
    home.close();
    home.openGameMenu();

    home.setSaveExitPending(true);

    const menu = document.querySelector<HTMLElement>('.game-menu')!;
    expect(menu.getAttribute('aria-busy')).toBe('true');
    expect(menu.textContent).toContain('SAVING…');
    expect(Array.from(menu.querySelectorAll<HTMLButtonElement>('button')).every(button => button.disabled)).toBe(true);

    home.setSaveExitPending(false);
    expect(menu.getAttribute('aria-busy')).toBe('false');
    expect(menu.textContent).toContain('SAVE & EXIT');
    expect(Array.from(menu.querySelectorAll<HTMLButtonElement>('button')).every(button => !button.disabled)).toBe(true);
  });

  test('isolates the active home and game-menu layers from background UI', () => {
    const background = document.createElement('main');
    const mount = document.createElement('div');
    const peerOverlay = document.createElement('aside');
    const auxiliaryOverlay = document.createElement('aside');
    peerOverlay.inert = true;
    auxiliaryOverlay.dataset.uiAboveHome = 'true';
    mount.append(peerOverlay, auxiliaryOverlay);
    document.body.append(background, mount);
    const home = createHome({ mount, modalBackground: [background] });
    const overlay = mount.querySelector<HTMLElement>('.home-screen')!;
    const menuButton = mount.querySelector<HTMLElement>('.home-back-button')!;

    home.open();
    expect(overlay.getAttribute('aria-hidden')).toBe('false');
    expect(background.inert).toBe(true);
    expect(peerOverlay.inert).toBe(true);
    expect(auxiliaryOverlay.inert).toBe(false);

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

  test('renders an empty-state message instead of a card when no modes are configured', () => {
    const home = createHome({ modes: [] });
    home.open();

    expect(document.querySelectorAll('.home-mode-card')).toHaveLength(0);
    const empty = document.querySelector('.home-mode-empty');
    expect(empty?.textContent).toBe('No modes are available yet.');
    expect(document.querySelector('.home-mode-detail')?.contains(empty)).toBe(true);
  });

  test('omits the tutorial button for a mode with hasTutorial: false', () => {
    const home = createHome({ modes: [CLASSIC_MODE, PARADOX_MODE] });
    home.open();

    expect(PARADOX_MODE.hasTutorial).toBe(false);
    document.querySelector<HTMLButtonElement>('[data-mode-id="paradox"]')!.click();

    const detailButtons = Array.from(document.querySelector('.home-mode-detail')!.querySelectorAll<HTMLButtonElement>('button'));
    expect(detailButtons).toHaveLength(1);
    expect(detailButtons.some(button => button.textContent === 'TUTORIAL')).toBe(false);
    expect(detailButtons.some(button => button.textContent === 'PLAY')).toBe(true);
  });

  test('supports keyboard navigation with ArrowLeft, Home, and End', () => {
    const home = createHome();
    home.open();

    const classicCard = document.querySelector<HTMLButtonElement>('[data-mode-id="classic"]')!;
    classicCard.focus();
    classicCard.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));

    // Wrapping left from the first card lands on the last one (Stack).
    let stackCard = document.querySelector<HTMLButtonElement>('[data-mode-id="stack"]')!;
    expect(stackCard.getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(stackCard);
    expect(classicCard.isConnected).toBe(false);

    stackCard.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    const homeSelectedCard = document.querySelector<HTMLButtonElement>('[data-mode-id="classic"]')!;
    expect(homeSelectedCard.getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(homeSelectedCard);
    expect(stackCard.isConnected).toBe(false);

    homeSelectedCard.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    stackCard = document.querySelector<HTMLButtonElement>('[data-mode-id="stack"]')!;
    expect(stackCard.getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(stackCard);
    expect(homeSelectedCard.isConnected).toBe(false);
  });
});
