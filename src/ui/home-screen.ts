import type { SoloModeDefinition } from '../game/modes/mode.js';
import type { GameStats } from '../game/stats.js';
import type { AccountStatsState } from '../platform/account-stats-store.js';
import { blurOnClick, cloneTemplate, mustQuery } from './dom-utils.js';
import { ModalController } from './modal-controller.js';

// DOM overlay for mode selection. It mounts into the shared UI layer and
// covers the canvas entirely while open.
export class HomeScreen {
  private readonly overlay: HTMLElement;
  private readonly authBar: HTMLElement;
  private readonly cardsContainer: HTMLElement;
  private readonly modeDetails: HTMLElement;
  private readonly footer: HTMLElement;
  private readonly menuButton: HTMLButtonElement;
  private readonly gameMenu: HTMLElement;
  private readonly restartDialog: HTMLElement;
  private readonly soundButton: HTMLButtonElement;
  private readonly saveExitButton: HTMLButtonElement;
  private readonly gameMenuModal: ModalController;
  private readonly restartDialogModal: ModalController;
  private readonly homePriorInert = new Map<HTMLElement, boolean>();
  private saveLoading = false;
  private selectedModeId: string;

  // Set by Game after construction, avoiding a constructor-time forward
  // reference to a not-yet-defined method.
  onRequestGameMenu?: () => void;
  onRequestResume?: () => void;
  onRequestRestart?: () => void;
  onRequestHome?: () => void;
  onRequestToggleSound?: () => void;
  onRequestDebug?: () => void;
  onRequestTutorial?: (mode: SoloModeDefinition) => void;
  onRequestCreateMultiplayer?: () => void;
  onRequestJoinMultiplayer?: (roomId: string) => void;

  constructor(
    private readonly modes: readonly SoloModeDefinition[],
    private readonly onSelectMode: (mode: SoloModeDefinition) => void,
    private readonly loadStats: (modeId: string) => GameStats,
    private readonly getAuthState: () => AccountStatsState,
    private readonly onLogin: () => void,
    private readonly onLogout: () => void,
    private readonly mount: HTMLElement = document.body,
    private readonly modalBackground: readonly HTMLElement[] = [],
  ) {
    const mainFragment = cloneTemplate('tpl-home-screen-main');
    this.overlay = mustQuery(mainFragment, '.home-screen');
    this.selectedModeId = this.modes[0]?.id ?? '';
    this.authBar = mustQuery(mainFragment, '.home-auth');
    this.cardsContainer = mustQuery(mainFragment, '.home-mode-list');
    this.modeDetails = mustQuery(mainFragment, '.home-mode-detail');
    this.footer = mustQuery(mainFragment, '.home-footer');

    const copyright = mustQuery<HTMLElement>(mainFragment, '.home-footer__copyright');
    copyright.textContent = `© ${new Date().getFullYear()} Trevor Reigh`;

    const report = mustQuery<HTMLButtonElement>(mainFragment, '.home-footer__button');
    report.addEventListener('click', () => this.onRequestDebug?.());
    blurOnClick(report);

    const createRoomButton = mustQuery<HTMLButtonElement>(mainFragment, '[data-multiplayer-action="create"]');
    createRoomButton.addEventListener('click', () => this.onRequestCreateMultiplayer?.());
    blurOnClick(createRoomButton);

    const roomInput = mustQuery<HTMLInputElement>(mainFragment, '.home-multiplayer__join input');
    const joinButton = mustQuery<HTMLButtonElement>(mainFragment, '[data-multiplayer-action="join"]');
    const join = (): void => {
      const roomId = roomInput.value.trim().toUpperCase();
      if (!roomId) return;
      this.onRequestJoinMultiplayer?.(roomId);
    };
    joinButton.addEventListener('click', join);
    roomInput.addEventListener('keydown', event => {
      if (event.key === 'Enter') join();
    });
    blurOnClick(joinButton);

    this.mount.append(mainFragment);

    const menuFragment = cloneTemplate('tpl-home-screen-game-menu');
    this.menuButton = mustQuery(menuFragment, '.home-back-button');
    this.gameMenu = mustQuery(menuFragment, '.game-menu');
    this.restartDialog = mustQuery(menuFragment, '.restart-confirmation');

    this.menuButton.addEventListener('click', () => this.onRequestGameMenu?.());
    blurOnClick(this.menuButton);

    const closeMenuButton = mustQuery<HTMLButtonElement>(menuFragment, '.game-menu-close');
    closeMenuButton.addEventListener('click', () => this.onRequestResume?.());
    blurOnClick(closeMenuButton);

    const resumeButton = mustQuery<HTMLButtonElement>(menuFragment, '.game-menu-button--primary');
    resumeButton.addEventListener('click', () => this.onRequestResume?.());
    blurOnClick(resumeButton);

    const restartButton = mustQuery<HTMLButtonElement>(menuFragment, '[data-game-menu-action="restart"]');
    restartButton.addEventListener('click', () => this.restartDialogModal.open());
    blurOnClick(restartButton);

    this.soundButton = mustQuery(menuFragment, '[data-game-menu-action="sound"]');
    this.soundButton.addEventListener('click', () => this.onRequestToggleSound?.());
    blurOnClick(this.soundButton);

    this.saveExitButton = mustQuery(menuFragment, '[data-game-menu-action="save-exit"]');
    this.saveExitButton.addEventListener('click', () => this.onRequestHome?.());
    blurOnClick(this.saveExitButton);

    const debugButton = mustQuery<HTMLButtonElement>(menuFragment, '.game-menu-button--debug');
    debugButton.addEventListener('click', () => this.onRequestDebug?.());
    blurOnClick(debugButton);

    const cancelRestartButton = mustQuery<HTMLButtonElement>(menuFragment, '[data-restart-action="cancel"]');
    const confirmRestartButton = mustQuery<HTMLButtonElement>(menuFragment, '.restart-confirmation__button--danger');

    this.mount.append(menuFragment);
    this.gameMenuModal = new ModalController(this.gameMenu, {
      openClass: 'game-menu--open',
      initialFocus: () => resumeButton,
      inertTargets: this.modalBackground,
      onEscape: () => this.onRequestResume?.(),
      restoreFocus: false,
    });
    this.restartDialogModal = new ModalController(this.restartDialog, {
      openClass: 'restart-confirmation--open',
      initialFocus: () => cancelRestartButton,
      inertTargets: this.modalBackground,
      onEscape: () => this.restartDialogModal.close(),
    });
    cancelRestartButton.addEventListener('click', () => this.restartDialogModal.close());
    confirmRestartButton.addEventListener('click', () => {
      this.restartDialogModal.close();
      this.onRequestRestart?.();
    });
    blurOnClick(cancelRestartButton);
    blurOnClick(confirmRestartButton);

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
    this.footer.classList.add('home-footer--hidden');
    this.menuButton.classList.remove('home-back-button--visible');
    this.menuButton.setAttribute('aria-hidden', 'true');
  }

  closeGameMenu(): void {
    this.restartDialogModal.close();
    this.gameMenuModal.close();
    this.footer.classList.remove('home-footer--hidden');
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

  setSaveExitPending(pending: boolean): void {
    this.gameMenu.setAttribute('aria-busy', String(pending));
    this.saveExitButton.textContent = pending ? 'SAVING…' : 'SAVE & EXIT';
    for (const button of this.gameMenu.querySelectorAll<HTMLButtonElement>('button')) {
      button.disabled = pending;
    }
  }

  refreshStats(): void {
    this.renderCards();
  }

  refreshAuth(): void {
    this.renderAuth();
  }

  setSaveLoading(loading: boolean): void {
    if (this.saveLoading === loading) return;
    this.saveLoading = loading;
    this.renderCards();
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

  private setBackgroundInert(inert: boolean): void {
    if (inert) {
      const siblings = Array.from(this.mount.children)
        .filter((element): element is HTMLElement => element instanceof HTMLElement
          && element !== this.overlay
          && element.dataset.uiAboveHome !== 'true');
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
    this.modeDetails.replaceChildren();

    const selectedMode = this.modes.find(mode => mode.id === this.selectedModeId) ?? this.modes[0];
    if (!selectedMode) {
      const empty = document.createElement('p');
      empty.className = 'home-mode-empty';
      empty.textContent = 'No modes are available yet.';
      this.modeDetails.append(empty);
      return;
    }
    this.selectedModeId = selectedMode.id;

    this.modes.forEach((mode, index) => {
      const stats = this.loadStats(mode.id);
      const selected = mode.id === this.selectedModeId;
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'home-mode-card';
      card.classList.toggle('home-mode-card--selected', selected);
      card.id = `home-mode-${mode.id}`;
      card.dataset.modeId = mode.id;
      card.setAttribute('role', 'radio');
      card.setAttribute('aria-checked', String(selected));
      card.setAttribute('aria-controls', this.modeDetails.id);
      card.tabIndex = selected ? 0 : -1;
      card.addEventListener('click', event => {
        this.selectMode(mode.id, event.detail === 0);
      });
      card.addEventListener('keydown', event => {
        let nextIndex: number | undefined;
        if (event.key === 'ArrowRight' || event.key === 'ArrowDown') nextIndex = (index + 1) % this.modes.length;
        if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') nextIndex = (index - 1 + this.modes.length) % this.modes.length;
        if (event.key === 'Home') nextIndex = 0;
        if (event.key === 'End') nextIndex = this.modes.length - 1;
        if (nextIndex === undefined) return;
        event.preventDefault();
        this.selectMode(this.modes[nextIndex]!.id, true);
      });

      const name = document.createElement('strong');
      name.className = 'home-mode-card-name';
      name.textContent = mode.name;

      const best = document.createElement('span');
      best.className = 'home-mode-card-stat';
      best.textContent = stats.gamesPlayed > 0 ? `HIGH ${stats.highScore}` : 'NEW';

      card.append(name, best);
      this.cardsContainer.append(card);
    });

    this.renderModeDetails(selectedMode, this.loadStats(selectedMode.id));
  }

  private selectMode(modeId: string, focusSelected: boolean): void {
    if (modeId !== this.selectedModeId) {
      this.selectedModeId = modeId;
      this.renderCards();
    }
    if (focusSelected) {
      this.cardsContainer.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
    }
  }

  private renderModeDetails(mode: SoloModeDefinition, stats: GameStats): void {
    const eyebrow = document.createElement('span');
    eyebrow.className = 'home-mode-detail-eyebrow';
    eyebrow.textContent = 'SELECTED MODE';

    const title = document.createElement('h3');
    title.id = 'home-mode-detail-title';
    title.textContent = mode.name;
    this.modeDetails.setAttribute('aria-labelledby', title.id);

    const tagline = document.createElement('p');
    tagline.className = 'home-mode-tagline';
    tagline.textContent = mode.tagline;

    const records = document.createElement('dl');
    records.className = 'home-mode-records';
    this.appendRecord(records, 'HIGH SCORE', stats.gamesPlayed > 0 ? String(stats.highScore) : '—');
    if (mode.rules.scoring.kind === 'stack-score@1') {
      this.appendRecord(records, 'BEST TURN', stats.gamesPlayed > 0 ? `${stats.longestStreak} CLEARED` : '—');
    } else {
      const unit = stats.longestStreak === 1 ? 'WAVE' : 'WAVES';
      this.appendRecord(records, 'BEST CHAIN', stats.gamesPlayed > 0 ? `${stats.longestStreak} ${unit}` : '—');
    }
    this.appendRecord(records, 'GAMES', String(stats.gamesPlayed));

    const actions = document.createElement('div');
    actions.className = 'home-mode-actions';

    const playButton = document.createElement('button');
    playButton.type = 'button';
    playButton.className = 'home-mode-action home-mode-action--play';
    playButton.textContent = this.saveLoading ? 'CHECKING SAVES…' : 'PLAY';
    playButton.disabled = this.saveLoading;
    playButton.addEventListener('click', () => this.onSelectMode(mode));
    blurOnClick(playButton);
    actions.append(playButton);

    if (mode.hasTutorial !== false) {
      const tutorialButton = document.createElement('button');
      tutorialButton.type = 'button';
      tutorialButton.className = 'home-mode-action';
      tutorialButton.textContent = 'TUTORIAL';
      tutorialButton.addEventListener('click', () => this.onRequestTutorial?.(mode));
      blurOnClick(tutorialButton);
      actions.append(tutorialButton);
    }

    this.modeDetails.append(eyebrow, title, tagline, records, actions);
  }

  private appendRecord(list: HTMLDListElement, label: string, value: string): void {
    const record = document.createElement('div');
    record.className = 'home-mode-record';
    const term = document.createElement('dt');
    term.textContent = label;
    const description = document.createElement('dd');
    description.textContent = value;
    record.append(term, description);
    list.append(record);
  }
}
