import type {
  MultiplayerCompatibilityError,
  MultiplayerLocalPhase,
} from '../app/multiplayer-session-controller.js';
import type {
  MultiplayerPlayerProgress,
  MultiplayerLocalResult,
} from '../shared/multiplayer-contracts.js';
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

function statusText(
  phase: MultiplayerLocalPhase,
  error: MultiplayerCompatibilityError | null,
): string {
  if (error === 'protocol-mismatch') return 'CLIENT UPDATE REQUIRED';
  if (error === 'rules-mismatch') return 'RULES VERSION MISMATCH';
  if (error === 'session-mismatch') return 'MATCH RULES MISMATCH';
  if (error === 'invalid-message') return 'INVALID SERVER MESSAGE';
  switch (phase) {
    case 'lobby': return 'LOBBY';
    case 'ready': return 'READY';
    case 'countdown': return 'STARTING';
    case 'playing': return 'LIVE';
    case 'finished': return 'COMPLETE';
    case 'disconnected': return 'OFFLINE';
    case 'reconnecting': return 'REJOINING';
  }
}

function timerLabelText(phase: MultiplayerLocalPhase): string {
  return phase === 'countdown' ? 'STARTS IN' : phase === 'playing' ? 'TIME LEFT' : 'TIME';
}

function timerText(phase: MultiplayerLocalPhase, remainingMs: number | null): string {
  if (remainingMs === null) return '—';
  if (phase === 'countdown') return String(Math.max(1, Math.ceil(remainingMs / 1_000)));
  if (phase !== 'playing') return '0:00';
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return `${minutes}:${seconds}`;
}

function opponentText(progress: MultiplayerPlayerProgress | null): string {
  if (!progress) return 'WAITING';
  return `${progress.score.toLocaleString('en-US')}${progress.finished ? ' · DONE' : ''}`;
}

function resultText(result: MultiplayerLocalResult | null): string {
  if (!result) return '';
  const label = result.outcome === 'win' ? 'YOU WIN' : result.outcome === 'loss' ? 'YOU LOSE' : 'TIE';
  return `${label} · ${result.localScore.toLocaleString('en-US')}–${result.opponentScore.toLocaleString('en-US')}`;
}
