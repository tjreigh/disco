import { ConfirmDialog } from './confirm-dialog.js';
import { blurOnClick, cloneTemplate, mustQuery } from './dom-utils.js';
import { MenuControls } from './menu-controls.js';
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
  private readonly forfeitDialog: ConfirmDialog;
  private readonly menuModal: ModalController;
  private readonly menuControls: MenuControls;

  // Set by the owning game controller after construction, avoiding a
  // constructor-time forward reference — same convention as HomeScreen's
  // onRequest* fields.
  onRequestOpen?: () => void;
  onRequestResume?: () => void;
  onRequestForfeit?: () => void;
  onRequestExportDiagnostics?: () => void;
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

    this.menuButton.addEventListener('click', () => this.open());
    blurOnClick(this.menuButton);

    const closeButton = mustQuery<HTMLButtonElement>(fragment, '.game-menu-close');
    closeButton.addEventListener('click', () => this.close());
    blurOnClick(closeButton);

    const resumeButton = mustQuery<HTMLButtonElement>(fragment, '.game-menu-button--primary');
    resumeButton.addEventListener('click', () => this.close());
    blurOnClick(resumeButton);

    this.menuControls = new MenuControls(
      {
        soundButton: mustQuery(fragment, '[data-pause-menu-action="sound"]'),
        advancedHudButton: mustQuery(fragment, '[data-pause-menu-action="advanced-hud"]'),
        zoomOutButton: mustQuery(fragment, '[data-pause-menu-action="zoom-out"]'),
        zoomResetButton: mustQuery(fragment, '[data-pause-menu-action="zoom-reset"]'),
        zoomInButton: mustQuery(fragment, '[data-pause-menu-action="zoom-in"]'),
      },
      {
        onRequestToggleSound: () => this.onRequestToggleSound?.(),
        onRequestToggleAdvancedHud: () => this.onRequestToggleAdvancedHud?.(),
        onRequestZoomOut: () => this.onRequestZoomOut?.(),
        onRequestZoomReset: () => this.onRequestZoomReset?.(),
        onRequestZoomIn: () => this.onRequestZoomIn?.(),
      },
    );

    const forfeitButton = mustQuery<HTMLButtonElement>(fragment, '[data-pause-menu-action="forfeit"]');
    forfeitButton.addEventListener('click', () => this.forfeitDialog.open());
    blurOnClick(forfeitButton);

    const exportDiagnosticsButton = mustQuery<HTMLButtonElement>(fragment, '[data-pause-menu-action="export-diagnostics"]');
    exportDiagnosticsButton.addEventListener('click', () => this.onRequestExportDiagnostics?.());
    blurOnClick(exportDiagnosticsButton);

    mount.append(fragment);

    this.menuModal = new ModalController(this.menu, {
      openClass: 'game-menu--open',
      initialFocus: () => resumeButton,
      inertTargets: modalBackground,
      onEscape: () => this.close(),
      restoreFocus: false,
    });
    this.forfeitDialog = new ConfirmDialog(mount, modalBackground, {
      title: 'FORFEIT MATCH?',
      description: "Your opponent will be declared the winner. This can't be undone.",
      confirmLabel: 'FORFEIT',
      onConfirm: () => {
        this.menuModal.close();
        this.onRequestForfeit?.();
      },
    });
  }

  open(): void {
    this.menuModal.open();
    this.onRequestOpen?.();
  }

  close(): void {
    this.forfeitDialog.close();
    this.menuModal.close();
    this.onRequestResume?.();
  }

  isOpen(): boolean {
    return this.menuModal.isOpen();
  }

  /** Closes without firing onRequestResume — the match already ended out from under this menu. */
  forceClose(): void {
    this.forfeitDialog.close();
    this.menuModal.close();
  }

  setCanOpen(canOpen: boolean): void {
    this.menuButton.classList.toggle('home-back-button--visible', canOpen);
    this.menuButton.setAttribute('aria-hidden', String(!canOpen));
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

  destroy(): void {
    this.menuButton.remove();
    this.menu.remove();
    this.forfeitDialog.destroy();
  }
}
