import {
  createHash,
  randomBytes,
  randomInt,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import {
  determineScoreRaceResult,
  multiplayerModeIdentity,
  MULTIPLAYER_PROTOCOL_VERSION,
  sameMultiplayerModeIdentity,
  SHARED_DUEL_DISRUPTION_THRESHOLD,
  SHARED_DUEL_MODE_ID,
  SHARED_DUEL_MODE_VERSION,
  SHARED_DUEL_RULES_VERSION,
  SHARED_DUEL_TURN_TIMEOUT_MS,
} from './contracts.js';
import type {
  MultiplayerClientMessage,
  MultiplayerMatchResult,
  MultiplayerModeIdentity,
  MultiplayerServerMessage,
} from './contracts.js';
import { SharedBoardMatch } from './shared-board-match.js';
import type {
  RoomAdmissionRequest,
  RoomClock,
  RoomConnectRequest,
  RoomConnection,
  RoomDelivery,
  RoomJoinRequest,
  RoomServiceError,
  RoomServiceResult,
  RoomTickResult,
  RoomValueFactory,
} from './room-service.js';

const ROOM_ID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ROOM_ID_LENGTH = 8;
const DEFAULT_COUNTDOWN_MS = 3_000;
const DEFAULT_LOBBY_TTL_MS = 30 * 60 * 1_000;
const DEFAULT_RESULT_TTL_MS = 5 * 60 * 1_000;

export const SHARED_DUEL_ROOM_MODE = multiplayerModeIdentity({
  id: SHARED_DUEL_MODE_ID,
  version: SHARED_DUEL_MODE_VERSION,
  rules: {
    id: SHARED_DUEL_MODE_ID,
    version: SHARED_DUEL_RULES_VERSION,
  },
});

export interface SharedBoardRoomServiceOptions {
  readonly clock: RoomClock;
  readonly values?: RoomValueFactory;
  readonly countdownMs?: number;
  readonly lobbyTtlMs?: number;
  readonly resultTtlMs?: number;
  readonly turnTimeoutMs?: number;
  readonly disruptionThreshold?: number;
}

interface RoomPlayer {
  readonly id: string;
  readonly credentialDigest: Buffer;
  ready: boolean;
  connection: RoomConnection | null;
}

interface DuelMatch {
  readonly id: string;
  readonly match: SharedBoardMatch;
  readonly startsAt: number;
}

type DuelRoomLifecycle =
  | { readonly kind: 'lobby'; expiresAt: number }
  | { readonly kind: 'countdown'; readonly match: DuelMatch; readonly playerOrder: readonly [string, string] }
  | { readonly kind: 'playing'; readonly match: DuelMatch; readonly playerOrder: readonly [string, string] }
  | { readonly kind: 'complete'; readonly match: DuelMatch; readonly result: MultiplayerMatchResult; expiresAt: number };

interface DuelRoom {
  readonly id: string;
  readonly players: RoomPlayer[];
  lifecycle: DuelRoomLifecycle;
}

const defaultValues: RoomValueFactory = {
  createRoomId: () => {
    let id = '';
    for (let index = 0; index < ROOM_ID_LENGTH; index++) {
      id += ROOM_ID_ALPHABET[randomInt(ROOM_ID_ALPHABET.length)];
    }
    return id;
  },
  createPlayerId: () => randomUUID(),
  createReconnectCredential: () => randomBytes(32).toString('base64url'),
  createMatchId: () => randomUUID(),
  createSeed: () => randomBytes(4).readUInt32BE(0),
};

export class SharedBoardRoomService {
  private readonly rooms = new Map<string, DuelRoom>();
  private readonly clock: RoomClock;
  private readonly values: RoomValueFactory;
  private readonly countdownMs: number;
  private readonly lobbyTtlMs: number;
  private readonly resultTtlMs: number;
  private readonly turnTimeoutMs: number;
  private readonly disruptionThreshold: number;

  constructor(options: SharedBoardRoomServiceOptions) {
    this.clock = options.clock;
    this.values = options.values ?? defaultValues;
    this.countdownMs = options.countdownMs ?? DEFAULT_COUNTDOWN_MS;
    this.lobbyTtlMs = options.lobbyTtlMs ?? DEFAULT_LOBBY_TTL_MS;
    this.resultTtlMs = options.resultTtlMs ?? DEFAULT_RESULT_TTL_MS;
    this.turnTimeoutMs = options.turnTimeoutMs ?? SHARED_DUEL_TURN_TIMEOUT_MS;
    this.disruptionThreshold = options.disruptionThreshold ?? SHARED_DUEL_DISRUPTION_THRESHOLD;
  }

  createRoom(request: RoomAdmissionRequest): RoomServiceResult<RoomAdmission> {
    const compatibilityError = this.compatibilityError(request);
    if (compatibilityError) return { ok: false, error: compatibilityError, deliveries: [] };

    const roomId = this.createUniqueRoomId();
    const playerId = this.values.createPlayerId();
    const credential = this.values.createReconnectCredential();
    const digest = sha256Digest(credential);

    const room: DuelRoom = {
      id: roomId,
      players: [{ id: playerId, credentialDigest: digest, ready: false, connection: null }],
      lifecycle: { kind: 'lobby', expiresAt: this.clock.now() + this.lobbyTtlMs },
    };
    this.rooms.set(roomId, room);

    return {
      ok: true,
      value: { roomId, playerId, reconnectCredential: credential, mode: SHARED_DUEL_ROOM_MODE },
      deliveries: [],
    };
  }

  joinRoom(request: RoomJoinRequest): RoomServiceResult<RoomAdmission> {
    const compatibilityError = this.compatibilityError(request);
    if (compatibilityError) return { ok: false, error: compatibilityError, deliveries: [] };

    const room = this.rooms.get(request.roomId);
    if (!room) return { ok: false, error: 'room-not-found', deliveries: [] };
    if (room.lifecycle.kind !== 'lobby' || room.players.length >= 2) {
      return { ok: false, error: 'room-full', deliveries: [] };
    }

    const playerId = this.values.createPlayerId();
    const credential = this.values.createReconnectCredential();
    const digest = sha256Digest(credential);

    room.players.push({ id: playerId, credentialDigest: digest, ready: false, connection: null });
    this.touchReadyRoom(room);
    return {
      ok: true,
      value: { roomId: room.id, playerId, reconnectCredential: credential, mode: SHARED_DUEL_ROOM_MODE },
      deliveries: [],
    };
  }

  connect(request: RoomConnectRequest): RoomServiceResult<RoomConnection> {
    const room = this.rooms.get(request.roomId);
    if (!room) return { ok: false, error: 'room-not-found', deliveries: [] };
    const player = room.players.find(p => p.id === request.playerId);
    if (!player || !credentialMatches(request.reconnectCredential, player.credentialDigest)) {
      return { ok: false, error: 'invalid-credential', deliveries: [] };
    }

    const deliveries = this.advanceRoom(room);
    const connection: RoomConnection = Object.freeze({ roomId: room.id, playerId: player.id });
    player.connection = connection;
    this.touchReadyRoom(room);
    const snapshot = room.lifecycle.kind === 'lobby'
      ? this.roomStateDeliveries(room)
      : this.snapshotDeliveries(room, player);
    return { ok: true, value: connection, deliveries: [...deliveries, ...snapshot] };
  }

  disconnect(connection: RoomConnection): readonly RoomDelivery[] {
    const active = this.activePlayer(connection);
    if (!active) return [];
    active.player.connection = null;
    if (active.room.lifecycle.kind === 'lobby' || active.room.lifecycle.kind === 'complete') {
      active.player.ready = false;
      return this.roomStateDeliveries(active.room);
    }
    return [];
  }

  receive(connection: RoomConnection, message: MultiplayerClientMessage): RoomServiceResult<null> {
    const active = this.activePlayer(connection);
    if (!active) return { ok: false, error: 'stale-connection', deliveries: [] };
    const { room, player } = active;
    const deliveries = this.advanceRoom(room);
    if (message.protocolVersion !== MULTIPLAYER_PROTOCOL_VERSION) {
      return { ok: false, error: 'protocol-mismatch', deliveries };
    }
    if (message.roomId !== room.id || message.playerId !== player.id) {
      return { ok: false, error: 'stale-connection', deliveries };
    }

    switch (message.type) {
      case 'set-ready':
        return this.setReady(room, player, message.ready, deliveries);
      case 'play-turn':
        return this.playTurn(room, player, message.matchId, message.column, deliveries);
      default:
        return { ok: false, error: 'invalid-state', deliveries };
    }
  }

  tick(): RoomTickResult {
    const deliveries: RoomDelivery[] = [];
    const expiredRoomIds: string[] = [];
    const now = this.clock.now();
    for (const room of this.rooms.values()) {
      if (isExpired(room, now)) {
        this.rooms.delete(room.id);
        expiredRoomIds.push(room.id);
        continue;
      }
      deliveries.push(...this.advanceRoom(room));
    }
    return { deliveries, expiredRoomIds };
  }

  private setReady(room: DuelRoom, player: RoomPlayer, ready: boolean, priorDeliveries: RoomDelivery[]): RoomServiceResult<null> {
    if (room.lifecycle.kind !== 'lobby' && room.lifecycle.kind !== 'complete') {
      return { ok: false, error: 'invalid-state', deliveries: priorDeliveries };
    }
    player.ready = ready;
    this.touchReadyRoom(room);
    const deliveries = [...priorDeliveries, ...this.roomStateDeliveries(room)];
    if (room.players.length === 2 && room.players.every(p => p.ready)) {
      const now = this.clock.now();
      const startsAt = now + this.countdownMs;
      const matchId = this.values.createMatchId();
      const seed = this.values.createSeed();
      const playerIds = room.players.map(p => p.id) as [string, string];

      const boardMatch = new SharedBoardMatch({
        matchId,
        playerIds,
        seed,
        turnTimeoutMs: this.turnTimeoutMs,
        disruptionThreshold: this.disruptionThreshold,
      });
      boardMatch.setTurnTimer(startsAt);

      const duelMatch: DuelMatch = { id: matchId, match: boardMatch, startsAt };
      const playerOrder = playerIds;
      room.lifecycle = { kind: 'countdown', match: duelMatch, playerOrder };
      deliveries.push(...this.broadcast(room, () => this.countdownMessage(room, duelMatch)));
    }
    return { ok: true, value: null, deliveries };
  }

  private playTurn(room: DuelRoom, player: RoomPlayer, matchId: string, column: number, priorDeliveries: RoomDelivery[]): RoomServiceResult<null> {
    if (room.lifecycle.kind !== 'playing') {
      return { ok: false, error: 'invalid-state', deliveries: priorDeliveries };
    }
    if (matchId !== room.lifecycle.match.id) {
      return { ok: false, error: 'match-mismatch', deliveries: priorDeliveries };
    }

    const match = room.lifecycle.match.match;
    const result = match.processTurn(player.id, column);

    if (result.kind === 'rejected') {
      return { ok: false, error: 'invalid-state', deliveries: priorDeliveries };
    }

    match.setTurnTimer(this.clock.now());
    const deliveries = [...priorDeliveries];
    const turnWireResult = {
      playerId: result.playerId,
      column: result.column,
      triggerScoreDelta: result.triggerScoreDelta,
      opponentScoreDelta: result.opponentScoreDelta,
      stackSize: result.stackSize,
      steps: result.steps,
      gameOver: result.gameOver,
      ...(result.gameOver && result.gameOverReason ? { gameOverReason: result.gameOverReason } : {}),
    };

    if (result.gameOver) {
      room.lifecycle = this.finalizeMatch(room);
      deliveries.push(...this.broadcast(room, () =>
        match.buildTurnPlayedMessage(room.id, SHARED_DUEL_ROOM_MODE, matchId, turnWireResult as never),
      ));
      deliveries.push(...this.broadcast(room, () =>
        this.finishedMessage(room, matchId, room.lifecycle as { kind: 'complete'; result: MultiplayerMatchResult }),
      ));
    } else {
      deliveries.push(...this.broadcast(room, () =>
        match.buildTurnPlayedMessage(room.id, SHARED_DUEL_ROOM_MODE, matchId, turnWireResult as never),
      ));
      deliveries.push(...this.broadcast(room, () =>
        match.buildTurnAssignedMessage(room.id, SHARED_DUEL_ROOM_MODE, matchId),
      ));
    }

    return { ok: true, value: null, deliveries };
  }

  private advanceRoom(room: DuelRoom): RoomDelivery[] {
    const now = this.clock.now();
    const lifecycle = room.lifecycle;

    if (lifecycle.kind === 'countdown' && now >= lifecycle.match.startsAt) {
      const match = lifecycle.match.match;
      match.setTurnTimer(now);
      room.lifecycle = { kind: 'playing', match: lifecycle.match, playerOrder: lifecycle.playerOrder };
      return this.broadcast(room, () =>
        match.buildTurnAssignedMessage(room.id, SHARED_DUEL_ROOM_MODE, lifecycle.match.id),
      );
    }

    if (lifecycle.kind === 'playing') {
      if (lifecycle.match.match.isTurnExpired(now)) {
        const match = lifecycle.match.match;
        const result = match.expireTurn();

        if (result.kind === 'accepted') {
          const turnWireResult = {
            playerId: result.playerId,
            column: result.column,
            triggerScoreDelta: result.triggerScoreDelta,
            opponentScoreDelta: result.opponentScoreDelta,
            stackSize: result.stackSize,
            steps: result.steps,
            gameOver: result.gameOver,
            ...(result.gameOver && result.gameOverReason ? { gameOverReason: result.gameOverReason } : {}),
          };
          match.setTurnTimer(now);

          const deliveries: RoomDelivery[] = [];
          deliveries.push(...this.broadcast(room, () =>
            match.buildTurnExpiredMessage(room.id, SHARED_DUEL_ROOM_MODE, lifecycle.match.id, turnWireResult as never),
          ));

          if (result.gameOver) {
            room.lifecycle = this.finalizeMatch(room);
            deliveries.push(...this.broadcast(room, () =>
              this.finishedMessage(room, lifecycle.match.id, room.lifecycle as { kind: 'complete'; result: MultiplayerMatchResult }),
            ));
          } else {
            deliveries.push(...this.broadcast(room, () =>
              match.buildTurnAssignedMessage(room.id, SHARED_DUEL_ROOM_MODE, lifecycle.match.id),
            ));
          }
          return deliveries;
        }
      }
    }

    return [];
  }

  private finalizeMatch(room: DuelRoom): DuelRoomLifecycle & { kind: 'complete'; result: MultiplayerMatchResult } {
    const lifecycle = room.lifecycle;
    if (lifecycle.kind !== 'playing' && lifecycle.kind !== 'countdown') {
      throw new Error('Cannot finalize a match that is not active');
    }
    const match = lifecycle.match.match;
    const firstId = lifecycle.playerOrder[0]!;
    const secondId = lifecycle.playerOrder[1]!;
    const result = determineScoreRaceResult(
      firstId,
      match.getScore(firstId),
      secondId,
      match.getScore(secondId),
    );
    for (const player of room.players) player.ready = false;
    return {
      kind: 'complete',
      match: lifecycle.match,
      result,
      expiresAt: this.clock.now() + this.resultTtlMs,
    };
  }

  private snapshotDeliveries(room: DuelRoom, player: RoomPlayer): RoomDelivery[] {
    const lifecycle = room.lifecycle;
    if (lifecycle.kind === 'lobby') {
      return [{ playerId: player.id, message: this.roomStateMessage(room, player) }];
    }
    const deliveries: RoomDelivery[] = [{
      playerId: player.id,
      message: this.countdownMessage(room, lifecycle.match),
    }];
    if (lifecycle.kind === 'playing') {
      deliveries.push({
        playerId: player.id,
        message: lifecycle.match.match.buildTurnAssignedMessage(
          room.id, SHARED_DUEL_ROOM_MODE, lifecycle.match.id,
        ),
      });
    }
    if (lifecycle.kind === 'complete') {
      deliveries.push({
        playerId: player.id,
        message: this.finishedMessage(room, lifecycle.match.id, lifecycle),
      });
    }
    return deliveries;
  }

  private roomStateMessage(room: DuelRoom, player: RoomPlayer): MultiplayerServerMessage {
    const opponent = room.players.find(p => p !== player);
    return {
      protocolVersion: MULTIPLAYER_PROTOCOL_VERSION,
      roomId: room.id,
      mode: SHARED_DUEL_ROOM_MODE,
      type: 'room-state',
      localReady: player.ready,
      opponentReady: opponent?.ready ?? false,
    };
  }

  private countdownMessage(room: DuelRoom, duelMatch: DuelMatch): MultiplayerServerMessage {
    return {
      protocolVersion: MULTIPLAYER_PROTOCOL_VERSION,
      roomId: room.id,
      mode: SHARED_DUEL_ROOM_MODE,
      type: 'match-countdown',
      matchId: duelMatch.id,
      startsAt: duelMatch.startsAt,
      deadline: duelMatch.startsAt,
      seed: duelMatch.match.seed,
    };
  }

  private finishedMessage(room: DuelRoom, matchId: string, lifecycle: { kind: 'complete'; result: MultiplayerMatchResult }): MultiplayerServerMessage {
    return {
      protocolVersion: MULTIPLAYER_PROTOCOL_VERSION,
      roomId: room.id,
      mode: SHARED_DUEL_ROOM_MODE,
      type: 'match-finished',
      matchId,
      result: lifecycle.result,
    };
  }

  private roomStateDeliveries(room: DuelRoom): RoomDelivery[] {
    return room.players.map(player => ({
      playerId: player.id,
      message: this.roomStateMessage(room, player),
    }));
  }

  private broadcast(room: DuelRoom, factory: () => MultiplayerServerMessage): RoomDelivery[] {
    return room.players.map(player => ({
      playerId: player.id,
      message: factory(),
    }));
  }

  private activePlayer(connection: RoomConnection): { room: DuelRoom; player: RoomPlayer } | undefined {
    const room = this.rooms.get(connection.roomId);
    if (!room) return undefined;
    const player = room.players.find(p => p.id === connection.playerId && p.connection === connection);
    if (!player) return undefined;
    return { room, player };
  }

  private touchReadyRoom(room: DuelRoom): void {
    if (room.lifecycle.kind === 'lobby'
      && room.players.length === 2
      && room.players.every(p => p.ready)) {
      room.lifecycle.expiresAt = this.clock.now() + this.lobbyTtlMs;
    }
  }

  private createUniqueRoomId(): string {
    for (let attempt = 0; attempt < 10; attempt++) {
      const id = this.values.createRoomId();
      if (!this.rooms.has(id)) return id;
    }
    return this.values.createRoomId();
  }

  private compatibilityError(request: RoomAdmissionRequest): RoomServiceError | null {
    if (request.protocolVersion !== MULTIPLAYER_PROTOCOL_VERSION) {
      return 'protocol-mismatch';
    }
    return sameMultiplayerModeIdentity(request.mode, SHARED_DUEL_ROOM_MODE)
      ? null
      : 'mode-mismatch';
  }
}

interface RoomAdmission {
  readonly roomId: string;
  readonly playerId: string;
  readonly reconnectCredential: string;
  readonly mode: MultiplayerModeIdentity;
}

function isExpired(room: DuelRoom, now: number): boolean {
  const lifecycle = room.lifecycle;
  if (lifecycle.kind === 'lobby' || lifecycle.kind === 'complete') {
    return now >= lifecycle.expiresAt;
  }
  return false;
}

function sha256Digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

function credentialMatches(credential: string, digest: Buffer): boolean {
  return timingSafeEqual(sha256Digest(credential), digest);
}
