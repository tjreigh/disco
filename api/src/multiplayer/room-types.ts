import type {
  MultiplayerModeIdentity,
  MultiplayerServerMessage,
  RoomServiceErrorCode,
} from './contracts.js';

/**
 * Structural types shared by every per-mode room service
 * (ScoreRaceRoomService, SharedBoardRoomService, ...) and the gateway that
 * routes to them. Room-service *behavior* (lifecycle state, message
 * builders, broadcast) stays mode-specific — see room-service.ts and
 * shared-board-room-service.ts — only the request/result/delivery shapes
 * live here.
 */

export interface RoomClock {
  now(): number;
}

export interface RoomValueFactory {
  createRoomId(): string;
  createPlayerId(): string;
  createReconnectCredential(): string;
  createMatchId(): string;
  createSeed(): number;
}

/**
 * Claims room ids out of one namespace shared by every room service, so two
 * modes can never end up owning the same id at once. `claim` retries the
 * given candidate generator (typically a RoomValueFactory's createRoomId)
 * until it produces an id no other claim currently holds. `release` frees a
 * claim once its owning service reports the room expired — see
 * createRoomIdAllocator in room-values.ts.
 */
export interface RoomIdAllocator {
  claim(generateCandidate: () => string): string;
  release(roomId: string): void;
}

export interface RoomAdmissionRequest {
  readonly protocolVersion: number;
  readonly mode: MultiplayerModeIdentity;
}

export interface RoomJoinRequest extends RoomAdmissionRequest {
  readonly roomId: string;
}

export interface RoomAdmission {
  readonly roomId: string;
  readonly playerId: string;
  readonly reconnectCredential: string;
  readonly mode: MultiplayerModeIdentity;
}

/**
 * Opaque handle owned by a transport adapter. A reconnect replaces the active
 * handle, so a late close or message from the old socket cannot affect the player.
 */
export interface RoomConnection {
  readonly roomId: string;
  readonly playerId: string;
}

export interface RoomConnectRequest {
  readonly roomId: string;
  readonly playerId: string;
  readonly reconnectCredential: string;
}

export interface RoomDelivery {
  readonly playerId: string;
  readonly message: MultiplayerServerMessage;
}

/** Canonical name for the runtime-validated error-code union (see src/shared/multiplayer-contracts.ts). */
export type RoomServiceError = RoomServiceErrorCode;

/**
 * A recoverable failure always carries at least one delivery: the corrective
 * snapshot sent back to the requesting player so a benign race (late cursor
 * move, duplicate drop, stale match ID, ...) can resync instead of losing the
 * connection. See room-gateway.ts, which closes the socket only for `fatal`.
 */
export type RoomServiceFailure =
  | {
    readonly ok: false;
    readonly disposition: 'fatal';
    readonly error: RoomServiceError;
    readonly deliveries: readonly RoomDelivery[];
  }
  | {
    readonly ok: false;
    readonly disposition: 'recoverable';
    readonly error: RoomServiceError;
    readonly deliveries: readonly [RoomDelivery, ...RoomDelivery[]];
  };

export type RoomServiceResult<T> =
  | {
    readonly ok: true;
    readonly value: T;
    readonly deliveries: readonly RoomDelivery[];
  }
  | RoomServiceFailure;

export interface RoomTickResult {
  readonly deliveries: readonly RoomDelivery[];
  readonly expiredRoomIds: readonly string[];
}
