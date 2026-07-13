import type { GameModeConfig } from '../game/modes/mode.js';
import type { GameStats } from '../game/stats.js';
import type { AccountStatsState } from '../platform/account-stats-store.js';
import { blurOnClick } from './dom-utils.js';
import { ModalController } from './modal-controller.js';

export interface SavedGameSummary {
  modeName: string;
  score: number;
}

// DOM overlay for mode selection. It mounts into the shared UI layer and
// covers the canvas entirely while open.
export class HomeScreen {
  private readonly overlay: HTMLElement;
  private readonly authBar: HTMLElement;
  private readonly cardsContainer: HTMLElement;
  private readonly savedGameAction: HTMLElement;
  private readonly savedGameContext: HTMLElement;
  private readonly menuButton: HTMLButtonElement;
  private readonly gameMenu: HTMLElement;
  private readonly soundButton: HTMLButtonElement;
  private readonly gameMenuModal: ModalController;
  private readonly homePriorInert = new Map<HTMLElement, boolean>();

  // Set by Game after construction, avoiding a constructor-time forward
  // reference to a not-yet-defined method.
  onRequestGameMenu?: () => void;
  onRequestResume?: () => void;
  onRequestRestart?: () => void;
  onRequestHome?: () => void;
  onRequestToggleSound?: () => void;
  onRequestTutorial?: (mode: GameModeConfig) => void;
  onRequestResumeSavedGame?: () => void;

  constructor(
    private readonly modes: readonly GameModeConfig[],
    private readonly onSelectMode: (mode: GameModeConfig) => void,
    private readonly loadStats: (modeId: string) => GameStats,
    private readonly getAuthState: () => AccountStatsState,
    private readonly onLogin: () => void,
    private readonly onLogout: () => void,
    private readonly mount: HTMLElement = document.body,
    private readonly modalBackground: readonly HTMLElement[] = [],
  ) {
    this.overlay = document.createElement('div');
    this.overlay.className = 'home-screen';
    this.overlay.setAttribute('aria-label', 'Disco home screen');
    this.overlay.setAttribute('aria-hidden', 'true');

    const title = document.createElement('h1');
    title.className = 'home-title';
    title.textContent = 'DISCO';

    this.authBar = document.createElement('div');
    this.authBar.className = 'home-auth';

    this.cardsContainer = document.createElement('div');
    this.cardsContainer.className = 'home-mode-list';

    this.savedGameAction = document.createElement('section');
    this.savedGameAction.className = 'home-saved-game';
    this.savedGameAction.hidden = true;
    this.savedGameAction.setAttribute('aria-label', 'Saved game');

    const savedGameButton = document.createElement('button');
    savedGameButton.type = 'button';
    savedGameButton.className = 'home-saved-game-button';
    savedGameButton.textContent = 'RESUME SAVED GAME';
    savedGameButton.addEventListener('click', () => this.onRequestResumeSavedGame?.());
    blurOnClick(savedGameButton);

    this.savedGameContext = document.createElement('span');
    this.savedGameContext.className = 'home-saved-game-context';
    this.savedGameAction.append(savedGameButton, this.savedGameContext);

    this.overlay.append(title, this.authBar, this.savedGameAction, this.cardsContainer);
    this.mount.append(this.overlay);

    this.menuButton = document.createElement('button');
    this.menuButton.type = 'button';
    this.menuButton.className = 'home-back-button';
    this.menuButton.textContent = 'MENU';
    this.menuButton.setAttribute('aria-hidden', 'true');
    this.menuButton.addEventListener('click', () => this.onRequestGameMenu?.());
    blurOnClick(this.menuButton);

    this.gameMenu = document.createElement('div');
    this.gameMenu.className = 'game-menu';
    this.gameMenu.setAttribute('aria-label', 'Game menu');
    this.gameMenu.setAttribute('role', 'dialog');
    this.gameMenu.setAttribute('aria-modal', 'true');

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
    this.mount.append(this.menuButton, this.gameMenu);
    this.gameMenuModal = new ModalController(this.gameMenu, {
      openClass: 'game-menu--open',
      initialFocus: () => resumeButton,
      inertTargets: this.modalBackground,
      onEscape: () => this.onRequestResume?.(),
      restoreFocus: false,
    });

    this.renderCards();
    this.renderAuth();
  }

  open(): void {
    this.renderCards(); // refresh per-mode high scores every time the menu opens
    this.closeGameMenu();
    this.overlay.classList.add('home-screen--open');
    this.overlay.setAttribute('aria-hidden', 'false');
    this.menuButton.classList.remove('home-back-button--visible');
    this.menuButton.setAttribute('aria-hidden', 'true');
    this.setBackgroundInert(true);
  }

  close(): void {
    this.overlay.classList.remove('home-screen--open');
    this.overlay.setAttribute('aria-hidden', 'true');
    this.menuButton.classList.add('home-back-button--visible');
    this.menuButton.setAttribute('aria-hidden', 'false');
    this.setBackgroundInert(false);
  }

  openGameMenu(): void {
    this.gameMenuModal.open();
    this.menuButton.classList.remove('home-back-button--visible');
    this.menuButton.setAttribute('aria-hidden', 'true');
  }

  closeGameMenu(): void {
    this.gameMenuModal.close();
    if (!this.overlay.classList.contains('home-screen--open')) {
      this.menuButton.classList.add('home-back-button--visible');
      this.menuButton.setAttribute('aria-hidden', 'false');
    }
  }

  isGameMenuOpen(): boolean {
    return this.gameMenuModal.isOpen();
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

  setSavedGame(summary: SavedGameSummary | null): void {
    this.savedGameAction.hidden = summary === null;
    this.savedGameContext.textContent = summary
      ? `${summary.modeName} · Score ${summary.score.toLocaleString('en-US')}`
      : '';
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

  private setBackgroundInert(inert: boolean): void {
    if (inert) {
      const siblings = Array.from(this.mount.children)
        .filter((element): element is HTMLElement => element instanceof HTMLElement && element !== this.overlay);
      for (const element of new Set([...this.modalBackground, ...siblings])) {
        if (!this.homePriorInert.has(element)) this.homePriorInert.set(element, element.inert);
        element.inert = true;
      }
      return;
    }
    for (const [element, wasInert] of this.homePriorInert) element.inert = wasInert;
    this.homePriorInert.clear();
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
