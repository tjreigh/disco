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
  readonly result: MultiplayerLocalResult | null;
  readonly compatibilityError: SharedBoardCompatibilityError | null;
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
    if (lifecycle.kind !== 'playing' || !lifecycle.isMyTurn) return;
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
    if (lifecycle.kind !== 'playing' || !lifecycle.isMyTurn) return;
    lifecycle.columnCursor = Math.max(0, Math.min(6, column));
  }

  destroy(): void {
    this.#unsubMessage();
    this.#unsubConnection();
  }

  #receive(raw: unknown): void {
    const parsed = parseMultiplayerServerMessage(raw);
    if (!parsed.ok) {
      this.#failCompatibility(parsed.error === 'protocol-mismatch' ? 'protocol-mismatch' : 'invalid-message');
      return;
    }
    const message = parsed.message;
    if (message.roomId !== this.#roomId) return;
    if (!sameMultiplayerModeIdentity(message.mode, this.#mode)) {
      this.#failCompatibility('rules-mismatch');
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
      case 'opponent-progress':
        break;
    }
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
      match: lifecycle.kind === 'countdown'
        ? lifecycle.match
        : lifecycle.match,
      board,
      localScore: lifecycle.kind === 'playing' ? lifecycle.localScore : 0,
      opponentScore: lifecycle.kind === 'playing' ? lifecycle.opponentScore : 0,
      isMyTurn,
      turnDeadline: isMyTurn ? message.turnDeadline : 0,
      columnCursor: lifecycle.kind === 'playing' ? lifecycle.columnCursor : 3,
    };
  }

  #handleTurnPlayed(message: MultiplayerServerMessage & { type: 'turn-played' | 'turn-expired' }): void {
    const lifecycle = this.#lifecycle;
    if (lifecycle.kind !== 'playing') return;

    lifecycle.board = message.board;
    if (message.turnResult.playerId === this.#playerId) {
      lifecycle.localScore += message.turnResult.triggerScoreDelta;
      lifecycle.opponentScore += message.turnResult.opponentScoreDelta;
    } else {
      lifecycle.localScore += message.turnResult.opponentScoreDelta;
      lifecycle.opponentScore += message.turnResult.triggerScoreDelta;
    }

    lifecycle.isMyTurn = message.nextPlayerId === this.#playerId;
    lifecycle.turnDeadline = 0;
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
      };
    }
  }

  #failCompatibility(error: SharedBoardCompatibilityError): void {
    this.#lifecycle = { kind: 'incompatible', error };
  }

  #buildView(): SharedBoardSessionView {
    const lifecycle = this.#lifecycle;
    const phase = this.#derivePhase();

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
      remainingMs: null,
      isMyTurn: lifecycle.kind === 'playing' ? lifecycle.isMyTurn : false,
      turnDeadline: lifecycle.kind === 'playing' ? lifecycle.turnDeadline : null,
      localScore: lifecycle.kind === 'playing' ? lifecycle.localScore : 0,
      opponentScore: lifecycle.kind === 'playing' ? lifecycle.opponentScore : 0,
      board: lifecycle.kind === 'playing' ? lifecycle.board : emptyBoard(),
      columnCursor: lifecycle.kind === 'playing' ? lifecycle.columnCursor : 3,
      result: lifecycle.kind === 'complete' ? lifecycle.result : null,
      compatibilityError: lifecycle.kind === 'incompatible' ? lifecycle.error : null,
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
