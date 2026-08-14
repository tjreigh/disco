import { blurOnClick, cloneTemplate, mustQuery } from './dom-utils.js';
import { ModalController } from './modal-controller.js';

export interface ConfirmDialogOptions {
  readonly title: string;
  readonly description: string;
  readonly confirmLabel: string;
  readonly onConfirm: () => void;
}

// Each instance needs its own title/description ids — this template is
// cloned more than once per page (Home's restart confirmation, the
// multiplayer pause menu's forfeit confirmation), and duplicate DOM ids
// would make aria-labelledby/aria-describedby ambiguous.
let instanceCount = 0;

/**
 * The alertdialog "are you sure?" confirmation shared by HomeScreen's
 * restart prompt and MultiplayerPauseMenu's forfeit prompt — same markup,
 * same open/cancel/confirm/focus/Escape behavior, different copy.
 */
export class ConfirmDialog {
  private readonly root: HTMLElement;
  private readonly modal: ModalController;
  private readonly cancelButton: HTMLButtonElement;
  private readonly confirmButton: HTMLButtonElement;

  constructor(
    mount: HTMLElement,
    modalBackground: readonly HTMLElement[],
    options: ConfirmDialogOptions,
  ) {
    const id = `confirm-dialog-${++instanceCount}`;
    const fragment = cloneTemplate('tpl-confirm-dialog');
    this.root = mustQuery(fragment, '.restart-confirmation');
    const titleEl = mustQuery<HTMLElement>(fragment, '.restart-confirmation__title');
    const descriptionEl = mustQuery<HTMLElement>(fragment, '.restart-confirmation__description');
    this.cancelButton = mustQuery(fragment, '[data-confirm-dialog-action="cancel"]');
    this.confirmButton = mustQuery(fragment, '.restart-confirmation__button--danger');

    titleEl.id = `${id}-title`;
    descriptionEl.id = `${id}-description`;
    this.root.setAttribute('aria-labelledby', titleEl.id);
    this.root.setAttribute('aria-describedby', descriptionEl.id);
    titleEl.textContent = options.title;
    descriptionEl.textContent = options.description;
    this.confirmButton.textContent = options.confirmLabel;

    this.cancelButton.addEventListener('click', () => this.close());
    this.confirmButton.addEventListener('click', () => {
      this.close();
      options.onConfirm();
    });
    blurOnClick(this.cancelButton);
    blurOnClick(this.confirmButton);

    mount.append(fragment);

    this.modal = new ModalController(this.root, {
      openClass: 'restart-confirmation--open',
      initialFocus: () => this.cancelButton,
      inertTargets: modalBackground,
      onEscape: () => this.close(),
    });
  }

  open(): void {
    this.modal.open();
  }

  close(): void {
    this.modal.close();
  }

  isOpen(): boolean {
    return this.modal.isOpen();
  }

  destroy(): void {
    this.root.remove();
  }
}
