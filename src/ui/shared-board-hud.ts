import type { MultiplayerLocalResult } from '../shared/multiplayer-contracts.js';
import type { MultiplayerCompatibilityError, MultiplayerPhase } from '../app/multiplayer-view-types.js';
import { pingText, resultText, statusText, timerLabelText, timerText } from './multiplayer-hud-format.js';
import { cloneTemplate, mustQuery } from './dom-utils.js';

export interface SharedBoardHudView {
  readonly phase: MultiplayerPhase;
  readonly remainingMs: number | null;
  readonly localScore: number;
  readonly opponentScore: number;
  readonly isMyTurn: boolean;
  readonly turnSubmissionPending: boolean;
  readonly result: MultiplayerLocalResult | null;
  readonly compatibilityError: MultiplayerCompatibilityError | null;
  readonly pingMs: number | null;
  readonly connectionStale: boolean;
}

/** Score/turn/status-only Disco Duel chrome; the shared board remains the primary view. */
export class SharedBoardHud {
  private readonly root: HTMLElement;
  private readonly modeLabelEl: HTMLElement;
  private readonly status: HTMLElement;
  private readonly localValue: HTMLElement;
  private readonly opponentValue: HTMLElement;
  private readonly turnAnnouncement: HTMLElement;
  private readonly timerLabel: HTMLElement;
  private readonly timer: HTMLElement;
  private readonly pingValue: HTMLElement;
  private readonly result: HTMLElement;

  constructor(
    private readonly modeLabel: string = 'DISCO DUEL',
    mount: HTMLElement = document.body,
  ) {
    const fragment = cloneTemplate('tpl-shared-board-hud');
    this.root = mustQuery(fragment, '.multiplayer-hud');
    this.modeLabelEl = mustQuery(fragment, '.multiplayer-hud__mode-label');
    this.status = mustQuery(fragment, '.multiplayer-hud__status');
    this.localValue = mustQuery(fragment, '.multiplayer-hud__local-value');
    this.opponentValue = mustQuery(fragment, '.multiplayer-hud__opponent-value');
    this.turnAnnouncement = mustQuery(fragment, '.multiplayer-hud__turn-sr');
    this.timerLabel = mustQuery(fragment, '.multiplayer-hud__timer-label');
    this.timer = mustQuery(fragment, '.multiplayer-hud__timer');
    this.pingValue = mustQuery(fragment, '.multiplayer-hud__ping-value');
    this.result = mustQuery(fragment, '.multiplayer-hud__result');

    this.modeLabelEl.textContent = this.modeLabel;
    mount.append(fragment);
  }

  render(view: SharedBoardHudView): void {
    this.status.textContent = statusText(view.phase, view.compatibilityError);
    this.localValue.textContent = view.localScore.toLocaleString('en-US');
    this.opponentValue.textContent = view.opponentScore.toLocaleString('en-US');
    this.turnAnnouncement.textContent = turnText(view.phase, view.isMyTurn);
    this.timerLabel.textContent = timerLabelText(view.phase, view.turnSubmissionPending);
    this.timer.textContent = timerText(view.phase, view.remainingMs, view.turnSubmissionPending);
    this.pingValue.textContent = pingText(view.pingMs, view.connectionStale);
    this.pingValue.dataset.stale = String(view.connectionStale);
    this.result.textContent = resultText(view.result);
    this.result.hidden = view.result === null;
    this.root.dataset.result = String(view.result !== null);
    this.root.dataset.turn = view.phase !== 'playing' ? 'none' : view.isMyTurn ? 'mine' : 'opponent';
  }

  destroy(): void {
    this.root.remove();
  }
}

/** Disco Duel-only: Score Race has no per-turn ownership to announce. */
function turnText(phase: MultiplayerPhase, isMyTurn: boolean): string {
  if (phase !== 'playing') return '';
  return isMyTurn ? 'YOUR TURN' : "OPPONENT'S TURN";
}
