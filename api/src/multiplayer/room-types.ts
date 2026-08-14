import type {
  MultiplayerModeIdentity,
  MultiplayerServerMessage,
  RoomServiceErrorCode,
} from './contracts.js';

/** Transport-neutral shapes shared by room services and their gateway. */

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

/** Coordinates one room-id namespace across all multiplayer modes. */
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

export type RoomServiceError = RoomServiceErrorCode;

/**
 * Recoverable failures carry a corrective delivery so the requester can
 * resynchronize without losing its connection.
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
