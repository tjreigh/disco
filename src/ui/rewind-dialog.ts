import type { RewindPreview } from '../game/engine.js';
import { DiscKind } from '../game/model.js';
import { blurOnClick } from './dom-utils.js';
import { ModalController } from './modal-controller.js';

/** Confirmation step that makes a Paradox rewind's exact cost visible first. */
export class RewindDialog {
  private readonly root: HTMLElement;
  private readonly instability: HTMLElement;
  private readonly consequence: HTMLElement;
  private readonly rescue: HTMLElement;
  private readonly confirmButton: HTMLButtonElement;
  private readonly modal: ModalController;

  onConfirm?: () => void;
  onCancel?: () => void;

  constructor(
    mount: HTMLElement = document.body,
    modalBackground: readonly HTMLElement[] = [],
  ) {
    this.root = document.createElement('section');
    this.root.className = 'rewind-dialog';
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-modal', 'true');
    this.root.setAttribute('aria-labelledby', 'rewind-dialog-title');
    this.root.setAttribute('aria-describedby', 'rewind-dialog-consequence');

    const panel = document.createElement('div');
    panel.className = 'rewind-panel';
    const copy = document.createElement('div');
    copy.className = 'rewind-panel__copy';
    const eyebrow = document.createElement('p');
    eyebrow.className = 'rewind-panel__eyebrow';
    eyebrow.textContent = 'PARADOX';
    const title = document.createElement('h2');
    title.id = 'rewind-dialog-title';
    title.textContent = 'REWIND LAST TURN?';
    const intro = document.createElement('p');
    intro.className = 'rewind-panel__intro';
    intro.textContent = 'Inspect the restored board before committing the rewind.';
    this.instability = document.createElement('p');
    this.instability.className = 'rewind-panel__instability';
    this.consequence = document.createElement('p');
    this.consequence.className = 'rewind-panel__consequence';
    this.consequence.id = 'rewind-dialog-consequence';
    this.rescue = document.createElement('p');
    this.rescue.className = 'rewind-panel__rescue';

    const actions = document.createElement('div');
    actions.className = 'rewind-panel__actions';
    this.confirmButton = this.makeButton('CONFIRM REWIND', true, () => this.onConfirm?.());
    const cancelButton = this.makeButton('KEEP TURN', false, () => this.onCancel?.());
    actions.append(this.confirmButton, cancelButton);
    copy.append(eyebrow, title, intro, this.instability, this.consequence, this.rescue);
    panel.append(copy, actions);
    this.root.append(panel);
    mount.append(this.root);

    this.modal = new ModalController(this.root, {
      openClass: 'rewind-dialog--open',
      initialFocus: () => this.confirmButton,
      inertTargets: modalBackground,
      onEscape: () => this.onCancel?.(),
    });
  }

  show(preview: RewindPreview): void {
    this.instability.textContent = `Instability ${preview.instabilityBefore} → ${preview.instabilityAfter}`;
    const count = preview.fractures.length;
    if (count === 0) {
      this.consequence.textContent = 'No disc will fracture on the restored board — this time.';
    } else {
      const layers = preview.fractures[0]!.resultingKind === DiscKind.DoubleCracked ? 'two layers' : 'one layer';
      const values = preview.fractures.map(target => target.discValue).join(' and ');
      this.consequence.textContent = count === 1
        ? `Highlighted disc: ${values} → ${layers} of temporal damage.`
        : `Highlighted discs: ${values} → ${layers} of temporal damage each.`;
    }
    this.rescue.textContent = preview.rescuesGameOver
      ? 'This rewind rescues the run from game over.'
      : `Return to turn ${preview.dropCount + 1} with the previous score and queue.`;
    this.rescue.hidden = false;
    this.modal.open();
  }

  hide(): void {
    this.modal.close();
  }

  isOpen(): boolean {
    return this.modal.isOpen();
  }

  private makeButton(label: string, primary: boolean, onClick: () => void): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `rewind-panel__button${primary ? ' rewind-panel__button--primary' : ''}`;
    button.textContent = label;
    button.addEventListener('click', onClick);
    return blurOnClick(button);
  }
}
