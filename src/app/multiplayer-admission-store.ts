import { sameMultiplayerModeIdentity } from '../shared/multiplayer-contracts.js';
import type { MultiplayerModeIdentity } from '../shared/multiplayer-contracts.js';
import type { MultiplayerAdmission } from '../platform/multiplayer-api-client.js';

const ADMISSION_STORAGE_PREFIX = 'disco_multiplayer_admission:';

// The expected mode id is part of the key (not just a post-read content
// check) so a Score Race admission and a Disco Duel admission can never
// collide under the same sessionStorage key even if their room ids ever
// did — belt-and-suspenders alongside the mode-identity check in
// readAdmission below.
function storageKey(modeId: string, roomId: string): string {
  return `${ADMISSION_STORAGE_PREFIX}${modeId}:${roomId}`;
}

/** Reconnect persistence is best-effort throughout this module; a failure never blocks the live socket. */
export function retainAdmission(
  expectedMode: MultiplayerModeIdentity,
  value: unknown,
): value is MultiplayerAdmission {
  if (!isAdmissionFor(value, expectedMode)) return false;
  try {
    sessionStorage.setItem(
      storageKey(expectedMode.id, value.roomId),
      JSON.stringify(value),
    );
  } catch {
    // Storage may be full or unavailable (private browsing) — nothing to recover.
  }
  return true;
}

/**
 * Returns a retained admission only if it matches both the requested room
 * and the caller's expected mode identity. Any other stored value —
 * malformed, wrong room, or a different mode entirely — is treated as
 * absent and removed rather than silently ignored.
 */
export function readAdmission(
  expectedMode: MultiplayerModeIdentity,
  roomId: string,
): MultiplayerAdmission | null {
  try {
    const raw = sessionStorage.getItem(storageKey(expectedMode.id, roomId));
    if (!raw) return null;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      forgetAdmission(expectedMode, roomId);
      return null;
    }
    if (!isAdmissionFor(value, expectedMode) || value.roomId !== roomId) {
      forgetAdmission(expectedMode, roomId);
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

export function forgetAdmission(expectedMode: MultiplayerModeIdentity, roomId: string): void {
  try {
    sessionStorage.removeItem(storageKey(expectedMode.id, roomId));
  } catch {
    // Ignore storage restrictions.
  }
}

function isAdmissionFor(
  value: unknown,
  expectedMode: MultiplayerModeIdentity,
): value is MultiplayerAdmission {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const admission = value as Record<string, unknown>;
  const mode = admission.mode as Record<string, unknown> | null;
  const rules = mode?.rules as Record<string, unknown> | null;
  return isNonEmptyString(admission.roomId)
    && isNonEmptyString(admission.playerId)
    && isNonEmptyString(admission.reconnectCredential)
    && typeof mode?.id === 'string'
    && typeof mode.version === 'number'
    && typeof rules?.id === 'string'
    && typeof rules.version === 'number'
    && sameMultiplayerModeIdentity(mode as unknown as MultiplayerModeIdentity, expectedMode);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Builds the shareable invite link for a private room. The mode is required
 * so every link is self-describing and routing never depends on an implicit
 * default multiplayer mode.
 */
export function privateRoomUrl(
  roomId: string,
  modeId: MultiplayerModeIdentity['id'],
): string {
  const url = new URL(location.href);
  url.search = '';
  url.searchParams.set('room', roomId);
  url.searchParams.set('mode', modeId);
  url.hash = '';
  return url.toString();
}

export function admissionErrorText(error: unknown): string {
  if (error instanceof Error && error.message === 'missing-room') {
    return 'The private room link is missing a room code.';
  }
  if (typeof error === 'object' && error !== null && 'status' in error) {
    const status = (error as { status?: unknown }).status;
    if (status === 404) return 'This private room no longer exists.';
    if (status === 409) return 'This private room is full or uses a different game version.';
    if (status === 429) return 'Too many room attempts. Wait a moment and try again.';
  }
  return 'Could not reach the multiplayer service. Return home and try again.';
}
