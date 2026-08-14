import type { RewindPreview } from '../game/engine.js';
import { DiscKind } from '../game/model.js';
import { blurOnClick, cloneTemplate, mustQuery } from './dom-utils.js';
import { ModalController } from './modal-controller.js';

/** Confirmation step that makes a Paradox rewind's exact cost visible first. */
export class RewindDialog {
  private readonly root: HTMLElement;
  private readonly panel: HTMLElement;
  private readonly title: HTMLElement;
  private readonly depthSelector: HTMLElement;
  private readonly instability: HTMLElement;
  private readonly consequence: HTMLElement;
  private readonly rescue: HTMLElement;
  private readonly confirmButton: HTMLButtonElement;
  private readonly modal: ModalController;
  private readonly gameStage: HTMLElement | null;

  onConfirm?: () => void;
  onCancel?: () => void;
  onSelectTurns?: (turns: number) => void;
  /** Fired whenever the board needs to be re-measured against the dialog's
   * footprint — see syncBoardClearance(). */
  onLayoutChange?: () => void;

  constructor(
    mount: HTMLElement = document.body,
    modalBackground: readonly HTMLElement[] = [],
    gameStage: HTMLElement | null = document.querySelector('.game-stage'),
  ) {
    this.gameStage = gameStage;
    const fragment = cloneTemplate('tpl-rewind-dialog');
    this.root = mustQuery(fragment, '.rewind-dialog');
    this.panel = mustQuery(fragment, '.rewind-panel');
    this.title = mustQuery(fragment, '.rewind-panel__copy > h2');
    this.depthSelector = mustQuery(fragment, '.rewind-panel__depths');
    this.instability = mustQuery(fragment, '.rewind-panel__instability');
    this.consequence = mustQuery(fragment, '.rewind-panel__consequence');
    this.rescue = mustQuery(fragment, '.rewind-panel__rescue');
    this.confirmButton = mustQuery(fragment, '.rewind-panel__button--primary');
    const cancelButton = mustQuery<HTMLButtonElement>(fragment, '[data-rewind-action="cancel"]');

    this.confirmButton.addEventListener('click', () => this.onConfirm?.());
    blurOnClick(this.confirmButton);
    cancelButton.addEventListener('click', () => this.onCancel?.());
    blurOnClick(cancelButton);

    mount.append(fragment);

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
    this.syncBoardClearance();
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
    // Depth reselection can change the panel's height (consequence copy
    // varies in length), so re-measure whenever already open.
    if (this.modal.isOpen()) this.syncBoardClearance();
  }

  hide(): void {
    this.modal.close();
    this.syncBoardClearance();
  }

  isOpen(): boolean {
    return this.modal.isOpen();
  }

  /** Re-measures the dialog against the viewport — call after a window resize
   * while the dialog may be open, since the panel's position depends on it. */
  refreshLayout(): void {
    if (this.modal.isOpen()) this.syncBoardClearance();
  }

  // The dialog previews a live change to the board underneath it, so instead
  // of overlaying it (obscuring exactly the thing being previewed), the board
  // reserves this much space at its own bottom edge — shrinking and shifting
  // itself up to stay fully clear of the panel. See the .game-stage rule in
  // game-controls.css that reads --rewind-dialog-clearance.
  //
  // Measured against .game-stage's own bottom edge, not window.innerHeight:
  // .game-stage sits above the footer/safe-area strip, so using the viewport
  // edge would over-reserve by however tall that strip is, leaving a dead
  // gap between the board and the dialog even once the overlap is cleared.
  private syncBoardClearance(): void {
    const root = document.documentElement;
    if (this.modal.isOpen()) {
      const stageBottom = this.gameStage?.getBoundingClientRect().bottom ?? window.innerHeight;
      const panelTop = this.panel.getBoundingClientRect().top;
      const clearance = Math.max(0, stageBottom - panelTop + 8);
      root.style.setProperty('--rewind-dialog-clearance', `${clearance}px`);
      root.classList.add('rewind-dialog-open');
    } else {
      root.classList.remove('rewind-dialog-open');
    }
    this.onLayoutChange?.();
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
