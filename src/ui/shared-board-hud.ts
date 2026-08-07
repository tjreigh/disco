import type { MultiplayerLocalResult } from '../shared/multiplayer-contracts.js';
import { cloneTemplate, mustQuery } from './dom-utils.js';

// Score Race and Disco Duel sessions both project a phase/compatibility-error
// shape close to this one, but Disco Duel's actual content differs (a turn
// indicator, no independent opponent-progress record) — so this stays its
// own local union rather than importing SharedBoardPhase /
// SharedBoardCompatibilityError from shared-board-session-controller.ts,
// mirroring the mode-agnostic precedent set by RoomOverlayView.
export type SharedBoardHudPhase =
  | 'lobby'
  | 'ready'
  | 'countdown'
  | 'playing'
  | 'finished'
  | 'disconnected'
  | 'reconnecting';

export type SharedBoardHudCompatibilityError =
  | 'invalid-message'
  | 'protocol-mismatch'
  | 'rules-mismatch'
  | 'session-mismatch';

export interface SharedBoardHudView {
  readonly phase: SharedBoardHudPhase;
  readonly remainingMs: number | null;
  readonly localScore: number;
  readonly opponentScore: number;
  readonly isMyTurn: boolean;
  readonly result: MultiplayerLocalResult | null;
  readonly compatibilityError: SharedBoardHudCompatibilityError | null;
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
    this.result = mustQuery(fragment, '.multiplayer-hud__result');

    this.modeLabelEl.textContent = this.modeLabel;
    mount.append(fragment);
  }

  render(view: SharedBoardHudView): void {
    this.status.textContent = statusText(view.phase, view.compatibilityError);
    this.localValue.textContent = view.localScore.toLocaleString('en-US');
    this.opponentValue.textContent = view.opponentScore.toLocaleString('en-US');
    this.turnAnnouncement.textContent = turnText(view.phase, view.isMyTurn);
    this.timerLabel.textContent = timerLabelText(view.phase);
    this.timer.textContent = timerText(view.phase, view.remainingMs);
    this.result.textContent = resultText(view.result);
    this.result.hidden = view.result === null;
    this.root.dataset.result = String(view.result !== null);
    this.root.dataset.turn = view.phase !== 'playing' ? 'none' : view.isMyTurn ? 'mine' : 'opponent';
  }

  destroy(): void {
    this.root.remove();
  }
}

function statusText(
  phase: SharedBoardHudPhase,
  error: SharedBoardHudCompatibilityError | null,
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

function turnText(phase: SharedBoardHudPhase, isMyTurn: boolean): string {
  if (phase !== 'playing') return '';
  return isMyTurn ? 'YOUR TURN' : "OPPONENT'S TURN";
}

function timerLabelText(phase: SharedBoardHudPhase): string {
  return phase === 'countdown' ? 'STARTS IN' : phase === 'playing' ? 'TIME LEFT' : 'TIME';
}

function timerText(phase: SharedBoardHudPhase, remainingMs: number | null): string {
  if (remainingMs === null) return '—';
  if (phase === 'countdown') return String(Math.max(1, Math.ceil(remainingMs / 1_000)));
  if (phase !== 'playing') return '0:00';
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return `${minutes}:${seconds}`;
}

function resultText(result: MultiplayerLocalResult | null): string {
  if (!result) return '';
  const label = result.outcome === 'win' ? 'YOU WIN' : result.outcome === 'loss' ? 'YOU LOSE' : 'TIE';
  return `${label} · ${result.localScore.toLocaleString('en-US')}–${result.opponentScore.toLocaleString('en-US')}`;
}
