import type {
  MultiplayerCompatibilityError,
  MultiplayerLocalPhase,
} from '../app/multiplayer-session-controller.js';
import type {
  MultiplayerPlayerProgress,
  MultiplayerLocalResult,
} from '../shared/multiplayer-contracts.js';
import { resultText, statusText, timerLabelText, timerText } from './multiplayer-hud-format.js';
import { cloneTemplate, mustQuery } from './dom-utils.js';

export interface MultiplayerHudView {
  readonly phase: MultiplayerLocalPhase;
  readonly remainingMs: number | null;
  readonly localScore: number;
  readonly opponent: MultiplayerPlayerProgress | null;
  readonly result: MultiplayerLocalResult | null;
  readonly compatibilityError: MultiplayerCompatibilityError | null;
}

/** Score/status-only multiplayer chrome; the local board remains the primary view. */
export class MultiplayerHud {
  private readonly root: HTMLElement;
  private readonly status: HTMLElement;
  private readonly localValue: HTMLElement;
  private readonly timerLabel: HTMLElement;
  private readonly timer: HTMLElement;
  private readonly opponentValue: HTMLElement;
  private readonly result: HTMLElement;

  constructor(mount: HTMLElement = document.body) {
    const fragment = cloneTemplate('tpl-multiplayer-hud');
    this.root = mustQuery(fragment, '.multiplayer-hud');
    this.status = mustQuery(fragment, '.multiplayer-hud__status');
    this.localValue = mustQuery(fragment, '.multiplayer-hud__local-value');
    this.timerLabel = mustQuery(fragment, '.multiplayer-hud__timer-label');
    this.timer = mustQuery(fragment, '.multiplayer-hud__timer');
    this.opponentValue = mustQuery(fragment, '.multiplayer-hud__opponent-value');
    this.result = mustQuery(fragment, '.multiplayer-hud__result');

    mount.append(fragment);
  }

  render(view: MultiplayerHudView): void {
    this.status.textContent = statusText(view.phase, view.compatibilityError);
    this.localValue.textContent = view.localScore.toLocaleString('en-US');
    this.timerLabel.textContent = timerLabelText(view.phase);
    this.timer.textContent = timerText(view.phase, view.remainingMs);
    this.opponentValue.textContent = opponentText(view.opponent);
    this.result.textContent = resultText(view.result);
    this.result.hidden = view.result === null;
    this.root.dataset.result = String(view.result !== null);
  }

  destroy(): void {
    this.root.remove();
  }
}

/** Score Race-only: Disco Duel has no independent opponent-progress record. */
function opponentText(progress: MultiplayerPlayerProgress | null): string {
  if (!progress) return 'WAITING';
  return `${progress.score.toLocaleString('en-US')}${progress.finished ? ' · DONE' : ''}`;
}
