import type { MultiplayerLocalResult } from '../shared/multiplayer-contracts.js';
import type { MultiplayerCompatibilityError, MultiplayerPhase } from '../app/multiplayer-view-types.js';
import { assertNever } from './dom-utils.js';

/**
 * Status/timer/result formatting genuinely shared by MultiplayerHud (Score
 * Race) and SharedBoardHud (Disco Duel). Mode-specific presentation —
 * Score Race's opponent-progress text, Disco Duel's turn-ownership
 * announcement — stays local to each HUD.
 */

export function statusText(
  phase: MultiplayerPhase,
  error: MultiplayerCompatibilityError | null,
): string {
  if (error !== null) {
    switch (error) {
      case 'protocol-mismatch': return 'CLIENT UPDATE REQUIRED';
      case 'rules-mismatch': return 'RULES VERSION MISMATCH';
      case 'session-mismatch': return 'MATCH RULES MISMATCH';
      case 'invalid-message': return 'INVALID SERVER MESSAGE';
      default: return assertNever(error, 'multiplayer-hud-format: statusText error');
    }
  }
  switch (phase) {
    case 'lobby': return 'LOBBY';
    case 'ready': return 'READY';
    case 'countdown': return 'STARTING';
    case 'playing': return 'LIVE';
    case 'finished': return 'COMPLETE';
    case 'disconnected': return 'OFFLINE';
    case 'reconnecting': return 'REJOINING';
    default: return assertNever(phase, 'multiplayer-hud-format: statusText phase');
  }
}

export function timerLabelText(phase: MultiplayerPhase): string {
  return phase === 'countdown' ? 'STARTS IN' : phase === 'playing' ? 'TIME LEFT' : 'TIME';
}

export function timerText(phase: MultiplayerPhase, remainingMs: number | null): string {
  if (remainingMs === null) return '—';
  if (phase === 'countdown') return String(Math.max(1, Math.ceil(remainingMs / 1_000)));
  if (phase !== 'playing') return '0:00';
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return `${minutes}:${seconds}`;
}

export function resultText(result: MultiplayerLocalResult | null): string {
  if (!result) return '';
  const label = result.outcome === 'win' ? 'YOU WIN' : result.outcome === 'loss' ? 'YOU LOSE' : 'TIE';
  return `${label} · ${result.localScore.toLocaleString('en-US')}–${result.opponentScore.toLocaleString('en-US')}`;
}
