import type { GameModeConfig } from '../game/modes/mode.js';
import type { GameStats } from '../game/stats.js';
import type { AccountStatsState } from '../platform/account-stats-store.js';

// DOM overlay for mode selection, following the same plain-DOM construction
// pattern as DebugPanel (document.createElement, no framework). Covers the
// canvas entirely while open; the canvas's own pointer listeners never fire
// underneath it because the overlay sits on top with position: fixed.
export class HomeScreen {
  private readonly overlay: HTMLElement;
  private readonly authBar: HTMLElement;
  private readonly cardsContainer: HTMLElement;
  private readonly backButton: HTMLButtonElement;

  // Set by Game after construction, avoiding a constructor-time forward
  // reference to a not-yet-defined method.
  onRequestMenu?: () => void;

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

    this.backButton = document.createElement('button');
    this.backButton.type = 'button';
    this.backButton.className = 'home-back-button';
    this.backButton.textContent = 'MENU';
    this.backButton.addEventListener('click', () => this.onRequestMenu?.());
    document.body.append(this.backButton);

    this.renderCards();
    this.renderAuth();
  }

  open(): void {
    this.renderCards(); // refresh per-mode high scores every time the menu opens
    this.overlay.classList.add('home-screen--open');
    this.backButton.classList.remove('home-back-button--visible');
  }

  close(): void {
    this.overlay.classList.remove('home-screen--open');
    this.backButton.classList.add('home-back-button--visible');
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

    this.authBar.append(status, button);
  }

  private renderCards(): void {
    this.cardsContainer.replaceChildren();

    for (const mode of this.modes) {
      const stats = this.loadStats(mode.id);
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'home-mode-card';

      const name = document.createElement('strong');
      name.textContent = mode.name;

      const tagline = document.createElement('p');
      tagline.textContent = mode.tagline;

      const best = document.createElement('span');
      best.className = 'home-mode-best';
      best.textContent = stats.gamesPlayed > 0 ? `Best ${stats.highScore}` : 'Not played yet';

      card.append(name, tagline, best);
      card.addEventListener('click', () => this.onSelectMode(mode));
      this.cardsContainer.append(card);
    }

    // Cosmetic only — proves the list layout scales past one entry without
    // inventing a second mode's mechanics.
    const comingSoon = document.createElement('div');
    comingSoon.className = 'home-mode-card home-mode-card--disabled';
    comingSoon.textContent = 'More modes coming soon';
    this.cardsContainer.append(comingSoon);
  }
}
