import {
  determineScoreRaceResult,
  multiplayerModeIdentity,
  MULTIPLAYER_PROTOCOL_VERSION,
  SCORE_RACE_DURATION_MS,
  SCORE_RACE_MODE_ID,
  SCORE_RACE_MODE_VERSION,
  SCORE_RACE_RULES_VERSION,
  sameMultiplayerModeIdentity,
} from './contracts.js';
import type {
  MultiplayerClientMessage,
  MultiplayerMatchResult,
  MultiplayerPlayerProgress,
  MultiplayerProgress,
  MultiplayerServerMessage,
} from './contracts.js';
import type {
  RoomAdmission,
  RoomAdmissionRequest,
  RoomClock,
  RoomConnectRequest,
  RoomConnection,
  RoomDelivery,
  RoomIdAllocator,
  RoomJoinRequest,
  RoomServiceError,
  RoomServiceResult,
  RoomTickResult,
  RoomValueFactory,
} from './room-types.js';
import {
  createDefaultRoomValueFactory,
  createRoomIdAllocator,
  credentialMatches,
  digestCredential,
  positiveDuration,
  requiredValue,
  uint32Value,
} from './room-values.js';
import { ChatRateLimiter } from './chat-policy.js';

const DEFAULT_COUNTDOWN_MS = 3_000;
const DEFAULT_LOBBY_TTL_MS = 30 * 60 * 1_000;
const DEFAULT_RESULT_TTL_MS = 5 * 60 * 1_000;

export const SCORE_RACE_ROOM_MODE = multiplayerModeIdentity({
  id: SCORE_RACE_MODE_ID,
  version: SCORE_RACE_MODE_VERSION,
  rules: {
    id: SCORE_RACE_MODE_ID,
    version: SCORE_RACE_RULES_VERSION,
  },
});

export interface ScoreRaceRoomServiceOptions {
  readonly clock: RoomClock;
  readonly values?: RoomValueFactory;
  readonly roomIdAllocator?: RoomIdAllocator;
  readonly countdownMs?: number;
  readonly lobbyTtlMs?: number;
  readonly resultTtlMs?: number;
}

interface RoomPlayer {
  readonly id: string;
  readonly credentialDigest: Buffer;
  ready: boolean;
  progress: MultiplayerProgress;
  finished: boolean;
  connection: RoomConnection | null;
}

interface RoomMatch {
  readonly id: string;
  readonly startsAt: number;
  readonly deadline: number;
  readonly seed: number;
}

type RoomLifecycle =
  | {
    readonly kind: 'lobby';
    expiresAt: number;
  }
  | {
    readonly kind: 'match';
    readonly match: RoomMatch;
  }
  | {
    readonly kind: 'complete';
    readonly match: RoomMatch;
    readonly result: MultiplayerMatchResult;
    expiresAt: number;
  };

interface Room {
  readonly id: string;
  readonly players: RoomPlayer[];
  lifecycle: RoomLifecycle;
  paused: { readonly by: string; readonly since: number } | null;
}

/**
 * Authoritative, transport-independent lifecycle for private two-player Score Race rooms.
 *
 * Callers parse untrusted wire data before `receive`. Reconnect credentials are
 * verified only by `connect` and are retained in memory as SHA-256 digests.
 */
export class ScoreRaceRoomService {
  private readonly rooms = new Map<string, Room>();
  private readonly clock: RoomClock;
  private readonly values: RoomValueFactory;
  private readonly roomIdAllocator: RoomIdAllocator;
  private readonly countdownMs: number;
  private readonly lobbyTtlMs: number;
  private readonly resultTtlMs: number;
  private readonly chatLimiter: ChatRateLimiter;

  constructor(options: ScoreRaceRoomServiceOptions) {
    this.clock = options.clock;
    this.values = options.values ?? createDefaultRoomValueFactory();
    this.roomIdAllocator = options.roomIdAllocator ?? createRoomIdAllocator();
    this.countdownMs = positiveDuration(options.countdownMs ?? DEFAULT_COUNTDOWN_MS);
    this.lobbyTtlMs = positiveDuration(options.lobbyTtlMs ?? DEFAULT_LOBBY_TTL_MS);
    this.resultTtlMs = positiveDuration(options.resultTtlMs ?? DEFAULT_RESULT_TTL_MS);
    this.chatLimiter = new ChatRateLimiter(this.clock);
  }

  createRoom(request: RoomAdmissionRequest): RoomServiceResult<RoomAdmission> {
    const compatibilityError = this.compatibilityError(request);
    if (compatibilityError) return failure(compatibilityError);

    const now = this.clock.now();
    const roomId = this.createUniqueRoomId();
    try {
      const admission = this.createAdmission(roomId);
      const room: Room = {
        id: roomId,
        players: [this.createPlayer(admission)],
        lifecycle: {
          kind: 'lobby',
          expiresAt: now + this.lobbyTtlMs,
        },
        paused: null,
      };
      this.rooms.set(roomId, room);
      return success(admission);
    } catch (error) {
      this.rooms.delete(roomId);
      this.roomIdAllocator.release(roomId);
      throw error;
    }
  }

  joinRoom(request: RoomJoinRequest): RoomServiceResult<RoomAdmission> {
    const compatibilityError = this.compatibilityError(request);
    if (compatibilityError) return failure(compatibilityError);
    const room = this.liveRoom(request.roomId);
    if (!room) return failure('room-not-found');
    if (room.lifecycle.kind !== 'lobby' || room.players.length >= 2) {
      return failure('room-full');
    }

    const admission = this.createAdmission(room.id);
    room.players.push(this.createPlayer(admission));
    this.touchReadyRoom(room);
    return success(admission);
  }

  connect(request: RoomConnectRequest): RoomServiceResult<RoomConnection> {
    const room = this.liveRoom(request.roomId);
    if (!room) return failure('room-not-found');
    const player = room.players.find(candidate => candidate.id === request.playerId);
    if (!player || !credentialMatches(request.reconnectCredential, player.credentialDigest)) {
      return failure('invalid-credential');
    }

    const deliveries = this.advanceRoom(room);
    const connection = Object.freeze({
      roomId: room.id,
      playerId: player.id,
    });
    player.connection = connection;
    this.touchReadyRoom(room);
    const snapshot = room.lifecycle.kind === 'lobby'
      ? this.roomStateDeliveries(room)
      : this.snapshotDeliveries(room, player);
    return success(connection, [...deliveries, ...snapshot]);
  }

  disconnect(connection: RoomConnection): readonly RoomDelivery[] {
    const active = this.activePlayer(connection);
    if (!active) return [];
    active.player.connection = null;
    if (active.room.lifecycle.kind === 'lobby'
      || active.room.lifecycle.kind === 'complete') {
      active.player.ready = false;
      return this.roomStateDeliveries(active.room);
    }
    // Dropping the pausing player's connection must not permanently freeze
    // the room for whoever's left — resume on their behalf, same as an
    // explicit resume request, rather than soft-locking the opponent.
    if (active.room.lifecycle.kind === 'match'
      && active.room.paused
      && active.room.paused.by === active.player.id) {
      return this.resumeMatchClock(active.room, active.player.id, [], active.room.lifecycle.match.id);
    }
    return [];
  }

  receive(
    connection: RoomConnection,
    message: MultiplayerClientMessage,
  ): RoomServiceResult<null> {
    const active = this.activePlayer(connection);
    if (!active) return failure('stale-connection');
    const { room, player } = active;
    const deliveries = this.advanceRoom(room);
    if (message.protocolVersion !== MULTIPLAYER_PROTOCOL_VERSION) {
      return failure('protocol-mismatch', deliveries);
    }
    if (message.roomId !== room.id || message.playerId !== player.id) {
      return failure('stale-connection', deliveries);
    }

    switch (message.type) {
      case 'set-ready':
        return this.setReady(room, player, message.ready, deliveries);
      case 'publish-progress':
        return this.updateProgress(
          room,
          player,
          message.matchId,
          message.progress,
          false,
          deliveries,
        );
      case 'finish-match':
        return this.updateProgress(
          room,
          player,
          message.matchId,
          message.progress,
          true,
          deliveries,
        );
      case 'resume-session':
        return this.resumeSession(
          room,
          player,
          message.matchId,
          message.lastProgressSequence,
          deliveries,
        );
      case 'set-paused':
        return this.setPaused(room, player, message.matchId, message.paused, deliveries);
      case 'forfeit-match':
        return this.forfeitMatch(room, player, message.matchId, deliveries);
      case 'send-chat':
        return this.sendChat(room, player, message.text, deliveries);
      case 'play-turn':
      case 'move-cursor':
        return failure('invalid-state', deliveries);
    }
  }

  tick(): RoomTickResult {
    const deliveries: RoomDelivery[] = [];
    const expiredRoomIds: string[] = [];
    const now = this.clock.now();
    for (const room of this.rooms.values()) {
      if (isExpired(room, now)) {
        this.rooms.delete(room.id);
        this.roomIdAllocator.release(room.id);
        expiredRoomIds.push(room.id);
        continue;
      }
      deliveries.push(...this.advanceRoom(room));
    }
    this.chatLimiter.sweep(now);
    return { deliveries, expiredRoomIds };
  }

  private setReady(
    room: Room,
    player: RoomPlayer,
    ready: boolean,
    priorDeliveries: readonly RoomDelivery[],
  ): RoomServiceResult<null> {
    if (room.lifecycle.kind !== 'lobby' && room.lifecycle.kind !== 'complete') {
      return failure('invalid-state', priorDeliveries);
    }
    player.ready = ready;
    this.touchReadyRoom(room);
    const deliveries = [...priorDeliveries, ...this.roomStateDeliveries(room)];
    if (room.players.length === 2 && room.players.every(candidate => candidate.ready)) {
      const startsAt = this.clock.now() + this.countdownMs;
      const match: RoomMatch = {
        id: requiredValue(this.values.createMatchId(), 'match id'),
        startsAt,
        deadline: startsAt + SCORE_RACE_DURATION_MS,
        seed: uint32Value(this.values.createSeed()),
      };
      for (const candidate of room.players) {
        candidate.progress = emptyProgress();
        candidate.finished = false;
      }
      room.lifecycle = { kind: 'match', match };
      deliveries.push(...this.broadcast(room, () => this.countdownMessage(room, match)));
    }
    return success(null, deliveries);
  }

  private updateProgress(
    room: Room,
    player: RoomPlayer,
    matchId: string,
    progress: MultiplayerProgress,
    finishing: boolean,
    priorDeliveries: readonly RoomDelivery[],
  ): RoomServiceResult<null> {
    const lifecycle = room.lifecycle;
    if (lifecycle.kind === 'complete') {
      if (matchId !== lifecycle.match.id) {
        return failure('match-mismatch', priorDeliveries);
      }
      // The authoritative deadline can complete the room immediately before a
      // client's own deadline tick sends finish-match. The result has already
      // been fixed, so treat that terminal notification as an idempotent no-op
      // instead of sending an error after match-finished.
      if (finishing) {
        return success(null, priorDeliveries);
      }
      return failure('invalid-state', priorDeliveries);
    }
    if (lifecycle.kind !== 'match') {
      return failure('invalid-state', priorDeliveries);
    }
    if (matchId !== lifecycle.match.id) {
      return failure('match-mismatch', priorDeliveries);
    }
    if (room.paused) {
      return failure('invalid-state', priorDeliveries);
    }
    const now = this.clock.now();
    if (now < lifecycle.match.startsAt || now >= lifecycle.match.deadline) {
      return failure('invalid-state', priorDeliveries);
    }
    if (player.finished) {
      if (finishing && sameProgress(player.progress, progress)) {
        return success(null, priorDeliveries);
      }
      return failure('invalid-state', priorDeliveries);
    }

    const progressError = validateProgressUpdate(player.progress, progress);
    if (progressError) return failure(progressError, priorDeliveries);
    const changed = !sameProgress(player.progress, progress);
    player.progress = copyProgress(progress);
    const newlyFinished = finishing && !player.finished;
    player.finished = player.finished || finishing;

    const deliveries = [...priorDeliveries];
    if (changed || newlyFinished) {
      deliveries.push(...this.opponentProgressDeliveries(room, player));
    }
    if (room.players.length === 2 && room.players.every(candidate => candidate.finished)) {
      deliveries.push(...this.completeMatch(room));
    }
    return success(null, deliveries);
  }

  private resumeSession(
    room: Room,
    player: RoomPlayer,
    matchId: string | null,
    lastProgressSequence: number,
    priorDeliveries: readonly RoomDelivery[],
  ): RoomServiceResult<null> {
    const expectedMatchId = room.lifecycle.kind === 'lobby'
      ? null
      : room.lifecycle.match.id;
    if (matchId !== null && matchId !== expectedMatchId) {
      return failure('match-mismatch', priorDeliveries);
    }
    if (lastProgressSequence < player.progress.sequence) {
      return failure('stale-progress', priorDeliveries);
    }
    if (room.lifecycle.kind === 'lobby' && lastProgressSequence !== 0) {
      return failure('conflicting-progress', priorDeliveries);
    }
    if (room.lifecycle.kind === 'complete'
      && lastProgressSequence !== player.progress.sequence) {
      return failure('conflicting-progress', priorDeliveries);
    }
    return success(
      null,
      [...priorDeliveries, ...this.snapshotDeliveries(room, player)],
    );
  }

  private advanceRoom(room: Room): RoomDelivery[] {
    const now = this.clock.now();
    if (room.lifecycle.kind === 'match' && !room.paused && now >= room.lifecycle.match.deadline) {
      return this.completeMatch(room);
    }
    return [];
  }

  private setPaused(
    room: Room,
    player: RoomPlayer,
    matchId: string,
    paused: boolean,
    priorDeliveries: readonly RoomDelivery[],
  ): RoomServiceResult<null> {
    if (room.lifecycle.kind !== 'match' || matchId !== room.lifecycle.match.id) {
      return failure('invalid-state', priorDeliveries);
    }
    const match = room.lifecycle.match;
    if (paused) {
      if (room.paused) return success(null, priorDeliveries);
      room.paused = { by: player.id, since: this.clock.now() };
      const deliveries = [
        ...priorDeliveries,
        ...this.broadcast(room, () => this.pausedMessage(room, matchId, true, player.id, match.deadline)),
      ];
      return success(null, deliveries);
    }
    if (!room.paused) return success(null, priorDeliveries);
    // Only the player who paused can resume — otherwise the other player
    // could unpause out from under someone who still has their menu open.
    if (room.paused.by !== player.id) {
      return failure('invalid-state', priorDeliveries);
    }
    const deliveries = this.resumeMatchClock(room, player.id, priorDeliveries, matchId);
    return success(null, deliveries);
  }

  private forfeitMatch(
    room: Room,
    player: RoomPlayer,
    matchId: string,
    priorDeliveries: readonly RoomDelivery[],
  ): RoomServiceResult<null> {
    if (room.lifecycle.kind !== 'match' || matchId !== room.lifecycle.match.id) {
      return failure('invalid-state', priorDeliveries);
    }
    const match = room.lifecycle.match;
    const opponent = room.players.find(candidate => candidate.id !== player.id);
    if (!opponent) return failure('invalid-state', priorDeliveries);

    // A forfeit always hands the win to the opponent — unlike a normal
    // finish, the current score comparison is irrelevant to who won.
    const result: MultiplayerMatchResult = {
      winnerId: opponent.id,
      scores: [
        { playerId: player.id, score: player.progress.score },
        { playerId: opponent.id, score: opponent.progress.score },
      ],
      forfeitedBy: player.id,
    };
    room.paused = null;
    for (const candidate of room.players) candidate.ready = false;
    room.lifecycle = {
      kind: 'complete',
      match,
      result,
      expiresAt: this.clock.now() + this.resultTtlMs,
    };

    const deliveries = [
      ...priorDeliveries,
      ...this.broadcast(room, () => this.finishedMessage(room, match, result)),
    ];
    return success(null, deliveries);
  }

  private sendChat(
    room: Room,
    player: RoomPlayer,
    text: string,
    priorDeliveries: readonly RoomDelivery[],
  ): RoomServiceResult<null> {
    // Chat is valid in every lifecycle phase (lobby through result) and is
    // relayed to both players, so the sender and opponent stay symmetric.
    if (!this.chatLimiter.allow(player.id)) {
      // Never silently drop: tell the sender their message was throttled.
      return success(null, [
        ...priorDeliveries,
        { playerId: player.id, message: this.chatRateLimitedMessage(room) },
      ]);
    }
    // Accepted chat counts as room activity, extending the lobby/result TTL
    // so an active conversation can't outlive the room it's happening in.
    this.touchReadyRoom(room);
    return success(null, [
      ...priorDeliveries,
      ...this.broadcast(room, () => this.chatMessage(room, player.id, text)),
    ]);
  }

  private chatMessage(room: Room, playerId: string, text: string): MultiplayerServerMessage {
    return {
      ...this.serverEnvelope(room),
      type: 'chat-message',
      playerId,
      text,
    };
  }

  private chatRateLimitedMessage(room: Room): MultiplayerServerMessage {
    return {
      ...this.serverEnvelope(room),
      type: 'chat-rate-limited',
    };
  }

  private resumeMatchClock(
    room: Room,
    resumedBy: string,
    priorDeliveries: readonly RoomDelivery[],
    matchId: string,
  ): RoomDelivery[] {
    if (!room.paused || room.lifecycle.kind !== 'match') return [...priorDeliveries];
    const elapsed = this.clock.now() - room.paused.since;
    const deadline = room.lifecycle.match.deadline + elapsed;
    room.lifecycle = {
      kind: 'match',
      match: { ...room.lifecycle.match, deadline },
    };
    room.paused = null;
    return [
      ...priorDeliveries,
      ...this.broadcast(room, () => this.pausedMessage(room, matchId, false, resumedBy, deadline)),
    ];
  }

  private pausedMessage(
    room: Room,
    matchId: string,
    paused: boolean,
    pausedBy: string,
    deadline: number,
  ): MultiplayerServerMessage {
    return {
      ...this.serverEnvelope(room),
      type: 'match-paused',
      matchId,
      paused,
      pausedBy,
      deadline,
    };
  }

  private completeMatch(room: Room): RoomDelivery[] {
    if (room.lifecycle.kind !== 'match') return [];
    const first = room.players[0];
    const second = room.players[1];
    if (!first || !second) return [];
    const match = room.lifecycle.match;
    for (const player of room.players) player.ready = false;
    const result = determineScoreRaceResult(
      first.id,
      first.progress.score,
      second.id,
      second.progress.score,
    );
    room.lifecycle = {
      kind: 'complete',
      match,
      result,
      expiresAt: this.clock.now() + this.resultTtlMs,
    };
    return this.broadcast(room, () => this.finishedMessage(room, match, result));
  }

  private snapshotDeliveries(room: Room, player: RoomPlayer): RoomDelivery[] {
    if (room.lifecycle.kind === 'lobby') {
      return [{
        playerId: player.id,
        message: this.roomStateMessage(room, player),
      }];
    }
    const deliveries: RoomDelivery[] = [{
      playerId: player.id,
      message: this.countdownMessage(room, room.lifecycle.match),
    }];
    const opponent = room.players.find(candidate => candidate !== player);
    if (opponent && (opponent.progress.sequence > 0 || opponent.finished)) {
      deliveries.push({
        playerId: player.id,
        message: this.opponentProgressMessage(room, room.lifecycle.match, opponent),
      });
    }
    if (room.lifecycle.kind === 'match' && room.paused) {
      deliveries.push({
        playerId: player.id,
        message: this.pausedMessage(
          room, room.lifecycle.match.id, true, room.paused.by, room.lifecycle.match.deadline,
        ),
      });
    }
    if (room.lifecycle.kind === 'complete') {
      deliveries.push({
        playerId: player.id,
        message: this.finishedMessage(
          room,
          room.lifecycle.match,
          room.lifecycle.result,
        ),
      });
      deliveries.push({
        playerId: player.id,
        message: this.roomStateMessage(room, player),
      });
    }
    return deliveries;
  }

  private roomStateDeliveries(room: Room): RoomDelivery[] {
    return room.players.flatMap(player => player.connection
      ? [{
        playerId: player.id,
        message: this.roomStateMessage(room, player),
      }]
      : []);
  }

  private opponentProgressDeliveries(room: Room, source: RoomPlayer): RoomDelivery[] {
    if (room.lifecycle.kind !== 'match') return [];
    const match = room.lifecycle.match;
    return room.players.flatMap(player => player !== source && player.connection
      ? [{
        playerId: player.id,
        message: this.opponentProgressMessage(room, match, source),
      }]
      : []);
  }

  private broadcast(
    room: Room,
    message: (player: RoomPlayer) => MultiplayerServerMessage,
  ): RoomDelivery[] {
    return room.players.flatMap(player => player.connection
      ? [{ playerId: player.id, message: message(player) }]
      : []);
  }

  private roomStateMessage(room: Room, player: RoomPlayer): MultiplayerServerMessage {
    const opponent = room.players.find(candidate => candidate !== player);
    return {
      ...this.serverEnvelope(room),
      type: 'room-state',
      localReady: player.ready,
      opponentReady: opponent?.ready ?? false,
      opponentJoined: opponent !== undefined,
      opponentConnected: Boolean(opponent?.connection),
    };
  }

  private countdownMessage(room: Room, match: RoomMatch): MultiplayerServerMessage {
    return {
      ...this.serverEnvelope(room),
      type: 'match-countdown',
      matchId: match.id,
      startsAt: match.startsAt,
      deadline: match.deadline,
      seed: match.seed,
    };
  }

  private opponentProgressMessage(
    room: Room,
    match: RoomMatch,
    player: RoomPlayer,
  ): MultiplayerServerMessage {
    return {
      ...this.serverEnvelope(room),
      type: 'opponent-progress',
      matchId: match.id,
      progress: playerProgress(player),
    };
  }

  private finishedMessage(
    room: Room,
    match: RoomMatch,
    result: MultiplayerMatchResult,
  ): MultiplayerServerMessage {
    return {
      ...this.serverEnvelope(room),
      type: 'match-finished',
      matchId: match.id,
      result,
    };
  }

  private serverEnvelope(room: Room) {
    return {
      protocolVersion: MULTIPLAYER_PROTOCOL_VERSION,
      roomId: room.id,
      mode: multiplayerModeIdentity(SCORE_RACE_ROOM_MODE),
    } as const;
  }

  private createAdmission(roomId: string): RoomAdmission {
    return {
      roomId,
      playerId: requiredValue(this.values.createPlayerId(), 'player id'),
      reconnectCredential: requiredValue(
        this.values.createReconnectCredential(),
        'reconnect credential',
      ),
      mode: multiplayerModeIdentity(SCORE_RACE_ROOM_MODE),
    };
  }

  private createPlayer(admission: RoomAdmission): RoomPlayer {
    return {
      id: admission.playerId,
      credentialDigest: digestCredential(admission.reconnectCredential),
      ready: false,
      progress: emptyProgress(),
      finished: false,
      connection: null,
    };
  }

  private compatibilityError(request: RoomAdmissionRequest): RoomServiceError | null {
    if (request.protocolVersion !== MULTIPLAYER_PROTOCOL_VERSION) {
      return 'protocol-mismatch';
    }
    return sameMultiplayerModeIdentity(request.mode, SCORE_RACE_ROOM_MODE)
      ? null
      : 'mode-mismatch';
  }

  private liveRoom(roomId: string): Room | null {
    const room = this.rooms.get(roomId);
    if (!room) return null;
    if (isExpired(room, this.clock.now())) {
      this.rooms.delete(room.id);
      this.roomIdAllocator.release(room.id);
      return null;
    }
    return room;
  }

  private activePlayer(
    connection: RoomConnection,
  ): { room: Room; player: RoomPlayer } | null {
    const room = this.liveRoom(connection.roomId);
    if (!room) return null;
    const player = room.players.find(candidate => candidate.id === connection.playerId);
    return player?.connection === connection ? { room, player } : null;
  }

  private touchReadyRoom(room: Room): void {
    if (room.lifecycle.kind === 'lobby') {
      room.lifecycle.expiresAt = this.clock.now() + this.lobbyTtlMs;
    } else if (room.lifecycle.kind === 'complete') {
      room.lifecycle.expiresAt = this.clock.now() + this.resultTtlMs;
    }
  }

  private createUniqueRoomId(): string {
    return this.roomIdAllocator.claim(() => this.values.createRoomId());
  }
}

function success<T>(
  value: T,
  deliveries: readonly RoomDelivery[] = [],
): RoomServiceResult<T> {
  return { ok: true, value, deliveries };
}

// Score Race keeps its pre-existing fatal-on-any-error behavior in this pass
// (see docs/fix-duel-sync-resilience-plan.md section 4) — it has no
// corrective snapshot to send back, unlike Disco Duel's duel-status.
function failure<T>(
  error: RoomServiceError,
  deliveries: readonly RoomDelivery[] = [],
): RoomServiceResult<T> {
  return { ok: false, disposition: 'fatal', error, deliveries };
}

function emptyProgress(): MultiplayerProgress {
  return { sequence: 0, score: 0, turnsPlayed: 0 };
}

function copyProgress(progress: MultiplayerProgress): MultiplayerProgress {
  return {
    sequence: progress.sequence,
    score: progress.score,
    turnsPlayed: progress.turnsPlayed,
  };
}

function sameProgress(left: MultiplayerProgress, right: MultiplayerProgress): boolean {
  return left.sequence === right.sequence
    && left.score === right.score
    && left.turnsPlayed === right.turnsPlayed;
}

function validateProgressUpdate(
  previous: MultiplayerProgress,
  next: MultiplayerProgress,
): RoomServiceError | null {
  if (next.sequence < previous.sequence) return 'stale-progress';
  if (next.sequence === previous.sequence && !sameProgress(previous, next)) {
    return 'conflicting-progress';
  }
  if (next.score < previous.score || next.turnsPlayed < previous.turnsPlayed) {
    return 'non-monotonic-progress';
  }
  return null;
}

function playerProgress(player: RoomPlayer): MultiplayerPlayerProgress {
  return {
    playerId: player.id,
    ...copyProgress(player.progress),
    finished: player.finished,
  };
}

function isExpired(room: Room, now: number): boolean {
  return (room.lifecycle.kind === 'lobby' || room.lifecycle.kind === 'complete')
    && now >= room.lifecycle.expiresAt;
}
