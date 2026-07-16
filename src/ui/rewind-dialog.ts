import type { RewindPreview } from '../game/engine.js';
import { DiscKind } from '../game/model.js';
import { blurOnClick } from './dom-utils.js';
import { ModalController } from './modal-controller.js';

/** Confirmation step that makes a Paradox rewind's exact cost visible first. */
export class RewindDialog {
  private readonly root: HTMLElement;
  private readonly title: HTMLElement;
  private readonly depthSelector: HTMLElement;
  private readonly instability: HTMLElement;
  private readonly consequence: HTMLElement;
  private readonly rescue: HTMLElement;
  private readonly confirmButton: HTMLButtonElement;
  private readonly modal: ModalController;

  onConfirm?: () => void;
  onCancel?: () => void;
  onSelectTurns?: (turns: number) => void;

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
    this.title = document.createElement('h2');
    this.title.id = 'rewind-dialog-title';
    const intro = document.createElement('p');
    intro.className = 'rewind-panel__intro';
    intro.textContent = 'Inspect the restored board before committing the rewind.';
    this.depthSelector = document.createElement('div');
    this.depthSelector.className = 'rewind-panel__depths';
    this.depthSelector.setAttribute('role', 'group');
    this.depthSelector.setAttribute('aria-label', 'Turns to rewind');
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
    copy.append(
      eyebrow, this.title, intro, this.depthSelector,
      this.instability, this.consequence, this.rescue,
    );
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
    this.update(preview);
    this.modal.open();
  }

  update(preview: RewindPreview): void {
    const turnLabel = preview.turnsRewound === 1 ? 'TURN' : 'TURNS';
    this.title.textContent = `REWIND ${preview.turnsRewound} ${turnLabel}?`;
    this.confirmButton.textContent = `REWIND ${preview.turnsRewound}`;
    const restoreDepthFocus = this.depthSelector.contains(document.activeElement);
    let selectedDepthButton: HTMLButtonElement | null = null;
    this.depthSelector.replaceChildren();
    for (let turns = 1; turns <= preview.historyAvailable; turns++) {
      const button = this.makeButton(String(turns), false, () => this.onSelectTurns?.(turns));
      button.classList.add('rewind-panel__depth');
      button.classList.toggle('rewind-panel__depth--selected', turns === preview.turnsRewound);
      button.setAttribute('aria-label', `Rewind ${turns} ${turns === 1 ? 'turn' : 'turns'}`);
      button.setAttribute('aria-pressed', String(turns === preview.turnsRewound));
      if (turns === preview.turnsRewound) selectedDepthButton = button;
      this.depthSelector.append(button);
    }
    if (restoreDepthFocus && selectedDepthButton) {
      queueMicrotask(() => selectedDepthButton?.focus());
    }
    const pressure = preview.turnCostBefore === preview.turnCostAfter
      ? `Pressure ×${preview.turnCostAfter}`
      : `Pressure ×${preview.turnCostBefore} → ×${preview.turnCostAfter}`;
    this.instability.textContent = `Instability ${preview.instabilityBefore} → ${preview.instabilityAfter} · ${pressure}`;
    const count = preview.fractures.length;
    if (count === 0) {
      this.consequence.textContent = 'No disc will fracture on the restored board — this time.';
    } else {
      const layerCounts = new Set(preview.fractures.map(target => target.resultingKind));
      const layers = layerCounts.size > 1
        ? 'one or two layers'
        : preview.fractures[0]!.resultingKind === DiscKind.DoubleCracked ? 'two layers' : 'one layer';
      const values = new Intl.ListFormat('en', { type: 'conjunction' }).format(
        preview.fractures.map(target => String(target.discValue)),
      );
      const materialized = preview.fractures.filter(target => target.materialized).length;
      const instabilityAdded = preview.fractures.reduce(
        (total, target) => total + target.instabilityAdded,
        0,
      );
      const remnantCopy = materialized === 0
        ? ''
        : `${materialized} erased ${materialized === 1 ? 'disc returns' : 'discs return'} as ${materialized === 1 ? 'a temporal remnant' : 'temporal remnants'}. `;
      const fractureCopy = count === 1
        ? `Highlighted disc: ${values} → ${layers} of temporal damage.`
        : `Highlighted discs: ${values} → ${layers} of temporal damage each.`;
      const repairCopy = ` Repair ${count === 1 ? 'it' : 'them'} to recover ${instabilityAdded} instability.`;
      this.consequence.textContent = remnantCopy + fractureCopy + repairCopy;
    }
    this.rescue.textContent = preview.rescuesGameOver
      ? 'This rewind rescues the run from game over.'
      : `Erase ${preview.turnsRewound} ${preview.turnsRewound === 1 ? 'turn' : 'turns'} and return to turn ${preview.dropCount + 1}.`;
    this.rescue.hidden = false;
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
