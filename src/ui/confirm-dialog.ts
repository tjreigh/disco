import { blurOnClick, cloneTemplate, mustQuery } from './dom-utils.js';
import { ModalController } from './modal-controller.js';

interface ConfirmDialogOptions {
  readonly title: string;
  readonly description: string;
  readonly confirmLabel: string;
  readonly onConfirm: () => void;
}

// Each clone needs unique ids for its ARIA relationships.
let instanceCount = 0;

/** Shared alert-dialog behavior for destructive confirmations. */
export class ConfirmDialog {
  private readonly root: HTMLElement;
  private readonly modal: ModalController;

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
    const cancelButton = mustQuery<HTMLButtonElement>(fragment, '[data-confirm-dialog-action="cancel"]');
    const confirmButton = mustQuery<HTMLButtonElement>(fragment, '.restart-confirmation__button--danger');

    titleEl.id = `${id}-title`;
    descriptionEl.id = `${id}-description`;
    this.root.setAttribute('aria-labelledby', titleEl.id);
    this.root.setAttribute('aria-describedby', descriptionEl.id);
    titleEl.textContent = options.title;
    descriptionEl.textContent = options.description;
    confirmButton.textContent = options.confirmLabel;

    cancelButton.addEventListener('click', () => this.close());
    confirmButton.addEventListener('click', () => {
      this.close();
      options.onConfirm();
    });
    blurOnClick(cancelButton);
    blurOnClick(confirmButton);

    mount.append(fragment);

    this.modal = new ModalController(this.root, {
      openClass: 'restart-confirmation--open',
      initialFocus: () => cancelButton,
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

  destroy(): void {
    this.root.remove();
  }
}
