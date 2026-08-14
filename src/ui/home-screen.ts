import { MULTIPLAYER_MODES } from '../game/modes/index.js';
import type { MultiplayerModeDefinition, SoloModeDefinition } from '../game/modes/mode.js';
import type { GameStats } from '../game/stats.js';
import type { AccountStatsState } from '../platform/account-stats-store.js';
import { ConfirmDialog } from './confirm-dialog.js';
import { blurOnClick, cloneTemplate, mustQuery } from './dom-utils.js';
import { applyInert } from './inert-siblings.js';
import { MenuControls } from './menu-controls.js';
import { ModalController } from './modal-controller.js';

const MODE_DOUBLE_CLICK_MS = 400;

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
  private readonly restartDialog: ConfirmDialog;
  private readonly saveExitButton: HTMLButtonElement;
  private readonly gameMenuModal: ModalController;
  private readonly menuControls: MenuControls;
  private readonly multiplayerModesContainer: HTMLElement;
  private readonly multiplayerTagline: HTMLElement;
  private releaseInert: (() => void) | null = null;
  private saveLoading = false;
  private selectedModeId: string;
  private selectedMultiplayerModeId: string;
  private lastModeClick: { modeId: string; at: number } | undefined;

  // Set by Game after construction, avoiding a constructor-time forward
  // reference to a not-yet-defined method.
  onRequestGameMenu?: () => void;
  onRequestResume?: () => void;
  onRequestRestart?: () => void;
  onRequestHome?: () => void;
  onRequestToggleSound?: () => void;
  onRequestToggleAdvancedHud?: () => void;
  onRequestZoomIn?: () => void;
  onRequestZoomOut?: () => void;
  onRequestZoomReset?: () => void;
  onRequestDebug?: () => void;
  onRequestAdvancedStats?: (modeId?: string) => void;
  onRequestTutorial?: (mode: SoloModeDefinition) => void;
  onRequestCreateMultiplayer?: (modeId: string) => void;
  onRequestJoinMultiplayer?: (roomId: string, modeId: string) => void;

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
    this.selectedMultiplayerModeId = MULTIPLAYER_MODES[0]?.id ?? '';
    this.authBar = mustQuery(mainFragment, '.home-auth');
    this.cardsContainer = mustQuery(mainFragment, '.home-mode-list');
    this.modeDetails = mustQuery(mainFragment, '.home-mode-detail');
    this.footer = mustQuery(mainFragment, '.home-footer');
    this.multiplayerModesContainer = mustQuery(mainFragment, '.home-multiplayer__modes');
    this.multiplayerTagline = mustQuery(mainFragment, '.home-multiplayer__tagline');

    const copyright = mustQuery<HTMLElement>(mainFragment, '.home-footer__copyright');
    copyright.textContent = `© ${new Date().getFullYear()} Trevor Reigh`;

    const report = mustQuery<HTMLButtonElement>(mainFragment, '.home-footer__button');
    report.addEventListener('click', () => this.onRequestDebug?.());
    blurOnClick(report);

    const advancedStats = mustQuery<HTMLButtonElement>(mainFragment, '[data-home-action="advanced-stats"]');
    advancedStats.addEventListener('click', () => this.onRequestAdvancedStats?.());
    blurOnClick(advancedStats);

    this.renderMultiplayerModes();

    const createRoomButton = mustQuery<HTMLButtonElement>(mainFragment, '[data-multiplayer-action="create"]');
    createRoomButton.addEventListener('click', () => this.onRequestCreateMultiplayer?.(this.selectedMultiplayerModeId));
    blurOnClick(createRoomButton);

    const roomInput = mustQuery<HTMLInputElement>(mainFragment, '.home-multiplayer__join input');
    const joinButton = mustQuery<HTMLButtonElement>(mainFragment, '[data-multiplayer-action="join"]');
    const join = (): void => {
      const roomId = roomInput.value.trim().toUpperCase();
      if (!roomId) return;
      this.onRequestJoinMultiplayer?.(roomId, this.selectedMultiplayerModeId);
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

    this.menuButton.addEventListener('click', () => this.onRequestGameMenu?.());
    blurOnClick(this.menuButton);

    const closeMenuButton = mustQuery<HTMLButtonElement>(menuFragment, '.game-menu-close');
    closeMenuButton.addEventListener('click', () => this.onRequestResume?.());
    blurOnClick(closeMenuButton);

    const resumeButton = mustQuery<HTMLButtonElement>(menuFragment, '.game-menu-button--primary');
    resumeButton.addEventListener('click', () => this.onRequestResume?.());
    blurOnClick(resumeButton);

    const restartButton = mustQuery<HTMLButtonElement>(menuFragment, '[data-game-menu-action="restart"]');
    restartButton.addEventListener('click', () => this.restartDialog.open());
    blurOnClick(restartButton);

    this.menuControls = new MenuControls(
      {
        soundButton: mustQuery(menuFragment, '[data-game-menu-action="sound"]'),
        advancedHudButton: mustQuery(menuFragment, '[data-game-menu-action="advanced-hud"]'),
        zoomOutButton: mustQuery(menuFragment, '[data-game-menu-action="zoom-out"]'),
        zoomResetButton: mustQuery(menuFragment, '[data-game-menu-action="zoom-reset"]'),
        zoomInButton: mustQuery(menuFragment, '[data-game-menu-action="zoom-in"]'),
      },
      {
        onRequestToggleSound: () => this.onRequestToggleSound?.(),
        onRequestToggleAdvancedHud: () => this.onRequestToggleAdvancedHud?.(),
        onRequestZoomOut: () => this.onRequestZoomOut?.(),
        onRequestZoomReset: () => this.onRequestZoomReset?.(),
        onRequestZoomIn: () => this.onRequestZoomIn?.(),
      },
    );

    this.saveExitButton = mustQuery(menuFragment, '[data-game-menu-action="save-exit"]');
    this.saveExitButton.addEventListener('click', () => this.onRequestHome?.());
    blurOnClick(this.saveExitButton);

    const debugButton = mustQuery<HTMLButtonElement>(menuFragment, '.game-menu-button--debug');
    debugButton.addEventListener('click', () => this.onRequestDebug?.());
    blurOnClick(debugButton);

    this.mount.append(menuFragment);
    this.gameMenuModal = new ModalController(this.gameMenu, {
      openClass: 'game-menu--open',
      initialFocus: () => resumeButton,
      inertTargets: this.modalBackground,
      onEscape: () => this.onRequestResume?.(),
      restoreFocus: false,
    });
    this.restartDialog = new ConfirmDialog(this.mount, this.modalBackground, {
      title: 'RESTART GAME?',
      description: 'Your current run will be replaced.',
      confirmLabel: 'RESTART GAME',
      onConfirm: () => this.onRequestRestart?.(),
    });

    this.renderCards();
    this.renderAuth();
  }

  open(): void {
    this.lastModeClick = undefined;
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
    this.restartDialog.close();
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
    this.menuControls.setSoundEnabled(enabled);
  }

  setAdvancedHudEnabled(enabled: boolean): void {
    this.menuControls.setAdvancedHudEnabled(enabled);
  }

  updateZoomState(scale: number): void {
    this.menuControls.updateZoomState(scale);
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
      this.releaseInert = applyInert(
        this.overlay,
        this.modalBackground,
        element => element.dataset.uiAboveHome === 'true',
      );
      return;
    }
    this.releaseInert?.();
    this.releaseInert = null;
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
        if (event.detail === 0) {
          this.lastModeClick = undefined;
          this.selectMode(mode.id, true);
          return;
        }
        const now = performance.now();
        const startsMode = this.lastModeClick?.modeId === mode.id
          && now - this.lastModeClick.at <= MODE_DOUBLE_CLICK_MS;
        this.lastModeClick = startsMode ? undefined : { modeId: mode.id, at: now };
        this.selectMode(mode.id, false);
        if (startsMode) this.requestModeStart(mode);
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

  private renderMultiplayerModes(): void {
    this.multiplayerModesContainer.replaceChildren();
    for (const mode of MULTIPLAYER_MODES) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'home-multiplayer__mode-button';
      button.textContent = mode.name.toUpperCase();
      button.setAttribute('role', 'radio');
      button.dataset.multiplayerModeId = mode.id;
      button.addEventListener('click', () => this.selectMultiplayerMode(mode));
      blurOnClick(button);
      this.multiplayerModesContainer.append(button);
    }
    this.updateMultiplayerModeSelection();
  }

  private selectMultiplayerMode(mode: MultiplayerModeDefinition): void {
    this.selectedMultiplayerModeId = mode.id;
    this.updateMultiplayerModeSelection();
  }

  private updateMultiplayerModeSelection(): void {
    const selectedMode = MULTIPLAYER_MODES.find(mode => mode.id === this.selectedMultiplayerModeId)
      ?? MULTIPLAYER_MODES[0];
    for (const button of this.multiplayerModesContainer.querySelectorAll<HTMLButtonElement>('button')) {
      button.setAttribute(
        'aria-checked',
        String(button.dataset.multiplayerModeId === this.selectedMultiplayerModeId),
      );
    }
    this.multiplayerTagline.textContent = selectedMode?.tagline ?? '';
  }

  private renderModeDetails(mode: SoloModeDefinition, stats: GameStats): void {
    const header = document.createElement('div');
    header.className = 'home-mode-detail-header';

    const heading = document.createElement('div');
    heading.className = 'home-mode-detail-heading';

    const eyebrow = document.createElement('span');
    eyebrow.className = 'home-mode-detail-eyebrow';
    eyebrow.textContent = 'SELECTED MODE';

    const title = document.createElement('h3');
    title.id = 'home-mode-detail-title';
    title.textContent = mode.name;
    this.modeDetails.setAttribute('aria-labelledby', title.id);

    const statsButton = document.createElement('button');
    statsButton.type = 'button';
    statsButton.className = 'home-mode-detail-stats';
    statsButton.textContent = 'MODE STATS';
    statsButton.setAttribute('aria-label', `${mode.name} advanced stats`);
    statsButton.addEventListener('click', () => this.onRequestAdvancedStats?.(mode.id));
    blurOnClick(statsButton);

    heading.append(eyebrow, title);
    header.append(heading, statsButton);

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
    playButton.addEventListener('click', () => this.requestModeStart(mode));
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

    this.modeDetails.append(header, tagline, records, actions);
  }

  private requestModeStart(mode: SoloModeDefinition): void {
    if (this.saveLoading) return;
    this.onSelectMode(mode);
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
