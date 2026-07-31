import type { InputIntent } from '../platform/input-handler.js';
import { GamePhase } from '../game/state.js';
import { cloneTemplate, mustQuery } from './dom-utils.js';

export interface GameControlsState {
  phase: GamePhase;
  hasGravity: boolean;
  hasRewind?: boolean;
  canRewind?: boolean;
  cursorLane: number;
  laneCount: number;
  axis: 'col' | 'row';
  /** Gravity confirmation is disabled while no committable tilt exists. */
  canConfirmTilt?: boolean;
  /** No committable tilt exists yet — the ↺/↻ buttons pulse for attention. */
  needsTilt?: boolean;
  disabled?: boolean;
  isRewindPreview?: boolean;
}

/** Small, touch-friendly DOM controls that forward directly to InputIntent. */
export class GameControls {
  readonly root: HTMLElement;
  private readonly previousButton: HTMLButtonElement;
  private readonly dropButton: HTMLButtonElement;
  private readonly nextButton: HTMLButtonElement;
  private readonly counterClockwiseButton: HTMLButtonElement;
  private readonly clockwiseButton: HTMLButtonElement;
  private readonly cancelButton: HTMLButtonElement;
  private readonly confirmButton: HTMLButtonElement;
  private readonly rewindButton: HTMLButtonElement;
  private readonly onIntent: (intent: InputIntent) => void;

  constructor(onIntent: (intent: InputIntent) => void, container?: HTMLElement | null) {
    this.onIntent = onIntent;

    const fragment = cloneTemplate('tpl-game-controls');
    this.root = mustQuery(fragment, '.game-controls');
    this.previousButton = mustQuery(fragment, '[data-control="previous"]');
    this.dropButton = mustQuery(fragment, '[data-control="drop"]');
    this.nextButton = mustQuery(fragment, '[data-control="next"]');
    this.counterClockwiseButton = mustQuery(fragment, '[data-control="tilt-counter-clockwise"]');
    this.clockwiseButton = mustQuery(fragment, '[data-control="tilt-clockwise"]');
    this.cancelButton = mustQuery(fragment, '[data-control="cancel"]');
    this.confirmButton = mustQuery(fragment, '[data-control="confirm"]');
    this.rewindButton = mustQuery(fragment, '[data-control="rewind"]');

    this.previousButton.addEventListener('click', () => {
      this.onIntent({ kind: 'move', col: this.lastState.cursorLane - 1 });
    });
    this.dropButton.addEventListener('click', () => {
      this.onIntent({ kind: 'drop', col: this.lastState.cursorLane });
    });
    this.nextButton.addEventListener('click', () => {
      this.onIntent({ kind: 'move', col: this.lastState.cursorLane + 1 });
    });
    this.counterClockwiseButton.addEventListener('click', () => {
      this.onIntent({ kind: 'tilt', delta: -45 });
    });
    this.clockwiseButton.addEventListener('click', () => {
      this.onIntent({ kind: 'tilt', delta: 45 });
    });
    this.cancelButton.addEventListener('click', () => {
      this.onIntent({ kind: 'cancel' });
    });
    this.confirmButton.addEventListener('click', () => {
      this.onIntent({ kind: 'drop', col: this.lastState.cursorLane });
    });
    this.rewindButton.addEventListener('click', () => {
      this.onIntent({ kind: 'rewind' });
    });

    (container ?? document.querySelector<HTMLElement>('.shell-region--bottom') ?? document.body).append(fragment);
  }

  private lastState: GameControlsState = {
    phase: GamePhase.Menu,
    hasGravity: false,
    cursorLane: 0,
    laneCount: 1,
    axis: 'col',
  };

  render(state: GameControlsState): void {
    this.lastState = state;
    const waiting = state.phase === GamePhase.WaitingForDrop;
    const aiming = state.phase === GamePhase.Aiming && state.hasGravity;
    this.root.hidden = Boolean(state.isRewindPreview) || (!waiting && !aiming);
    this.root.dataset.rewindMode = String(Boolean(state.hasRewind));
    this.root.classList.toggle('game-controls--aiming', aiming);
    this.root.setAttribute('aria-hidden', String(this.root.hidden));

    const previousLabel = state.axis === 'row' ? 'Move to previous row' : 'Move to previous lane';
    const nextLabel = state.axis === 'row' ? 'Move to next row' : 'Move to next lane';
    this.setButtonLabel(this.previousButton, previousLabel);
    this.setButtonLabel(this.nextButton, nextLabel);
    this.previousButton.hidden = !waiting;
    this.nextButton.hidden = !waiting;
    this.previousButton.disabled = !waiting || state.cursorLane <= 0 || Boolean(state.disabled);
    this.nextButton.disabled = !waiting || state.cursorLane >= state.laneCount - 1 || Boolean(state.disabled);
    this.dropButton.hidden = !waiting;
    this.rewindButton.hidden = !waiting || !state.hasRewind;
    this.rewindButton.disabled = !waiting || !state.canRewind || Boolean(state.disabled);
    this.counterClockwiseButton.hidden = !aiming;
    this.clockwiseButton.hidden = !aiming;
    this.cancelButton.hidden = !aiming;
    this.confirmButton.hidden = !aiming;
    this.dropButton.disabled = !waiting || Boolean(state.disabled);
    this.counterClockwiseButton.disabled = !aiming || Boolean(state.disabled);
    this.clockwiseButton.disabled = !aiming || Boolean(state.disabled);
    // Guarded on `aiming` locally (not just the caller's needsTilt) so an
    // inconsistent caller can never decorate hidden Classic controls.
    const attention = aiming && Boolean(state.needsTilt) && !state.disabled;
    this.counterClockwiseButton.classList.toggle('game-control--attention', attention);
    this.clockwiseButton.classList.toggle('game-control--attention', attention);
    // Once the preview has a committable rotation, move attention away from
    // the tilt controls and onto the action that advances the turn. This is
    // deliberately "ready", not "correct": tutorial outcome rules are only
    // evaluated after the player commits.
    const confirmReady = aiming && state.canConfirmTilt === true && !state.disabled;
    this.confirmButton.classList.toggle('game-control--ready', confirmReady);
    this.cancelButton.disabled = !aiming || Boolean(state.disabled);
    this.confirmButton.disabled = !aiming || state.canConfirmTilt === false || Boolean(state.disabled);
  }

  destroy(): void {
    this.root.remove();
  }

  private setButtonLabel(button: HTMLButtonElement, label: string): void {
    button.setAttribute('aria-label', label);
    button.title = label;
  }
}
