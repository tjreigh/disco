import {
  localizeMultiplayerResult,
  MULTIPLAYER_PROTOCOL_VERSION,
  sameMultiplayerModeIdentity,
} from '../shared/multiplayer-contracts.js';
import type {
  MultiplayerClientMessage,
  MultiplayerConnectionState,
  MultiplayerLocalResult,
  MultiplayerModeIdentity,
  MultiplayerServerMessage,
  WireBoard,
  WireDisc,
  WireStep,
} from '../shared/multiplayer-contracts.js';
import { parseMultiplayerServerMessage } from '../shared/multiplayer-messages.js';
import type { MultiplayerModeDefinition } from '../game/modes/mode.js';

export interface SessionClock {
  now(): number;
}

export interface SharedBoardTransport {
  send(message: MultiplayerClientMessage): void;
  subscribe(listener: (message: unknown) => void): () => void;
  subscribeConnection(listener: (state: MultiplayerConnectionState) => void): () => void;
}

export type SharedBoardPhase =
  | 'lobby'
  | 'ready'
  | 'countdown'
  | 'playing'
  | 'finished'
  | 'disconnected'
  | 'reconnecting';

export type SharedBoardCompatibilityError =
  | 'invalid-message'
  | 'protocol-mismatch'
  | 'rules-mismatch'
  | 'session-mismatch';

export interface SharedBoardSessionView {
  readonly phase: SharedBoardPhase;
  readonly connection: MultiplayerConnectionState;
  readonly roomId: string;
  readonly playerId: string;
  readonly mode: MultiplayerModeIdentity;
  readonly localReady: boolean;
  readonly opponentReady: boolean;
  readonly matchId: string | null;
  readonly startsAt: number | null;
  readonly remainingMs: number | null;
  readonly isMyTurn: boolean;
  readonly turnDeadline: number | null;
  readonly localScore: number;
  readonly opponentScore: number;
  readonly board: WireBoard;
  readonly columnCursor: number;
  /** The active player's live column selection, as seen by the other player. Null until they move it. */
  readonly opponentColumnCursor: number | null;
  readonly currentDisc: WireDisc;
  readonly nextDisc: WireDisc;
  readonly level: number;
  readonly turnsPerLevel: number;
  readonly turnsRemaining: number;
  readonly result: MultiplayerLocalResult | null;
  readonly compatibilityError: SharedBoardCompatibilityError | null;
  readonly paused: boolean;
  readonly pausedBy: string | null;
}

export interface SharedBoardSessionControllerOptions {
  readonly roomId: string;
  readonly playerId: string;
  readonly mode: MultiplayerModeDefinition;
  readonly clock: SessionClock;
  readonly transport: SharedBoardTransport;
}

interface MatchContext {
  readonly matchId: string;
  readonly startsAt: number;
  readonly seed: number;
}

/** The board as it stood right before a turn resolved, plus the steps to animate it forward. */
export interface PendingTurnResult {
  readonly boardBefore: WireBoard;
  readonly steps: readonly WireStep[];
  /** Who dropped the disc that produced these steps — for crediting chain/score callouts. */
  readonly triggerPlayerId: string;
  /** Points awarded to the trigger player (includes trigger bonus + owner awards + steals). */
  readonly triggerScoreDelta: number;
  /** Points awarded to the other player (their share of non-stolen owner awards). */
  readonly opponentScoreDelta: number;
}

type MatchLifecycle =
  | { readonly kind: 'lobby'; localReady: boolean; opponentReady: boolean }
  | { readonly kind: 'countdown'; readonly match: MatchContext }
  | {
      readonly kind: 'playing';
      readonly match: MatchContext;
      board: WireBoard;
      localScore: number;
      opponentScore: number;
      isMyTurn: boolean;
      turnDeadline: number;
      columnCursor: number;
      opponentColumnCursor: number | null;
      currentDisc: WireDisc;
      nextDisc: WireDisc;
      level: number;
      turnsPerLevel: number;
      turnsRemaining: number;
      /** A turn just resolved and hasn't been picked up for animation yet. */
      pendingTurnResult: PendingTurnResult | null;
      paused: { readonly by: string } | null;
    }
  | {
      readonly kind: 'complete';
      readonly result: MultiplayerLocalResult;
      localReady: boolean;
      opponentReady: boolean;
    }
  | { readonly kind: 'incompatible'; readonly error: SharedBoardCompatibilityError };

export class SharedBoardSessionController {
  readonly #roomId: string;
  readonly #playerId: string;
  readonly #definition: MultiplayerModeDefinition;
  readonly #mode: MultiplayerModeIdentity;
  readonly #clock: SessionClock;
  readonly #transport: SharedBoardTransport;
  readonly #unsubMessage: () => void;
  readonly #unsubConnection: () => void;
  #connection: MultiplayerConnectionState;
  #lifecycle: MatchLifecycle;

  constructor(options: SharedBoardSessionControllerOptions) {
    this.#roomId = options.roomId;
    this.#playerId = options.playerId;
    this.#definition = options.mode;
    this.#mode = { id: options.mode.id, version: options.mode.version, rules: { id: options.mode.rules.id, version: options.mode.rules.version } };
    this.#clock = options.clock;
    this.#transport = options.transport;
    this.#connection = 'connected';
    this.#lifecycle = { kind: 'lobby', localReady: false, opponentReady: false };

    this.#unsubMessage = options.transport.subscribe(message => this.#receive(message));
    this.#unsubConnection = options.transport.subscribeConnection(state => this.#handleConnection(state));
  }

  get view(): SharedBoardSessionView {
    return this.#buildView();
  }

  tick(): void {
    this.#advanceForClock();
  }

  setReady(ready: boolean): void {
    if (this.#lifecycle.kind !== 'lobby' && this.#lifecycle.kind !== 'complete') return;
    this.#lifecycle.localReady = ready;
    this.#transport.send({
      protocolVersion: MULTIPLAYER_PROTOCOL_VERSION,
      roomId: this.#roomId,
      playerId: this.#playerId,
      type: 'set-ready',
      ready,
    });
  }

  playTurn(column: number): void {
    const lifecycle = this.#lifecycle;
    if (lifecycle.kind !== 'playing' || !lifecycle.isMyTurn || lifecycle.paused) return;
    this.#transport.send({
      protocolVersion: MULTIPLAYER_PROTOCOL_VERSION,
      roomId: this.#roomId,
      playerId: this.#playerId,
      type: 'play-turn',
      matchId: lifecycle.match.matchId,
      column,
    });
  }

  moveCursor(column: number): void {
    const lifecycle = this.#lifecycle;
    if (lifecycle.kind !== 'playing' || !lifecycle.isMyTurn || lifecycle.paused) return;
    const clamped = Math.max(0, Math.min(6, column));
    if (clamped === lifecycle.columnCursor) return;
    lifecycle.columnCursor = clamped;
    this.#transport.send({
      protocolVersion: MULTIPLAYER_PROTOCOL_VERSION,
      roomId: this.#roomId,
      playerId: this.#playerId,
      type: 'move-cursor',
      matchId: lifecycle.match.matchId,
      column: clamped,
    });
  }

  requestPause(paused: boolean): void {
    const lifecycle = this.#lifecycle;
    if (lifecycle.kind !== 'playing') return;
    this.#transport.send({
      protocolVersion: MULTIPLAYER_PROTOCOL_VERSION,
      roomId: this.#roomId,
      playerId: this.#playerId,
      type: 'set-paused',
      matchId: lifecycle.match.matchId,
      paused,
    });
  }

  forfeit(): void {
    const lifecycle = this.#lifecycle;
    if (lifecycle.kind !== 'playing') return;
    this.#transport.send({
      protocolVersion: MULTIPLAYER_PROTOCOL_VERSION,
      roomId: this.#roomId,
      playerId: this.#playerId,
      type: 'forfeit-match',
      matchId: lifecycle.match.matchId,
    });
  }

  /** One-shot: returns the most recent unconsumed turn result, if any, for the caller to animate. */
  consumePendingTurnResult(): PendingTurnResult | null {
    const lifecycle = this.#lifecycle;
    if (lifecycle.kind !== 'playing' || !lifecycle.pendingTurnResult) return null;
    const pending = lifecycle.pendingTurnResult;
    lifecycle.pendingTurnResult = null;
    return pending;
  }

  destroy(): void {
    this.#unsubMessage();
    this.#unsubConnection();
  }

  #receive(raw: unknown): void {
    const parsed = parseMultiplayerServerMessage(raw);
    if (!parsed.ok) {
      this.#failCompatibility(parsed.error, raw);
      return;
    }
    const message = parsed.message;
    if (message.roomId !== this.#roomId) return;
    if (!sameMultiplayerModeIdentity(message.mode, this.#mode)) {
      this.#failCompatibility('rules-mismatch', { received: message.mode, expected: this.#mode });
      return;
    }

    switch (message.type) {
      case 'room-state':
        this.#handleRoomState(message);
        break;
      case 'match-countdown':
        this.#handleMatchCountdown(message);
        break;
      case 'turn-assigned':
        this.#handleTurnAssigned(message);
        break;
      case 'turn-played':
      case 'turn-expired':
        this.#handleTurnPlayed(message);
        break;
      case 'match-finished':
        this.#handleMatchFinished(message);
        break;
      case 'opponent-cursor':
        this.#handleOpponentCursor(message);
        break;
      case 'match-paused':
        this.#handleMatchPaused(message);
        break;
      case 'opponent-progress':
        break;
    }
  }

  #handleMatchPaused(message: MultiplayerServerMessage & { type: 'match-paused' }): void {
    const lifecycle = this.#lifecycle;
    if (lifecycle.kind !== 'playing') return;
    lifecycle.paused = message.paused ? { by: message.pausedBy } : null;
    // The server's deadline is authoritative and shifts forward on resume —
    // resync rather than trying to replicate its elapsed-time math here.
    lifecycle.turnDeadline = message.deadline;
  }

  #handleRoomState(message: MultiplayerServerMessage & { type: 'room-state' }): void {
    const lifecycle = this.#lifecycle;
    if (lifecycle.kind !== 'lobby' && lifecycle.kind !== 'complete') return;
    lifecycle.localReady = message.localReady;
    lifecycle.opponentReady = message.opponentReady;
  }

  #handleMatchCountdown(message: MultiplayerServerMessage & { type: 'match-countdown' }): void {
    if (this.#lifecycle.kind !== 'lobby' && this.#lifecycle.kind !== 'complete') return;
    this.#lifecycle = {
      kind: 'countdown',
      match: {
        matchId: message.matchId,
        startsAt: message.startsAt,
        seed: message.seed,
      },
    };
  }

  #handleTurnAssigned(message: MultiplayerServerMessage & { type: 'turn-assigned' }): void {
    const lifecycle = this.#lifecycle;
    if (lifecycle.kind !== 'countdown' && lifecycle.kind !== 'playing') return;

    const board = message.board;
    const isMyTurn = message.playerId === this.#playerId;

    this.#lifecycle = {
      kind: 'playing',
      match: lifecycle.match,
      board,
      localScore: lifecycle.kind === 'playing' ? lifecycle.localScore : 0,
      opponentScore: lifecycle.kind === 'playing' ? lifecycle.opponentScore : 0,
      isMyTurn,
      turnDeadline: message.turnDeadline,
      columnCursor: lifecycle.kind === 'playing' ? lifecycle.columnCursor : 3,
      // A fresh turn means the opponent hasn't hovered anywhere yet.
      opponentColumnCursor: null,
      currentDisc: message.currentDisc,
      nextDisc: message.nextDisc,
      level: message.level,
      turnsPerLevel: message.turnsPerLevel,
      turnsRemaining: message.turnsRemaining,
      // A turn-assigned right after turn-played can arrive before the game
      // controller's next frame has drained the prior turn's animation —
      // carry it over instead of dropping it on this lifecycle swap.
      pendingTurnResult: lifecycle.kind === 'playing' ? lifecycle.pendingTurnResult : null,
      paused: lifecycle.kind === 'playing' ? lifecycle.paused : null,
    };
  }

  #handleTurnPlayed(message: MultiplayerServerMessage & { type: 'turn-played' | 'turn-expired' }): void {
    const lifecycle = this.#lifecycle;
    if (lifecycle.kind !== 'playing') return;

    const boardBefore = lifecycle.board;
    lifecycle.board = message.board;
    lifecycle.pendingTurnResult = {
      boardBefore,
      steps: message.turnResult.steps,
      triggerPlayerId: message.turnResult.playerId,
    };
    if (message.turnResult.playerId === this.#playerId) {
      lifecycle.localScore += message.turnResult.triggerScoreDelta;
      lifecycle.opponentScore += message.turnResult.opponentScoreDelta;
    } else {
      lifecycle.localScore += message.turnResult.opponentScoreDelta;
      lifecycle.opponentScore += message.turnResult.triggerScoreDelta;
    }

    lifecycle.isMyTurn = message.nextPlayerId === this.#playerId;
    lifecycle.turnDeadline = 0;
    lifecycle.currentDisc = message.currentDisc;
    lifecycle.nextDisc = message.nextDisc;
    lifecycle.level = message.level;
    lifecycle.turnsPerLevel = message.turnsPerLevel;
    lifecycle.turnsRemaining = message.turnsRemaining;
  }

  #handleOpponentCursor(message: MultiplayerServerMessage & { type: 'opponent-cursor' }): void {
    const lifecycle = this.#lifecycle;
    if (lifecycle.kind !== 'playing' || message.playerId === this.#playerId) return;
    lifecycle.opponentColumnCursor = message.column;
  }

  #handleMatchFinished(message: MultiplayerServerMessage & { type: 'match-finished' }): void {
    const localResult = localizeMultiplayerResult(message.result, this.#playerId);
    if (!localResult) return;
    this.#lifecycle = {
      kind: 'complete',
      result: localResult,
      localReady: false,
      opponentReady: false,
    };
  }

  #handleConnection(state: MultiplayerConnectionState): void {
    this.#connection = state;
  }

  #advanceForClock(): void {
    const lifecycle = this.#lifecycle;
    if (lifecycle.kind !== 'countdown') return;
    if (this.#clock.now() >= lifecycle.match.startsAt) {
      this.#lifecycle = {
        kind: 'playing',
        match: lifecycle.match,
        board: emptyBoard(),
        localScore: 0,
        opponentScore: 0,
        isMyTurn: false,
        turnDeadline: 0,
        columnCursor: 3,
        opponentColumnCursor: null,
        currentDisc: NEUTRAL_DISC,
        nextDisc: NEUTRAL_DISC,
        level: 1,
        turnsPerLevel: 1,
        turnsRemaining: 1,
        pendingTurnResult: null,
        paused: null,
      };
    }
  }

  // `detail` is deliberately permanent, not a debugging leftover: this is
  // the single choke point every incompatibility path funnels through, and
  // the UI only ever shows a generic category (see compatibilityErrorText
  // in multiplayer-room-overlay.ts) — the console is where the actual
  // offending payload has to be visible, or a real bug here (e.g. a wire
  // parser rejecting a well-formed message) is nearly unfindable.
  #failCompatibility(error: SharedBoardCompatibilityError, detail?: unknown): void {
    console.error(`[shared-duel] session became incompatible: ${error}`, detail);
    this.#lifecycle = { kind: 'incompatible', error };
  }

  #buildView(): SharedBoardSessionView {
    const lifecycle = this.#lifecycle;
    const phase = this.#derivePhase();
    const now = this.#clock.now();
    const target = lifecycle.kind === 'countdown'
      ? lifecycle.match.startsAt
      : lifecycle.kind === 'playing'
        ? lifecycle.turnDeadline
        : null;

    return {
      phase,
      connection: this.#connection,
      roomId: this.#roomId,
      playerId: this.#playerId,
      mode: this.#mode,
      localReady: lifecycle.kind === 'lobby' || lifecycle.kind === 'complete' ? lifecycle.localReady : true,
      opponentReady: lifecycle.kind === 'lobby' || lifecycle.kind === 'complete' ? lifecycle.opponentReady : true,
      matchId: ('match' in lifecycle && lifecycle.match) ? lifecycle.match.matchId : null,
      startsAt: ('match' in lifecycle && lifecycle.match) ? lifecycle.match.startsAt : null,
      remainingMs: target === null ? null : Math.max(0, target - now),
      isMyTurn: lifecycle.kind === 'playing' ? lifecycle.isMyTurn : false,
      turnDeadline: lifecycle.kind === 'playing' ? lifecycle.turnDeadline : null,
      localScore: lifecycle.kind === 'playing' ? lifecycle.localScore : 0,
      opponentScore: lifecycle.kind === 'playing' ? lifecycle.opponentScore : 0,
      board: lifecycle.kind === 'playing' ? lifecycle.board : emptyBoard(),
      columnCursor: lifecycle.kind === 'playing' ? lifecycle.columnCursor : 3,
      opponentColumnCursor: lifecycle.kind === 'playing' ? lifecycle.opponentColumnCursor : null,
      currentDisc: lifecycle.kind === 'playing' ? lifecycle.currentDisc : NEUTRAL_DISC,
      nextDisc: lifecycle.kind === 'playing' ? lifecycle.nextDisc : NEUTRAL_DISC,
      level: lifecycle.kind === 'playing' ? lifecycle.level : 1,
      turnsPerLevel: lifecycle.kind === 'playing' ? lifecycle.turnsPerLevel : 1,
      turnsRemaining: lifecycle.kind === 'playing' ? lifecycle.turnsRemaining : 1,
      result: lifecycle.kind === 'complete' ? lifecycle.result : null,
      compatibilityError: lifecycle.kind === 'incompatible' ? lifecycle.error : null,
      paused: lifecycle.kind === 'playing' && lifecycle.paused !== null,
      pausedBy: lifecycle.kind === 'playing' ? lifecycle.paused?.by ?? null : null,
    };
  }

  #derivePhase(): SharedBoardPhase {
    const lifecycle = this.#lifecycle;
    if (lifecycle.kind === 'incompatible' || lifecycle.kind === 'complete') return 'finished';
    if (this.#connection === 'disconnected') return 'disconnected';
    if (this.#connection === 'reconnecting') return 'reconnecting';
    if (lifecycle.kind === 'lobby') return lifecycle.localReady ? 'ready' : 'lobby';
    if (lifecycle.kind === 'countdown') return 'countdown';
    if (lifecycle.kind === 'playing') return 'playing';
    return 'lobby';
  }
}

function emptyBoard(): WireBoard {
  return Array.from({ length: 7 }, () => Array.from({ length: 7 }, () => null));
}

// Placeholder for phases before a real turn-assigned message has arrived
// (lobby/ready/countdown); overwritten immediately once one does.
const NEUTRAL_DISC: WireDisc = { id: 0, value: 1, kind: 'numbered' };
