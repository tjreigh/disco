import type { SaveGameV1 } from '../game/save.js';
import type { SoloModeDefinition } from '../game/modes/mode.js';
import { ModalController } from './modal-controller.js';

export type SavedGameConflictSide = SaveGameV1 | null;

/** Modal decision UI for a mode's local and cloud autosaves. */
export class SavedGameDialog {
  private readonly root: HTMLElement;
  private readonly panel: HTMLElement;
  private readonly title: HTMLElement;
  private readonly description: HTMLElement;
  private readonly modal: ModalController;
  private primaryFocus: HTMLElement | null = null;

  onResume?: (save: SaveGameV1) => void;
  onStartNew?: () => void;
  onChooseLocal?: (save: SavedGameConflictSide) => void;
  onChooseCloud?: (save: SavedGameConflictSide) => void;
  onCancel?: () => void;

  constructor(
    mount: HTMLElement = document.body,
    modalBackground: readonly HTMLElement[] = [],
  ) {
    const id = `saved-game-dialog-${SavedGameDialog.nextId++}`;

    this.root = document.createElement('section');
    this.root.className = 'saved-game-dialog';
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-modal', 'true');
    this.root.setAttribute('aria-labelledby', `${id}-title`);
    this.root.setAttribute('aria-describedby', `${id}-description`);
    this.root.setAttribute('aria-hidden', 'true');

    this.panel = document.createElement('div');
    this.panel.className = 'saved-game-dialog__panel';

    this.title = document.createElement('h2');
    this.title.id = `${id}-title`;

    this.description = document.createElement('p');
    this.description.id = `${id}-description`;
    this.description.className = 'saved-game-dialog__description';

    this.panel.append(this.title, this.description);
    this.root.append(this.panel);
    mount.append(this.root);
    this.modal = new ModalController(this.root, {
      openClass: 'saved-game-dialog--open',
      initialFocus: () => this.primaryFocus,
      inertTargets: modalBackground,
      onEscape: () => this.cancel(),
    });
  }

  /** Shows the ordinary resume-or-replace decision for a valid save. */
  showSave(mode: SoloModeDefinition, save: SaveGameV1): void {
    this.prepareOpen();
    this.title.textContent = `CONTINUE ${mode.name.toUpperCase()}?`;
    this.description.textContent = 'A saved game is available for this mode.';

    const summary = this.createSummary(save, mode, 'Saved game');
    const actions = this.createActions();
    const resume = this.createButton('RESUME GAME', true, () => {
      this.finish(() => this.onResume?.(save));
    });
    actions.append(
      resume,
      this.createButton('START NEW GAME', false, () => {
        this.finish(() => this.onStartNew?.());
      }, true),
      this.createButton('CANCEL', false, () => this.cancel()),
    );
    this.panel.append(summary, actions);
    this.openAndFocus(resume);
  }

  /**
   * Shows independently changed device and cloud records. A null side is a
   * tombstone and is presented for context without an action to resume it.
   */
  showConflict(
    mode: SoloModeDefinition,
    local: SavedGameConflictSide,
    cloud: SavedGameConflictSide,
  ): void {
    this.prepareOpen();
    this.title.textContent = `TWO ${mode.name.toUpperCase()} SAVES FOUND`;
    this.description.textContent = 'Choose which saved game to keep, or start over.';

    const comparison = document.createElement('div');
    comparison.className = 'saved-game-dialog__comparison';
    comparison.append(
      this.createConflictCard('This Device', local, mode),
      this.createConflictCard('Cloud Save', cloud, mode),
    );

    const actions = this.createActions('saved-game-dialog__actions--conflict');
    let primary: HTMLButtonElement | null = null;
    if (local) {
      const chooseLocal = this.createButton('USE THIS DEVICE', true, () => {
        this.finish(() => this.onChooseLocal?.(local));
      });
      primary = chooseLocal;
      actions.append(chooseLocal);
    }
    if (cloud) {
      const chooseCloud = this.createButton('USE CLOUD SAVE', primary === null, () => {
        this.finish(() => this.onChooseCloud?.(cloud));
      });
      primary ??= chooseCloud;
      actions.append(chooseCloud);
    }
    const startNew = this.createButton('START NEW GAME', primary === null, () => {
      this.finish(() => this.onStartNew?.());
    }, true);
    primary ??= startNew;
    actions.append(startNew, this.createButton('CANCEL', false, () => this.cancel()));

    this.panel.append(comparison, actions);
    this.openAndFocus(primary);
  }

  /** Shows an explicit replacement decision for an incompatible cloud save. */
  showUnavailable(mode: SoloModeDefinition, local: SavedGameConflictSide = null): void {
    this.prepareOpen();
    this.title.textContent = `${mode.name.toUpperCase()} SAVE UNAVAILABLE`;
    this.description.textContent = 'The cloud save is incompatible with this version of the game and cannot be resumed.';

    const notice = document.createElement('p');
    notice.className = 'saved-game-dialog__notice';
    notice.textContent = 'Starting a new game will replace this saved game.';

    const actions = this.createActions();
    let primary: HTMLButtonElement | null = null;
    if (local) {
      const chooseLocal = this.createButton('USE THIS DEVICE', true, () => {
        this.finish(() => this.onChooseLocal?.(local));
      });
      primary = chooseLocal;
      actions.append(chooseLocal);
    }
    const startNew = this.createButton('START NEW GAME', primary === null, () => {
      this.finish(() => this.onStartNew?.());
    }, true);
    primary ??= startNew;
    actions.append(startNew, this.createButton('CANCEL', false, () => this.cancel()));
    this.panel.append(notice, actions);
    this.openAndFocus(primary);
  }

  hide(): void {
    this.modal.close();
    this.primaryFocus = null;
  }

  isOpen(): boolean {
    return this.modal.isOpen();
  }

  private static nextId = 1;

  private prepareOpen(): void {
    this.panel.replaceChildren(this.title, this.description);
  }

  private openAndFocus(primary: HTMLButtonElement): void {
    this.primaryFocus = primary;
    this.modal.open();
  }

  private cancel(): void {
    this.finish(() => this.onCancel?.());
  }

  private finish(callback: () => void): void {
    this.hide();
    callback();
  }

  private createSummary(
    save: SaveGameV1,
    mode: SoloModeDefinition,
    label: string,
  ): HTMLElement {
    const section = document.createElement('section');
    section.className = 'saved-game-dialog__summary';
    section.setAttribute('aria-label', label);

    const stats = document.createElement('dl');
    stats.className = 'saved-game-dialog__stats';
    this.appendStat(stats, 'Mode', mode.name);
    this.appendStat(stats, 'Score', save.state.score.toLocaleString('en-US'));
    this.appendStat(stats, 'Level', save.state.level.toLocaleString('en-US'));
    this.appendStat(stats, 'Turns played', save.state.dropCount.toLocaleString('en-US'));
    this.appendStat(
      stats,
      mode.rules.scoring.kind === 'stack-score@1' ? 'Best turn' : 'Best chain',
      mode.rules.scoring.kind === 'stack-score@1'
        ? `${save.session.longestStreak.toLocaleString('en-US')} cleared`
        : `${save.session.longestStreak.toLocaleString('en-US')} wave${save.session.longestStreak === 1 ? '' : 's'}`,
    );

    const lastPlayed = document.createElement('p');
    lastPlayed.className = 'saved-game-dialog__last-played';
    lastPlayed.textContent = 'Last played ';
    const time = document.createElement('time');
    const savedAt = new Date(save.savedAt);
    time.dateTime = savedAt.toISOString();
    time.textContent = new Intl.DateTimeFormat('en-US', {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(savedAt);
    lastPlayed.append(time);

    section.append(stats, lastPlayed);
    return section;
  }

  private createConflictCard(
    label: string,
    save: SavedGameConflictSide,
    mode: SoloModeDefinition,
  ): HTMLElement {
    const card = document.createElement('section');
    card.className = 'saved-game-dialog__save-card';
    const heading = document.createElement('h3');
    heading.textContent = label;
    card.append(heading);
    if (save) {
      card.append(this.createSummary(save, mode, `${label} details`));
    } else {
      card.classList.add('saved-game-dialog__save-card--empty');
      const empty = document.createElement('p');
      empty.textContent = 'No saved game';
      card.append(empty);
    }
    return card;
  }

  private appendStat(list: HTMLDListElement, label: string, value: string): void {
    const term = document.createElement('dt');
    term.textContent = label;
    const description = document.createElement('dd');
    description.textContent = value;
    list.append(term, description);
  }

  private createActions(modifier = ''): HTMLElement {
    const actions = document.createElement('div');
    actions.className = `saved-game-dialog__actions${modifier ? ` ${modifier}` : ''}`;
    return actions;
  }

  private createButton(
    label: string,
    primary: boolean,
    onClick: () => void,
    destructive = false,
  ): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = [
      'saved-game-dialog__button',
      primary ? 'saved-game-dialog__button--primary' : '',
      destructive ? 'saved-game-dialog__button--destructive' : '',
    ].filter(Boolean).join(' ');
    button.textContent = label;
    button.addEventListener('click', onClick);
    return button;
  }

}
