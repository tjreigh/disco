import type { MultiplayerLocalResult } from '../shared/multiplayer-contracts.js';
import type { MultiplayerCompatibilityError, MultiplayerPhase } from '../app/multiplayer-view-types.js';
import { assertNever } from './dom-utils.js';

/** Status, timer, and result formatting shared by both multiplayer HUDs. */

export function statusText(
  phase: MultiplayerPhase,
  error: MultiplayerCompatibilityError | null,
  turnActivationPending = false,
  connectionStale = false,
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
  if (phase === 'playing' && connectionStale) return 'NO REPLY';
  if (phase === 'playing' && turnActivationPending) return 'SETTLING';
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

export function timerLabelText(
  phase: MultiplayerPhase, turnSubmissionPending = false, turnActivationPending = false,
): string {
  if (phase === 'playing' && turnSubmissionPending) return 'MOVE';
  return phase === 'countdown' ? 'STARTS IN' : phase === 'playing' ? 'TIME LEFT' : 'TIME';
}

// A submitted move leaves the old deadline stale until the server answers —
// showing a countdown (or a clamped 0:00) here reads as the game having
// hung, when the move actually already landed and is just in transit back.
export function timerText(
  phase: MultiplayerPhase, remainingMs: number | null,
  turnSubmissionPending = false, turnActivationPending = false, connectionStale = false,
): string {
  if (phase === 'playing' && turnSubmissionPending && connectionStale) return 'NO REPLY';
  if (phase === 'playing' && turnSubmissionPending) return 'SENT';
  if (phase === 'playing' && turnActivationPending) return '—';
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

/** Connection-health readout: a stale ping is a dropped-packet alert. */
export function pingText(pingMs: number | null, stale: boolean): string {
  if (stale) return 'NO REPLY';
  if (pingMs === null) return '—';
  return `${pingMs}ms`;
}
