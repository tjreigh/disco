import type { SoloModeDefinition } from '../game/modes/mode.js';
import type { GameStats } from '../game/stats.js';
import type { AccountStatsState } from '../platform/account-stats-store.js';
import { blurOnClick } from './dom-utils.js';
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
    this.overlay = document.createElement('div');
    this.overlay.className = 'home-screen';
    this.overlay.setAttribute('aria-label', 'Disco home screen');
    this.overlay.setAttribute('aria-hidden', 'true');
    this.selectedModeId = this.modes[0]?.id ?? '';

    const shell = document.createElement('div');
    shell.className = 'home-shell';

    const header = document.createElement('header');
    header.className = 'home-header';

    const title = document.createElement('h1');
    title.className = 'home-title';
    title.textContent = 'DISCO';

    this.authBar = document.createElement('div');
    this.authBar.className = 'home-auth';

    header.append(title, this.authBar);

    const modeSection = document.createElement('section');
    modeSection.className = 'home-mode-section';
    modeSection.setAttribute('aria-labelledby', 'home-mode-section-title');

    const sectionHeader = document.createElement('header');
    sectionHeader.className = 'home-mode-section-header';

    const category = document.createElement('span');
    category.className = 'home-mode-category';
    category.textContent = 'SOLO';

    const sectionTitle = document.createElement('h2');
    sectionTitle.id = 'home-mode-section-title';
    sectionTitle.textContent = 'CHOOSE A MODE';

    const sectionDescription = document.createElement('p');
    sectionDescription.textContent = 'Pick a ruleset, then jump in when you’re ready.';

    sectionHeader.append(category, sectionTitle, sectionDescription);

    const browser = document.createElement('div');
    browser.className = 'home-mode-browser';

    this.cardsContainer = document.createElement('div');
    this.cardsContainer.className = 'home-mode-list';
    this.cardsContainer.setAttribute('role', 'radiogroup');
    this.cardsContainer.setAttribute('aria-label', 'Solo game modes');

    this.modeDetails = document.createElement('div');
    this.modeDetails.className = 'home-mode-detail';
    this.modeDetails.id = 'home-mode-detail';
    this.modeDetails.setAttribute('role', 'region');
    this.modeDetails.setAttribute('aria-live', 'polite');

    browser.append(this.cardsContainer, this.modeDetails);
    modeSection.append(sectionHeader, browser);

    const multiplayerSection = this.createMultiplayerSection();
    this.footer = document.createElement('footer');
    this.footer.className = 'home-footer';
    this.footer.dataset.uiAboveHome = 'true';

    const copyright = document.createElement('span');
    copyright.className = 'home-footer__copyright';
    copyright.textContent = `© ${new Date().getFullYear()} Trevor Reigh`;

    const footerLinks = document.createElement('nav');
    footerLinks.className = 'home-footer__links';
    footerLinks.setAttribute('aria-label', 'Project links');

    const github = document.createElement('a');
    github.className = 'home-footer__link';
    github.href = 'https://github.com/tjreigh/disco';
    github.target = '_blank';
    github.rel = 'noreferrer';
    github.textContent = 'GITHUB';

    const report = document.createElement('button');
    report.type = 'button';
    report.className = 'home-footer__link home-footer__button';
    report.textContent = 'REPORT / DEBUG';
    report.addEventListener('click', () => this.onRequestDebug?.());
    blurOnClick(report);

    footerLinks.append(github, report);
    this.footer.append(copyright, footerLinks);

    shell.append(header, modeSection, multiplayerSection);
    this.overlay.append(shell);
    this.mount.append(this.overlay, this.footer);

    this.menuButton = document.createElement('button');
    this.menuButton.type = 'button';
    this.menuButton.className = 'home-back-button';
    this.menuButton.setAttribute('aria-label', 'Game menu');
    const menuIcon = document.createElement('span');
    menuIcon.className = 'home-back-button__icon';
    menuIcon.setAttribute('aria-hidden', 'true');
    menuIcon.append(document.createElement('i'), document.createElement('i'), document.createElement('i'));
    const menuLabel = document.createElement('span');
    menuLabel.className = 'home-back-button__label';
    menuLabel.textContent = 'MENU';
    this.menuButton.append(menuIcon, menuLabel);
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

    const menuNote = document.createElement('p');
    menuNote.className = 'game-menu-note';
    menuNote.textContent = 'Progress saves automatically.';

    const closeMenuButton = document.createElement('button');
    closeMenuButton.type = 'button';
    closeMenuButton.className = 'game-menu-close';
    closeMenuButton.textContent = '×';
    closeMenuButton.setAttribute('aria-label', 'Resume game');
    closeMenuButton.addEventListener('click', () => this.onRequestResume?.());
    blurOnClick(closeMenuButton);

    const resumeButton = this.createGameMenuButton('RESUME', () => this.onRequestResume?.());
    resumeButton.classList.add('game-menu-button--primary');
    const restartButton = this.createGameMenuButton('RESTART', () => this.restartDialogModal.open());
    this.soundButton = this.createGameMenuButton('SOUND ON', () => this.onRequestToggleSound?.());
    this.saveExitButton = this.createGameMenuButton('SAVE & EXIT', () => this.onRequestHome?.());
    const debugButton = this.createGameMenuButton('REPORT / DEBUG', () => this.onRequestDebug?.());
    debugButton.classList.add('game-menu-button--secondary', 'game-menu-button--debug');

    panel.append(menuTitle, closeMenuButton, menuNote, resumeButton, restartButton, this.soundButton, this.saveExitButton, debugButton);
    this.gameMenu.append(panel);

    this.restartDialog = document.createElement('div');
    this.restartDialog.className = 'restart-confirmation';
    this.restartDialog.setAttribute('role', 'alertdialog');
    this.restartDialog.setAttribute('aria-modal', 'true');
    this.restartDialog.setAttribute('aria-labelledby', 'restart-confirmation-title');
    this.restartDialog.setAttribute('aria-describedby', 'restart-confirmation-description');

    const restartPanel = document.createElement('div');
    restartPanel.className = 'restart-confirmation__panel';
    const restartTitle = document.createElement('h2');
    restartTitle.id = 'restart-confirmation-title';
    restartTitle.textContent = 'RESTART GAME?';
    const restartDescription = document.createElement('p');
    restartDescription.id = 'restart-confirmation-description';
    restartDescription.textContent = 'Your current run will be replaced.';
    const restartActions = document.createElement('div');
    restartActions.className = 'restart-confirmation__actions';
    const cancelRestartButton = document.createElement('button');
    cancelRestartButton.type = 'button';
    cancelRestartButton.className = 'restart-confirmation__button';
    cancelRestartButton.textContent = 'CANCEL';
    const confirmRestartButton = document.createElement('button');
    confirmRestartButton.type = 'button';
    confirmRestartButton.className = 'restart-confirmation__button restart-confirmation__button--danger';
    confirmRestartButton.textContent = 'RESTART GAME';
    restartActions.append(cancelRestartButton, confirmRestartButton);
    restartPanel.append(restartTitle, restartDescription, restartActions);
    this.restartDialog.append(restartPanel);

    this.mount.append(this.menuButton, this.gameMenu, this.restartDialog);
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

  private createGameMenuButton(label: string, onClick: () => void): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'game-menu-button';
    button.textContent = label;
    button.addEventListener('click', onClick);
    blurOnClick(button);
    return button;
  }

  private createMultiplayerSection(): HTMLElement {
    const section = document.createElement('section');
    section.className = 'home-multiplayer';
    section.setAttribute('aria-labelledby', 'home-multiplayer-title');

    const copy = document.createElement('div');
    const eyebrow = document.createElement('span');
    eyebrow.className = 'home-multiplayer__eyebrow';
    eyebrow.textContent = 'MULTIPLAYER · SCORE RACE';
    const title = document.createElement('h2');
    title.id = 'home-multiplayer-title';
    title.textContent = 'PLAY A PRIVATE MATCH';
    const description = document.createElement('p');
    description.textContent = 'Three minutes, the same disc sequence, highest score wins.';
    copy.append(eyebrow, title, description);

    const actions = document.createElement('div');
    actions.className = 'home-multiplayer__actions';
    const createButton = document.createElement('button');
    createButton.type = 'button';
    createButton.className = 'home-mode-action home-multiplayer__create';
    createButton.textContent = 'CREATE ROOM';
    createButton.addEventListener('click', () => this.onRequestCreateMultiplayer?.());
    blurOnClick(createButton);

    const joinLabel = document.createElement('label');
    joinLabel.className = 'home-multiplayer__join';
    const labelText = document.createElement('span');
    labelText.textContent = 'ROOM CODE';
    const roomInput = document.createElement('input');
    roomInput.type = 'text';
    roomInput.inputMode = 'text';
    roomInput.autocomplete = 'off';
    roomInput.maxLength = 8;
    roomInput.placeholder = 'ABCD2345';
    roomInput.setAttribute('aria-label', 'Private room code');
    const joinButton = document.createElement('button');
    joinButton.type = 'button';
    joinButton.className = 'home-mode-action';
    joinButton.textContent = 'JOIN';
    const join = () => {
      const roomId = roomInput.value.trim().toUpperCase();
      if (!roomId) return;
      this.onRequestJoinMultiplayer?.(roomId);
    };
    joinButton.addEventListener('click', join);
    roomInput.addEventListener('keydown', event => {
      if (event.key === 'Enter') join();
    });
    blurOnClick(joinButton);
    joinLabel.append(labelText, roomInput, joinButton);
    actions.append(createButton, joinLabel);
    section.append(copy, actions);
    return section;
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
