import { MIN_ZOOM, MAX_ZOOM } from '../platform/user-settings-store.js';
import { blurOnClick, cloneTemplate, mustQuery } from './dom-utils.js';
import { ModalController } from './modal-controller.js';

/**
 * In-match pause menu shared by both multiplayer screens (Score Race, Disco
 * Duel). Mirrors HomeScreen's single-player game-menu (open/close driven
 * imperatively by the owning controller, not a per-frame reactive render)
 * but trimmed to what makes sense mid-match against a live opponent: no
 * restart, no save & exit, forfeit instead.
 */
export class MultiplayerPauseMenu {
  private readonly menuButton: HTMLButtonElement;
  private readonly menu: HTMLElement;
  private readonly forfeitDialog: HTMLElement;
  private readonly soundButton: HTMLButtonElement;
  private readonly advancedHudButton: HTMLButtonElement;
  private readonly zoomOutButton: HTMLButtonElement;
  private readonly zoomResetButton: HTMLButtonElement;
  private readonly zoomInButton: HTMLButtonElement;
  private readonly menuModal: ModalController;
  private readonly forfeitDialogModal: ModalController;

  // Set by the owning game controller after construction, avoiding a
  // constructor-time forward reference — same convention as HomeScreen's
  // onRequest* fields.
  onRequestOpen?: () => void;
  onRequestResume?: () => void;
  onRequestForfeit?: () => void;
  onRequestToggleSound?: () => void;
  onRequestToggleAdvancedHud?: () => void;
  onRequestZoomIn?: () => void;
  onRequestZoomOut?: () => void;
  onRequestZoomReset?: () => void;

  constructor(
    mount: HTMLElement,
    modalBackground: readonly HTMLElement[] = [],
  ) {
    const fragment = cloneTemplate('tpl-multiplayer-pause-menu');
    this.menuButton = mustQuery(fragment, '.home-back-button');
    this.menu = mustQuery(fragment, '.game-menu');
    this.forfeitDialog = mustQuery(fragment, '.restart-confirmation');

    this.menuButton.addEventListener('click', () => this.open());
    blurOnClick(this.menuButton);

    const closeButton = mustQuery<HTMLButtonElement>(fragment, '.game-menu-close');
    closeButton.addEventListener('click', () => this.close());
    blurOnClick(closeButton);

    const resumeButton = mustQuery<HTMLButtonElement>(fragment, '.game-menu-button--primary');
    resumeButton.addEventListener('click', () => this.close());
    blurOnClick(resumeButton);

    this.soundButton = mustQuery(fragment, '[data-pause-menu-action="sound"]');
    this.soundButton.addEventListener('click', () => this.onRequestToggleSound?.());
    blurOnClick(this.soundButton);

    this.advancedHudButton = mustQuery(fragment, '[data-pause-menu-action="advanced-hud"]');
    this.advancedHudButton.addEventListener('click', () => this.onRequestToggleAdvancedHud?.());
    blurOnClick(this.advancedHudButton);

    this.zoomOutButton = mustQuery(fragment, '[data-pause-menu-action="zoom-out"]');
    this.zoomOutButton.addEventListener('click', () => this.onRequestZoomOut?.());
    blurOnClick(this.zoomOutButton);

    this.zoomResetButton = mustQuery(fragment, '[data-pause-menu-action="zoom-reset"]');
    this.zoomResetButton.addEventListener('click', () => this.onRequestZoomReset?.());
    blurOnClick(this.zoomResetButton);

    this.zoomInButton = mustQuery(fragment, '[data-pause-menu-action="zoom-in"]');
    this.zoomInButton.addEventListener('click', () => this.onRequestZoomIn?.());
    blurOnClick(this.zoomInButton);

    const forfeitButton = mustQuery<HTMLButtonElement>(fragment, '[data-pause-menu-action="forfeit"]');
    forfeitButton.addEventListener('click', () => this.forfeitDialogModal.open());
    blurOnClick(forfeitButton);

    const cancelForfeitButton = mustQuery<HTMLButtonElement>(fragment, '[data-forfeit-action="cancel"]');
    const confirmForfeitButton = mustQuery<HTMLButtonElement>(fragment, '.restart-confirmation__button--danger');

    mount.append(fragment);

    this.menuModal = new ModalController(this.menu, {
      openClass: 'game-menu--open',
      initialFocus: () => resumeButton,
      inertTargets: modalBackground,
      onEscape: () => this.close(),
      restoreFocus: false,
    });
    this.forfeitDialogModal = new ModalController(this.forfeitDialog, {
      openClass: 'restart-confirmation--open',
      initialFocus: () => cancelForfeitButton,
      inertTargets: modalBackground,
      onEscape: () => this.forfeitDialogModal.close(),
    });

    cancelForfeitButton.addEventListener('click', () => this.forfeitDialogModal.close());
    confirmForfeitButton.addEventListener('click', () => {
      this.forfeitDialogModal.close();
      this.menuModal.close();
      this.onRequestForfeit?.();
    });
    blurOnClick(cancelForfeitButton);
    blurOnClick(confirmForfeitButton);
  }

  open(): void {
    this.menuModal.open();
    this.onRequestOpen?.();
  }

  close(): void {
    this.forfeitDialogModal.close();
    this.menuModal.close();
    this.onRequestResume?.();
  }

  isOpen(): boolean {
    return this.menuModal.isOpen();
  }

  /** Closes without firing onRequestResume — the match already ended out from under this menu. */
  forceClose(): void {
    this.forfeitDialogModal.close();
    this.menuModal.close();
  }

  setCanOpen(canOpen: boolean): void {
    this.menuButton.classList.toggle('home-back-button--visible', canOpen);
    this.menuButton.setAttribute('aria-hidden', String(!canOpen));
  }

  setSoundEnabled(enabled: boolean): void {
    this.soundButton.textContent = enabled ? 'SOUND ON' : 'SOUND OFF';
  }

  setAdvancedHudEnabled(enabled: boolean): void {
    this.advancedHudButton.textContent = enabled ? 'ADVANCED HUD ON' : 'ADVANCED HUD OFF';
    this.advancedHudButton.setAttribute('aria-pressed', String(enabled));
  }

  updateZoomState(scale: number): void {
    this.zoomInButton.disabled = scale >= MAX_ZOOM;
    this.zoomOutButton.disabled = scale <= MIN_ZOOM;
    this.zoomResetButton.disabled = scale <= MIN_ZOOM;
  }

  destroy(): void {
    this.menuButton.remove();
    this.menu.remove();
    this.forfeitDialog.remove();
  }
}
