import type { GameModeConfig } from '../game/modes/mode.js';
import type { GameStats } from '../game/stats.js';
import type { AccountStatsState } from '../platform/account-stats-store.js';
import { blurOnClick } from './dom-utils.js';

// DOM overlay for mode selection, following the same plain-DOM construction
// pattern as DebugPanel (document.createElement, no framework). Covers the
// canvas entirely while open; the canvas's own pointer listeners never fire
// underneath it because the overlay sits on top with position: fixed.
export class HomeScreen {
  private readonly overlay: HTMLElement;
  private readonly authBar: HTMLElement;
  private readonly cardsContainer: HTMLElement;
  private readonly menuButton: HTMLButtonElement;
  private readonly gameMenu: HTMLElement;
  private readonly soundButton: HTMLButtonElement;
  private gameMenuOpen = false;

  // Set by Game after construction, avoiding a constructor-time forward
  // reference to a not-yet-defined method.
  onRequestGameMenu?: () => void;
  onRequestResume?: () => void;
  onRequestRestart?: () => void;
  onRequestHome?: () => void;
  onRequestToggleSound?: () => void;
  onRequestTutorial?: (mode: GameModeConfig) => void;

  constructor(
    private readonly modes: readonly GameModeConfig[],
    private readonly onSelectMode: (mode: GameModeConfig) => void,
    private readonly loadStats: (modeId: string) => GameStats,
    private readonly getAuthState: () => AccountStatsState,
    private readonly onLogin: () => void,
    private readonly onLogout: () => void,
  ) {
    this.overlay = document.createElement('div');
    this.overlay.className = 'home-screen';
    this.overlay.setAttribute('aria-label', 'Disco home screen');

    const title = document.createElement('h1');
    title.className = 'home-title';
    title.textContent = 'DISCO';

    this.authBar = document.createElement('div');
    this.authBar.className = 'home-auth';

    this.cardsContainer = document.createElement('div');
    this.cardsContainer.className = 'home-mode-list';

    this.overlay.append(title, this.authBar, this.cardsContainer);
    document.body.append(this.overlay);

    this.menuButton = document.createElement('button');
    this.menuButton.type = 'button';
    this.menuButton.className = 'home-back-button';
    this.menuButton.textContent = 'MENU';
    this.menuButton.addEventListener('click', () => this.onRequestGameMenu?.());
    blurOnClick(this.menuButton);

    this.gameMenu = document.createElement('div');
    this.gameMenu.className = 'game-menu';
    this.gameMenu.setAttribute('aria-label', 'Game menu');

    const panel = document.createElement('div');
    panel.className = 'game-menu-panel';

    const menuTitle = document.createElement('h2');
    menuTitle.textContent = 'MENU';

    const resumeButton = this.createGameMenuButton('RESUME', () => this.onRequestResume?.());
    const restartButton = this.createGameMenuButton('RESTART', () => this.onRequestRestart?.());
    this.soundButton = this.createGameMenuButton('SOUND ON', () => this.onRequestToggleSound?.());
    const homeButton = this.createGameMenuButton('HOME', () => this.onRequestHome?.());

    panel.append(menuTitle, resumeButton, restartButton, this.soundButton, homeButton);
    this.gameMenu.append(panel);
    document.body.append(this.menuButton, this.gameMenu);

    this.renderCards();
    this.renderAuth();
  }

  open(): void {
    this.renderCards(); // refresh per-mode high scores every time the menu opens
    this.closeGameMenu();
    this.overlay.classList.add('home-screen--open');
    this.menuButton.classList.remove('home-back-button--visible');
  }

  close(): void {
    this.overlay.classList.remove('home-screen--open');
    this.menuButton.classList.add('home-back-button--visible');
  }

  openGameMenu(): void {
    this.gameMenuOpen = true;
    this.gameMenu.classList.add('game-menu--open');
    this.menuButton.classList.remove('home-back-button--visible');
  }

  closeGameMenu(): void {
    this.gameMenuOpen = false;
    this.gameMenu.classList.remove('game-menu--open');
    if (!this.overlay.classList.contains('home-screen--open')) {
      this.menuButton.classList.add('home-back-button--visible');
    }
  }

  isGameMenuOpen(): boolean {
    return this.gameMenuOpen;
  }

  setSoundEnabled(enabled: boolean): void {
    this.soundButton.textContent = enabled ? 'SOUND ON' : 'SOUND OFF';
  }

  refreshStats(): void {
    this.renderCards();
  }

  refreshAuth(): void {
    this.renderAuth();
  }

  private renderAuth(): void {
    this.authBar.replaceChildren();
    const auth = this.getAuthState();

    const status = document.createElement('span');
    status.className = 'home-auth-status';
    if (auth.loading) {
      status.textContent = 'Checking account...';
    } else if (!auth.apiAvailable) {
      status.textContent = 'Playing offline';
    } else if (auth.account) {
      status.textContent = auth.account.displayName ? `Signed in as ${auth.account.displayName}` : 'Signed in';
    } else {
      status.textContent = 'Guest stats stay on this device';
    }

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'home-auth-button';
    button.textContent = auth.account ? 'SIGN OUT' : 'SIGN IN';
    button.disabled = auth.loading;
    button.addEventListener('click', () => {
      if (auth.account) {
        this.onLogout();
      } else {
        this.onLogin();
      }
    });
    blurOnClick(button);

    this.authBar.append(status, button);
  }

  private createGameMenuButton(label: string, onClick: () => void): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'game-menu-button';
    button.textContent = label;
    button.addEventListener('click', onClick);
    blurOnClick(button);
    return button;
  }

  private renderCards(): void {
    this.cardsContainer.replaceChildren();

    for (const mode of this.modes) {
      const stats = this.loadStats(mode.id);
      const card = document.createElement('div');
      card.className = 'home-mode-card';
      card.tabIndex = 0;
      card.role = 'button';
      card.addEventListener('click', event => {
        if (event.target instanceof HTMLElement && event.target.closest('.home-mode-action')) return;
        this.onSelectMode(mode);
      });
      card.addEventListener('keydown', event => {
        if (event.target !== card) return;
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        this.onSelectMode(mode);
        card.blur();
      });

      const name = document.createElement('strong');
      name.textContent = mode.name;

      const tagline = document.createElement('p');
      tagline.textContent = mode.tagline;

      const best = document.createElement('span');
      best.className = 'home-mode-best';
      best.textContent = stats.gamesPlayed > 0 ? `Best ${stats.highScore}` : 'Not played yet';

      const record = document.createElement('span');
      record.className = 'home-mode-record';
      if (mode.id === 'stack' && stats.gamesPlayed > 0) {
        record.textContent = `Best stack ${stats.longestStreak}`;
      } else {
        record.hidden = true;
      }

      const actions = document.createElement('div');
      actions.className = 'home-mode-actions';

      const playButton = document.createElement('button');
      playButton.type = 'button';
      playButton.className = 'home-mode-action home-mode-action--play';
      playButton.textContent = 'PLAY';
      playButton.addEventListener('click', () => this.onSelectMode(mode));
      blurOnClick(playButton);

      actions.append(playButton);
      if (mode.hasTutorial !== false) {
        const tutorialButton = document.createElement('button');
        tutorialButton.type = 'button';
        tutorialButton.className = 'home-mode-action';
        tutorialButton.textContent = 'TUTORIAL';
        tutorialButton.addEventListener('click', event => {
          event.stopPropagation();
          this.onRequestTutorial?.(mode);
        });
        blurOnClick(tutorialButton);
        actions.append(tutorialButton);
      }
      card.append(name, tagline, best, record, actions);
      this.cardsContainer.append(card);
    }
  }
}
