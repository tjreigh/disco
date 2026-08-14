import { sameMultiplayerModeIdentity } from '../shared/multiplayer-contracts.js';
import type { MultiplayerModeIdentity } from '../shared/multiplayer-contracts.js';
import type { MultiplayerAdmission } from '../platform/multiplayer-api-client.js';

const ADMISSION_STORAGE_PREFIX = 'disco_multiplayer_admission:';

// Mode-scoped keys prevent rooms from different games colliding.
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

/** Returns a matching retained admission and removes malformed or stale data. */
export function readAdmission(
  expectedMode: MultiplayerModeIdentity,
  roomId: string,
): MultiplayerAdmission | null {
  let raw: string | null;
  try {
    raw = sessionStorage.getItem(storageKey(expectedMode.id, roomId));
  } catch {
    return null;
  }
  if (!raw) return null;

  try {
    const value: unknown = JSON.parse(raw);
    if (isAdmissionFor(value, expectedMode) && value.roomId === roomId) return value;
  } catch {
    // Invalid retained JSON is handled like any other stale value below.
  }
  forgetAdmission(expectedMode, roomId);
  return null;
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

/** Builds a self-describing private-room invite link. */
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
