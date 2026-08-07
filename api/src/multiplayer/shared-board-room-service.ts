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
const DEFAULT_STATUS_PULSE_MS = 1_000;

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
  readonly statusPulseMs?: number;
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
  paused: { readonly by: string; readonly since: number } | null;
  /** Only broadcast duel-status delivery updates this — targeted (reconnect/recovery) status never postpones the periodic pulse owed to the room. */
  lastStatusBroadcastAt: number | null;
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
  private readonly statusPulseMs: number;

  constructor(options: SharedBoardRoomServiceOptions) {
    this.clock = options.clock;
    this.values = options.values ?? defaultValues;
    this.countdownMs = options.countdownMs ?? DEFAULT_COUNTDOWN_MS;
    this.lobbyTtlMs = options.lobbyTtlMs ?? DEFAULT_LOBBY_TTL_MS;
    this.resultTtlMs = options.resultTtlMs ?? DEFAULT_RESULT_TTL_MS;
    this.turnTimeoutMs = options.turnTimeoutMs ?? SHARED_DUEL_TURN_TIMEOUT_MS;
    this.disruptionThreshold = options.disruptionThreshold ?? SHARED_DUEL_DISRUPTION_THRESHOLD;
    this.statusPulseMs = options.statusPulseMs !== undefined
      ? requirePositiveDuration(options.statusPulseMs)
      : DEFAULT_STATUS_PULSE_MS;
  }

  createRoom(request: RoomAdmissionRequest): RoomServiceResult<RoomAdmission> {
    const compatibilityError = this.compatibilityError(request);
    if (compatibilityError) return fatal(compatibilityError, []);

    const roomId = this.createUniqueRoomId();
    const playerId = this.values.createPlayerId();
    const credential = this.values.createReconnectCredential();
    const digest = sha256Digest(credential);

    const room: DuelRoom = {
      id: roomId,
      players: [{ id: playerId, credentialDigest: digest, ready: false, connection: null }],
      lifecycle: { kind: 'lobby', expiresAt: this.clock.now() + this.lobbyTtlMs },
      paused: null,
      lastStatusBroadcastAt: null,
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
    if (compatibilityError) return fatal(compatibilityError, []);

    const room = this.rooms.get(request.roomId);
    if (!room) return fatal('room-not-found', []);
    if (room.lifecycle.kind !== 'lobby' || room.players.length >= 2) {
      return fatal('room-full', []);
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
    if (!room) return fatal('room-not-found', []);
    const player = room.players.find(p => p.id === request.playerId);
    if (!player || !credentialMatches(request.reconnectCredential, player.credentialDigest)) {
      return fatal('invalid-credential', []);
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
    // Dropping the pausing player's connection must not permanently freeze
    // the room for whoever's left — resume on their behalf, same as an
    // explicit resume request, rather than soft-locking the opponent.
    if (active.room.lifecycle.kind === 'playing'
      && active.room.paused
      && active.room.paused.by === active.player.id) {
      return this.resumeMatchClock(active.room, active.player.id, [], active.room.lifecycle.match.id);
    }
    return [];
  }

  receive(connection: RoomConnection, message: MultiplayerClientMessage): RoomServiceResult<null> {
    const active = this.activePlayer(connection);
    if (!active) return fatal('stale-connection', []);
    const { room, player } = active;
    const deliveries = this.advanceRoom(room);
    if (message.protocolVersion !== MULTIPLAYER_PROTOCOL_VERSION) {
      return fatal('protocol-mismatch', deliveries);
    }
    if (message.roomId !== room.id || message.playerId !== player.id) {
      return fatal('stale-connection', deliveries);
    }

    switch (message.type) {
      case 'set-ready':
        return this.setReady(room, player, message.ready, deliveries);
      case 'play-turn':
        return this.playTurn(room, player, message.matchId, message.column, deliveries);
      case 'move-cursor':
        return this.moveCursor(room, player, message.matchId, message.column, deliveries);
      case 'set-paused':
        return this.setPaused(room, player, message.matchId, message.paused, deliveries);
      case 'forfeit-match':
        return this.forfeitMatch(room, player, message.matchId, deliveries);
      default:
        // A message family belonging to a different multiplayer mode (e.g.
        // Score Race's publish-progress reaching a duel room) — fatal, not a
        // benign gameplay race.
        return fatal('invalid-state', deliveries);
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
      // A readiness toggle may have been coalesced while reconnecting, then
      // arrive after the room advanced out of the lobby. It is stale intent,
      // not a broken credential or protocol, so repair the client and keep
      // the socket alive.
      return recoverable('invalid-state', [...priorDeliveries, ...this.recoverySnapshot(room, player)]);
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
      return recoverable('invalid-state', [...priorDeliveries, ...this.recoverySnapshot(room, player)]);
    }
    if (matchId !== room.lifecycle.match.id) {
      return recoverable('match-mismatch', [...priorDeliveries, ...this.recoverySnapshot(room, player)]);
    }
    if (room.paused) {
      return recoverable('invalid-state', [...priorDeliveries, ...this.recoverySnapshot(room, player)]);
    }

    const duelMatch = room.lifecycle.match;
    const match = duelMatch.match;
    const result = match.processTurn(player.id, column);

    if (result.kind === 'rejected') {
      // Wrong player, duplicate/late drop, or an unavailable column — all
      // benign races the engine already rejected without mutating state.
      return recoverable('invalid-state', [...priorDeliveries, ...this.recoverySnapshot(room, player)]);
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
      deliveries.push(...this.broadcastDuelStatus(room, duelMatch));
    }

    return { ok: true, value: null, deliveries };
  }

  // Lightweight, non-authoritative: relays the active player's in-progress
  // column selection to their opponent so a ghost preview can track it live.
  // Only the currently active player's cursor is meaningful — the server
  // doesn't track a resting cursor for the player who isn't up.
  private moveCursor(room: DuelRoom, player: RoomPlayer, matchId: string, column: number, priorDeliveries: RoomDelivery[]): RoomServiceResult<null> {
    if (room.lifecycle.kind !== 'playing') {
      return recoverable('invalid-state', [...priorDeliveries, ...this.recoverySnapshot(room, player)]);
    }
    if (matchId !== room.lifecycle.match.id) {
      return recoverable('match-mismatch', [...priorDeliveries, ...this.recoverySnapshot(room, player)]);
    }
    if (room.paused) {
      return recoverable('invalid-state', [...priorDeliveries, ...this.recoverySnapshot(room, player)]);
    }
    if (!room.lifecycle.match.match.isCurrentPlayer(player.id)) {
      // Cursor move received after turn ownership already changed.
      return recoverable('invalid-state', [...priorDeliveries, ...this.recoverySnapshot(room, player)]);
    }

    room.lifecycle.match.match.setCursor(player.id, column);
    const deliveries = [...priorDeliveries, ...this.relayToOthers(room, player, () => ({
      protocolVersion: MULTIPLAYER_PROTOCOL_VERSION,
      roomId: room.id,
      mode: SHARED_DUEL_ROOM_MODE,
      type: 'opponent-cursor' as const,
      matchId,
      playerId: player.id,
      column,
    }))];
    return { ok: true, value: null, deliveries };
  }

  private setPaused(room: DuelRoom, player: RoomPlayer, matchId: string, paused: boolean, priorDeliveries: RoomDelivery[]): RoomServiceResult<null> {
    if (room.lifecycle.kind !== 'playing' || matchId !== room.lifecycle.match.id) {
      return recoverable('invalid-state', [...priorDeliveries, ...this.recoverySnapshot(room, player)]);
    }
    const duelMatch = room.lifecycle.match;
    if (paused) {
      if (room.paused) return { ok: true, value: null, deliveries: priorDeliveries };
      room.paused = { by: player.id, since: this.clock.now() };
      const deliveries = [
        ...priorDeliveries,
        ...this.broadcast(room, () =>
          this.pausedMessage(room, matchId, true, player.id, duelMatch.match.turnDeadline)),
        ...this.broadcastDuelStatus(room, duelMatch),
      ];
      return { ok: true, value: null, deliveries };
    }
    if (!room.paused) return { ok: true, value: null, deliveries: priorDeliveries };
    // Only the player who paused can resume — otherwise the other player
    // could unpause out from under someone who still has their menu open.
    // A raced resume from the wrong player is recoverable, not fatal.
    if (room.paused.by !== player.id) {
      return recoverable('invalid-state', [...priorDeliveries, ...this.recoverySnapshot(room, player)]);
    }
    const deliveries = this.resumeMatchClock(room, player.id, priorDeliveries, matchId);
    return { ok: true, value: null, deliveries };
  }

  private forfeitMatch(room: DuelRoom, player: RoomPlayer, matchId: string, priorDeliveries: RoomDelivery[]): RoomServiceResult<null> {
    if (room.lifecycle.kind !== 'playing' || matchId !== room.lifecycle.match.id) {
      // An old match ID on a match-scoped action, explicitly recoverable.
      return recoverable('invalid-state', [...priorDeliveries, ...this.recoverySnapshot(room, player)]);
    }
    const duelMatch = room.lifecycle.match;
    const opponent = room.players.find(p => p.id !== player.id);
    // A duel room always has exactly two players once playing; a missing
    // opponent here signals a genuine invariant violation, not a benign
    // race — fatal is the safer default.
    if (!opponent) return fatal('invalid-state', priorDeliveries);

    // A forfeit always hands the win to the opponent — unlike a normal
    // finish, the current score comparison is irrelevant to who won.
    const result: MultiplayerMatchResult = {
      winnerId: opponent.id,
      scores: [
        { playerId: player.id, score: duelMatch.match.getScore(player.id) },
        { playerId: opponent.id, score: duelMatch.match.getScore(opponent.id) },
      ],
      forfeitedBy: player.id,
    };
    room.paused = null;
    for (const roomPlayer of room.players) roomPlayer.ready = false;
    room.lifecycle = { kind: 'complete', match: duelMatch, result, expiresAt: this.clock.now() + this.resultTtlMs };

    const deliveries = [
      ...priorDeliveries,
      ...this.broadcast(room, () =>
        this.finishedMessage(room, matchId, room.lifecycle as { kind: 'complete'; result: MultiplayerMatchResult }),
      ),
    ];
    return { ok: true, value: null, deliveries };
  }

  private resumeMatchClock(room: DuelRoom, resumedBy: string, priorDeliveries: RoomDelivery[], matchId: string): RoomDelivery[] {
    if (!room.paused) return priorDeliveries;
    const elapsed = this.clock.now() - room.paused.since;
    let deadline = 0;
    const duelMatch = room.lifecycle.kind === 'playing' ? room.lifecycle.match : null;
    if (duelMatch) {
      duelMatch.match.shiftTurnTimer(elapsed);
      deadline = duelMatch.match.turnDeadline;
    }
    room.paused = null;
    const deliveries = [
      ...priorDeliveries,
      ...this.broadcast(room, () => this.pausedMessage(room, matchId, false, resumedBy, deadline)),
    ];
    if (duelMatch) {
      deliveries.push(...this.broadcastDuelStatus(room, duelMatch));
    }
    return deliveries;
  }

  private pausedMessage(
    room: DuelRoom,
    matchId: string,
    paused: boolean,
    pausedBy: string,
    deadline: number,
  ): MultiplayerServerMessage {
    return {
      protocolVersion: MULTIPLAYER_PROTOCOL_VERSION,
      roomId: room.id,
      mode: SHARED_DUEL_ROOM_MODE,
      type: 'match-paused',
      matchId,
      paused,
      pausedBy,
      deadline,
    };
  }

  private advanceRoom(room: DuelRoom): RoomDelivery[] {
    const now = this.clock.now();
    const lifecycle = room.lifecycle;
    const deliveries: RoomDelivery[] = [];

    if (lifecycle.kind === 'countdown' && now >= lifecycle.match.startsAt) {
      const match = lifecycle.match.match;
      match.setTurnTimer(now);
      room.lifecycle = { kind: 'playing', match: lifecycle.match, playerOrder: lifecycle.playerOrder };
      deliveries.push(...this.broadcast(room, () =>
        match.buildTurnAssignedMessage(room.id, SHARED_DUEL_ROOM_MODE, lifecycle.match.id),
      ));
      deliveries.push(...this.broadcastDuelStatus(room, lifecycle.match));
      return deliveries;
    }

    if (lifecycle.kind === 'playing') {
      if (!room.paused && lifecycle.match.match.isTurnExpired(now)) {
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

          deliveries.push(...this.broadcast(room, () =>
            match.buildTurnExpiredMessage(room.id, SHARED_DUEL_ROOM_MODE, lifecycle.match.id, turnWireResult as never),
          ));

          if (result.gameOver) {
            room.lifecycle = this.finalizeMatch(room);
            deliveries.push(...this.broadcast(room, () =>
              this.finishedMessage(room, lifecycle.match.id, room.lifecycle as { kind: 'complete'; result: MultiplayerMatchResult }),
            ));
            // Completed matches never receive a duel-status pulse — match-finished is their terminal recovery message.
            return deliveries;
          }

          deliveries.push(...this.broadcast(room, () =>
            match.buildTurnAssignedMessage(room.id, SHARED_DUEL_ROOM_MODE, lifecycle.match.id),
          ));
          deliveries.push(...this.broadcastDuelStatus(room, lifecycle.match));
        }
      }

      // Periodic pulse while playing, including while paused — the board is
      // frozen but the pulse still repairs missed pause/menu state. Runs
      // even on ticks that already broadcast above; the fresh
      // lastStatusBroadcastAt from that broadcast keeps this a no-op then.
      const dueSince = room.lastStatusBroadcastAt ?? -Infinity;
      if (now - dueSince >= this.statusPulseMs) {
        deliveries.push(...this.broadcastDuelStatus(room, lifecycle.match));
      }
    }

    return deliveries;
  }

  private broadcastDuelStatus(room: DuelRoom, duelMatch: DuelMatch): RoomDelivery[] {
    const now = this.clock.now();
    room.lastStatusBroadcastAt = now;
    return this.broadcast(room, () => duelMatch.match.buildDuelStatusMessage(
      room.id, SHARED_DUEL_ROOM_MODE, duelMatch.id, now,
      room.paused !== null, room.paused?.by ?? null, room.paused?.since ?? null,
    ));
  }

  private targetedDuelStatus(room: DuelRoom, duelMatch: DuelMatch, playerId: string): RoomDelivery[] {
    const now = this.clock.now();
    return [{
      playerId,
      message: duelMatch.match.buildDuelStatusMessage(
        room.id, SHARED_DUEL_ROOM_MODE, duelMatch.id, now,
        room.paused !== null, room.paused?.by ?? null, room.paused?.since ?? null,
      ),
    }];
  }

  /** The corrective snapshot sent back to a player whose action was rejected as recoverable, keyed by the room's current lifecycle. */
  private recoverySnapshot(room: DuelRoom, player: RoomPlayer): RoomDelivery[] {
    const lifecycle = room.lifecycle;
    if (lifecycle.kind === 'lobby') {
      return [{ playerId: player.id, message: this.roomStateMessage(room, player) }];
    }
    if (lifecycle.kind === 'countdown') {
      return [{ playerId: player.id, message: this.countdownMessage(room, lifecycle.match) }];
    }
    if (lifecycle.kind === 'playing') {
      return [
        {
          playerId: player.id,
          message: lifecycle.match.match.buildTurnAssignedMessage(
            room.id, SHARED_DUEL_ROOM_MODE, lifecycle.match.id,
          ),
        },
        ...this.targetedDuelStatus(room, lifecycle.match, player.id),
      ];
    }
    return [{ playerId: player.id, message: this.finishedMessage(room, lifecycle.match.id, lifecycle) }];
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
      if (room.paused) {
        deliveries.push({
          playerId: player.id,
          message: this.pausedMessage(
            room, lifecycle.match.id, true, room.paused.by, lifecycle.match.match.turnDeadline,
          ),
        });
      }
      // Status is deliberately last: it carries serverTime and the projected
      // paused deadline, so it must win over match-paused's legacy raw server
      // timestamp on a clock-skewed reconnecting client.
      deliveries.push(...this.targetedDuelStatus(room, lifecycle.match, player.id));
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

  private relayToOthers(room: DuelRoom, sender: RoomPlayer, factory: () => MultiplayerServerMessage): RoomDelivery[] {
    return room.players.filter(p => p.id !== sender.id).map(player => ({
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

function requirePositiveDuration(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error('statusPulseMs must be a positive safe integer');
  }
  return value;
}

function fatal<T>(error: RoomServiceError, deliveries: readonly RoomDelivery[]): RoomServiceResult<T> {
  return { ok: false, disposition: 'fatal', error, deliveries };
}

// A recoverable failure always carries the requesting player's corrective
// snapshot (see recoverySnapshot) — the non-empty check here is a runtime
// guard against a call site forgetting it, backing the type-level guarantee.
function recoverable(error: RoomServiceError, deliveries: readonly RoomDelivery[]): RoomServiceResult<null> {
  if (deliveries.length === 0) {
    throw new Error('Recoverable room-service results must include at least one delivery');
  }
  return {
    ok: false,
    disposition: 'recoverable',
    error,
    deliveries: deliveries as readonly [RoomDelivery, ...RoomDelivery[]],
  };
}

function sha256Digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

function credentialMatches(credential: string, digest: Buffer): boolean {
  return timingSafeEqual(sha256Digest(credential), digest);
}
