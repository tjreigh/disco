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
import {
  normalizeChatText,
  parseMultiplayerServerMessage,
} from '../shared/multiplayer-messages.js';
import { MultiplayerChatLog } from './multiplayer-chat-log.js';
import type { ChatLogEntry } from './multiplayer-chat-log.js';
import type { MultiplayerModeDefinition } from '../game/modes/mode.js';
import type { MultiplayerCompatibilityError, MultiplayerPhase } from './multiplayer-view-types.js';

export interface SessionClock {
  now(): number;
}

export interface SharedBoardTransport {
  send(message: MultiplayerClientMessage): void;
  subscribe(listener: (message: unknown) => void): () => void;
  subscribeConnection(listener: (state: MultiplayerConnectionState) => void): () => void;
}

export interface SharedBoardSessionView {
  readonly phase: MultiplayerPhase;
  readonly connection: MultiplayerConnectionState;
  readonly roomId: string;
  readonly playerId: string;
  readonly mode: MultiplayerModeIdentity;
  readonly localReady: boolean;
  readonly opponentReady: boolean;
  /** Whether the room's opponent slot has been claimed. */
  readonly opponentJoined: boolean;
  /** Whether the other room slot currently has a connected player. */
  readonly opponentConnected: boolean;
  readonly matchId: string | null;
  readonly startsAt: number | null;
  readonly remainingMs: number | null;
  readonly isMyTurn: boolean;
  readonly turnDeadline: number | null;
  /** True from a local play-turn send until the server's turn-played/expired (or a resync) answers it — the countdown is stale during this window since the server hasn't set a new deadline yet. */
  readonly turnSubmissionPending: boolean;
  readonly localScore: number;
  readonly opponentScore: number;
  /** Learned from turn ownership or the authoritative score pair; null until the opponent's identity is known. */
  readonly opponentPlayerId: string | null;
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
  readonly compatibilityError: MultiplayerCompatibilityError | null;
  readonly paused: boolean;
  readonly pausedBy: string | null;
  readonly messages: readonly ChatLogEntry[];
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
      paused: { readonly by: string; readonly remainingMs: number } | null;
      /** Learned from turn ownership or the authoritative score pair; used to reject impossible pause identities. */
      opponentPlayerId: string | null;
      /** Undefined until the first revision-bearing server message (turn-assigned/played/expired or duel-status) arrives. */
      revision: number | undefined;
      turnSubmissionPending: boolean;
      /** One-shot: set when a status corrects state ahead of, or after reconnect regardless of, the last applied revision. Consumed by the game controller. */
      discardAnimation: boolean;
      /** One-shot: set on reconnect so the next non-stale duel-status is applied as a forced resync (see #handleConnection). */
      forceNextStatus: boolean;
    }
  | {
      readonly kind: 'complete';
      readonly matchId: string;
      readonly result: MultiplayerLocalResult;
      localReady: boolean;
      opponentReady: boolean;
    }
  | { readonly kind: 'incompatible'; readonly error: MultiplayerCompatibilityError };

export class SharedBoardSessionController {
  readonly #roomId: string;
  readonly #playerId: string;
  readonly #definition: MultiplayerModeDefinition;
  readonly #mode: MultiplayerModeIdentity;
  readonly #clock: SessionClock;
  readonly #transport: SharedBoardTransport;
  readonly #chatLog: MultiplayerChatLog;
  readonly #unsubMessage: () => void;
  readonly #unsubConnection: () => void;
  #connection: MultiplayerConnectionState;
  #lifecycle: MatchLifecycle;
  #opponentJoined = false;
  #opponentConnected = false;
  // Diagnostic only: timestamps a local play-turn send so the matching
  // turn-played can log a round-trip latency. Cleared on apply or on any
  // resync that makes the pairing unreliable (see #handleDuelStatus).
  #lastSubmitAt: number | null = null;

  constructor(options: SharedBoardSessionControllerOptions) {
    this.#roomId = options.roomId;
    this.#playerId = options.playerId;
    this.#definition = options.mode;
    this.#mode = { id: options.mode.id, version: options.mode.version, rules: { id: options.mode.rules.id, version: options.mode.rules.version } };
    this.#clock = options.clock;
    this.#transport = options.transport;
    this.#connection = 'connected';
    this.#lifecycle = { kind: 'lobby', localReady: false, opponentReady: false };
    this.#chatLog = new MultiplayerChatLog(this.#playerId);

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
    if (lifecycle.kind !== 'playing' || !lifecycle.isMyTurn || lifecycle.paused) {
      console.debug('[shared-duel] playTurn ignored: not a legal moment to play', {
        lifecycleKind: lifecycle.kind,
        isMyTurn: lifecycle.kind === 'playing' ? lifecycle.isMyTurn : null,
        paused: lifecycle.kind === 'playing' && lifecycle.paused !== null,
      });
      return;
    }
    if (this.#connection !== 'connected') {
      console.debug('[shared-duel] playTurn ignored: transport not connected', { connection: this.#connection });
      return;
    }
    if (lifecycle.turnSubmissionPending) {
      console.debug('[shared-duel] playTurn ignored: a submission is already pending');
      return;
    }
    lifecycle.turnSubmissionPending = true;
    this.#lastSubmitAt = this.#clock.now();
    console.log(`[shared-duel] playTurn sending column=${column} revision=${lifecycle.revision}`);
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
    if (this.#connection !== 'connected') return;
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
    if (lifecycle.kind !== 'playing' || this.#connection !== 'connected') {
      console.debug('[shared-duel] requestPause ignored', { paused, lifecycleKind: lifecycle.kind, connection: this.#connection });
      return;
    }
    console.log(`[shared-duel] requestPause sending: ${paused}`);
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
    if (lifecycle.kind !== 'playing' || this.#connection !== 'connected') {
      console.debug('[shared-duel] forfeit ignored', { lifecycleKind: lifecycle.kind, connection: this.#connection });
      return;
    }
    console.log('[shared-duel] forfeit sending');
    this.#transport.send({
      protocolVersion: MULTIPLAYER_PROTOCOL_VERSION,
      roomId: this.#roomId,
      playerId: this.#playerId,
      type: 'forfeit-match',
      matchId: lifecycle.match.matchId,
    });
  }

  /** Sends a chat message; returns false when it can't be sent (disconnected, empty, or too long). */
  sendChat(text: string): boolean {
    if (this.#connection !== 'connected') return false;
    const normalized = normalizeChatText(text);
    if (!normalized) return false;
    this.#transport.send({
      protocolVersion: MULTIPLAYER_PROTOCOL_VERSION,
      roomId: this.#roomId,
      playerId: this.#playerId,
      type: 'send-chat',
      text: normalized,
    });
    return true;
  }

  /** One-shot: returns the most recent unconsumed turn result, if any, for the caller to animate. */
  consumePendingTurnResult(): PendingTurnResult | null {
    const lifecycle = this.#lifecycle;
    if (lifecycle.kind !== 'playing' || !lifecycle.pendingTurnResult) return null;
    const pending = lifecycle.pendingTurnResult;
    lifecycle.pendingTurnResult = null;
    return pending;
  }

  /** One-shot: true when the game controller must cancel any in-flight animation because a status just corrected state past it (reconnect fast-forward or a missed revision). */
  consumeAnimationDiscard(): boolean {
    const lifecycle = this.#lifecycle;
    if (lifecycle.kind !== 'playing' || !lifecycle.discardAnimation) return false;
    lifecycle.discardAnimation = false;
    // A pending result predating the correcting snapshot is just as stale as
    // an animation already in progress. Clear both sides of that handoff
    // atomically so the game loop cannot cancel one and immediately start the
    // other on the same frame.
    lifecycle.pendingTurnResult = null;
    return true;
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
      case 'duel-status':
        this.#handleDuelStatus(message);
        break;
      case 'opponent-progress':
        break;
      case 'chat-message':
        this.#chatLog.receive({ playerId: message.playerId, text: message.text });
        break;
      case 'chat-rate-limited':
        this.#chatLog.noteThrottled();
        break;
    }
  }

  #currentMatchId(): string | null {
    const lifecycle = this.#lifecycle;
    switch (lifecycle.kind) {
      case 'countdown':
      case 'playing':
        return lifecycle.match.matchId;
      case 'complete':
        return lifecycle.matchId;
      default:
        return null;
    }
  }

  #handleMatchPaused(message: MultiplayerServerMessage & { type: 'match-paused' }): void {
    const lifecycle = this.#lifecycle;
    if (lifecycle.kind !== 'playing' || message.matchId !== lifecycle.match.matchId) return;
    if (message.paused
      && message.pausedBy !== this.#playerId
      && lifecycle.opponentPlayerId !== null
      && message.pausedBy !== lifecycle.opponentPlayerId) {
      this.#failCompatibility('session-mismatch', { reason: 'match-paused player outside match', message });
      return;
    }
    console.log(`[shared-duel] match-paused: ${message.paused} (by ${message.pausedBy})`);
    lifecycle.paused = message.paused
      ? {
          by: message.pausedBy,
          remainingMs: lifecycle.paused?.remainingMs
            ?? Math.max(0, lifecycle.turnDeadline - this.#clock.now()),
        }
      : null;
    // The server's deadline is authoritative and shifts forward on resume —
    // resync rather than trying to replicate its elapsed-time math here.
    lifecycle.turnDeadline = message.deadline;
  }

  #handleRoomState(message: MultiplayerServerMessage & { type: 'room-state' }): void {
    this.#opponentJoined = message.opponentJoined;
    this.#opponentConnected = message.opponentConnected;
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
    if (lifecycle.kind !== 'countdown' && lifecycle.kind !== 'playing') {
      console.debug('[shared-duel] turn-assigned ignored: lifecycle is', lifecycle.kind);
      return;
    }
    if (message.matchId !== lifecycle.match.matchId) {
      console.warn('[shared-duel] turn-assigned ignored: matchId mismatch', {
        expected: lifecycle.match.matchId, got: message.matchId,
      });
      return;
    }
    if (lifecycle.kind === 'playing'
      && lifecycle.revision !== undefined
      && message.revision !== lifecycle.revision) {
      // turn-assigned is paired with the resolution at the same revision. A
      // different revision means an event was missed (or this assignment is
      // stale); only duel-status may bridge that gap authoritatively.
      console.warn('[shared-duel] turn-assigned DROPPED: revision mismatch, waiting on duel-status to resync', {
        expectedRevision: lifecycle.revision, gotRevision: message.revision,
      });
      return;
    }

    const board = message.board;
    const isMyTurn = message.playerId === this.#playerId;
    console.debug('[shared-duel] turn-assigned applied', { revision: message.revision, isMyTurn });

    this.#lifecycle = {
      kind: 'playing',
      match: lifecycle.match,
      board,
      localScore: lifecycle.kind === 'playing' ? lifecycle.localScore : 0,
      opponentScore: lifecycle.kind === 'playing' ? lifecycle.opponentScore : 0,
      isMyTurn,
      turnDeadline: message.turnDeadline,
      columnCursor: lifecycle.kind === 'playing' ? lifecycle.columnCursor : 3,
      // A fresh turn means the opponent hasn't hovered anywhere yet — the
      // paired duel-status that always follows corrects this to the
      // opponent's real stored cursor (column 3 by default) immediately.
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
      opponentPlayerId: message.playerId !== this.#playerId
        ? message.playerId
        : lifecycle.kind === 'playing' ? lifecycle.opponentPlayerId : null,
      revision: message.revision,
      turnSubmissionPending: false,
      discardAnimation: lifecycle.kind === 'playing' ? lifecycle.discardAnimation : false,
      forceNextStatus: lifecycle.kind === 'playing' ? lifecycle.forceNextStatus : false,
    };
  }

  #handleTurnPlayed(message: MultiplayerServerMessage & { type: 'turn-played' | 'turn-expired' }): void {
    const lifecycle = this.#lifecycle;
    if (lifecycle.kind !== 'playing' || message.matchId !== lifecycle.match.matchId) {
      console.debug('[shared-duel] turn-played/expired ignored: lifecycle/match mismatch', { lifecycleKind: lifecycle.kind });
      return;
    }
    // Incremental events are safe only when they are exactly next. Duplicate,
    // stale, or skipped revisions wait for the paired authoritative status;
    // applying a delta across a gap would corrupt scores and animation state.
    if (lifecycle.revision === undefined || message.revision !== lifecycle.revision + 1) {
      console.warn('[shared-duel] turn-played/expired DROPPED: revision gap, waiting on duel-status to resync', {
        expectedRevision: lifecycle.revision === undefined ? undefined : lifecycle.revision + 1,
        gotRevision: message.revision,
      });
      return;
    }
    console.debug(`[shared-duel] ${message.type} applied`, {
      revision: message.revision, triggerPlayerId: message.turnResult.playerId, gameOver: message.turnResult.gameOver,
    });

    const boardBefore = lifecycle.board;
    lifecycle.board = message.board;
    lifecycle.pendingTurnResult = {
      boardBefore,
      steps: message.turnResult.steps,
      triggerPlayerId: message.turnResult.playerId,
      triggerScoreDelta: message.turnResult.triggerScoreDelta,
      opponentScoreDelta: message.turnResult.opponentScoreDelta,
    };
    if (message.turnResult.playerId === this.#playerId) {
      lifecycle.localScore += message.turnResult.triggerScoreDelta;
      lifecycle.opponentScore += message.turnResult.opponentScoreDelta;
      if (this.#lastSubmitAt !== null) {
        console.log(`[shared-duel] turn round-trip: ${Math.round(this.#clock.now() - this.#lastSubmitAt)}ms`);
        this.#lastSubmitAt = null;
      }
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
    lifecycle.revision = message.revision;
    lifecycle.turnSubmissionPending = false;
  }

  #handleOpponentCursor(message: MultiplayerServerMessage & { type: 'opponent-cursor' }): void {
    const lifecycle = this.#lifecycle;
    if (lifecycle.kind !== 'playing'
      || message.matchId !== lifecycle.match.matchId
      || message.playerId === this.#playerId) return;
    lifecycle.opponentColumnCursor = message.column;
  }

  #handleDuelStatus(message: MultiplayerServerMessage & { type: 'duel-status' }): void {
    const lifecycle = this.#lifecycle;
    if (lifecycle.kind !== 'playing' || message.matchId !== lifecycle.match.matchId) return;

    const localScoreEntry = message.scores.find(score => score.playerId === this.#playerId);
    const opponentScoreEntry = message.scores.find(score => score.playerId !== this.#playerId);
    if (!localScoreEntry || !opponentScoreEntry) {
      this.#failCompatibility('session-mismatch', { reason: 'duel-status missing local player score', message });
      return;
    }
    if (message.activePlayerId !== localScoreEntry.playerId && message.activePlayerId !== opponentScoreEntry.playerId) {
      this.#failCompatibility('session-mismatch', { reason: 'duel-status active player outside score pair', message });
      return;
    }
    if (message.paused
      && message.pausedBy !== localScoreEntry.playerId
      && message.pausedBy !== opponentScoreEntry.playerId) {
      this.#failCompatibility('session-mismatch', { reason: 'duel-status paused player outside score pair', message });
      return;
    }

    if (lifecycle.revision !== undefined && message.revision < lifecycle.revision) {
      // Stale pulse — a newer revision has already been applied. Even a
      // reconnect snapshot can't be genuinely older than what's already
      // applied (the server always builds it from current match state), so
      // this holds unconditionally rather than only outside a reconnect.
      console.debug('[shared-duel] duel-status ignored: stale', {
        currentRevision: lifecycle.revision, statusRevision: message.revision,
      });
      return;
    }
    const isReconnectResync = lifecycle.forceNextStatus;
    const isNewerRevision = lifecycle.revision === undefined || message.revision > lifecycle.revision;
    if (isNewerRevision || isReconnectResync) {
      // Ahead of the applied revision: the tab missed one or more events.
      // Equal revision right after reconnect: still discard, since the
      // animation (if any) was left over from before the gap and can't be
      // trusted to represent the authoritative state below.
      console.warn('[shared-duel] duel-status forcing a resync — animation discarded, snapping to authoritative state', {
        reason: isReconnectResync ? 'reconnect' : 'missed-revision',
        currentRevision: lifecycle.revision, statusRevision: message.revision,
      });
      lifecycle.discardAnimation = true;
      lifecycle.pendingTurnResult = null;
      // Whatever our own pending submission was waiting on is now subsumed
      // by this snapshot — it will never get a clean turn-played to measure.
      this.#lastSubmitAt = null;
    }
    lifecycle.forceNextStatus = false;

    lifecycle.board = message.board;
    lifecycle.localScore = localScoreEntry.score;
    lifecycle.opponentScore = opponentScoreEntry.score;
    lifecycle.isMyTurn = message.activePlayerId === this.#playerId;
    const remainingMs = Math.max(0, message.turnDeadline - message.serverTime);
    lifecycle.turnDeadline = this.#clock.now() + remainingMs;
    lifecycle.currentDisc = message.currentDisc;
    lifecycle.nextDisc = message.nextDisc;
    lifecycle.level = message.level;
    lifecycle.turnsPerLevel = message.turnsPerLevel;
    lifecycle.turnsRemaining = message.turnsRemaining;
    lifecycle.paused = message.paused ? { by: message.pausedBy as string, remainingMs } : null;
    lifecycle.opponentPlayerId = opponentScoreEntry.playerId;
    // Never overwrite the responsive local columnCursor from a pulse — only
    // the opponent's ghost is authoritatively driven by activeColumn here.
    lifecycle.opponentColumnCursor = message.activePlayerId !== this.#playerId ? message.activeColumn : null;
    lifecycle.revision = message.revision;
    // A periodic same-revision pulse is not an acknowledgement of a submitted
    // action; clearing here would allow a duplicate drop. Revision advancement,
    // reconnect resync, or a corrective turn-assigned snapshot clears it.
    if (isNewerRevision || isReconnectResync) lifecycle.turnSubmissionPending = false;
  }

  #handleMatchFinished(message: MultiplayerServerMessage & { type: 'match-finished' }): void {
    if (message.matchId !== this.#currentMatchId()) {
      console.debug('[shared-duel] match-finished ignored: matchId mismatch', { got: message.matchId });
      return;
    }
    const localResult = localizeMultiplayerResult(message.result, this.#playerId);
    if (!localResult) {
      console.warn('[shared-duel] match-finished: could not localize result', message.result);
      return;
    }
    console.log('[shared-duel] match finished', localResult);
    this.#lifecycle = {
      kind: 'complete',
      matchId: message.matchId,
      result: localResult,
      localReady: false,
      opponentReady: false,
    };
  }

  #handleConnection(state: MultiplayerConnectionState): void {
    const wasConnected = this.#connection === 'connected';
    console.log(`[shared-duel] session sees connection: ${this.#connection} -> ${state}`);
    this.#connection = state;
    if (state === 'connected' && !wasConnected && this.#lifecycle.kind === 'playing') {
      // The next duel-status must be applied unconditionally, even if its
      // revision happens to equal what we last applied — a reconnect gap
      // may have left stale presentation (a pause banner, an in-flight
      // animation) that only a forced resync will clear.
      console.warn('[shared-duel] reconnected mid-match: next duel-status will force a resync');
      this.#lifecycle.forceNextStatus = true;
    }
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
        opponentPlayerId: null,
        revision: undefined,
        turnSubmissionPending: false,
        discardAnimation: false,
        forceNextStatus: false,
      };
    }
  }

  // UI shows only the category; preserve the offending payload in diagnostics.
  #failCompatibility(error: MultiplayerCompatibilityError, detail?: unknown): void {
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
    const remainingMs = lifecycle.kind === 'playing' && lifecycle.paused
      ? lifecycle.paused.remainingMs
      : target === null ? null : Math.max(0, target - now);

    return {
      phase,
      connection: this.#connection,
      roomId: this.#roomId,
      playerId: this.#playerId,
      mode: this.#mode,
      localReady: lifecycle.kind === 'lobby' || lifecycle.kind === 'complete' ? lifecycle.localReady : true,
      opponentReady: lifecycle.kind === 'lobby' || lifecycle.kind === 'complete' ? lifecycle.opponentReady : true,
      opponentJoined: this.#opponentJoined,
      opponentConnected: this.#opponentConnected,
      matchId: ('match' in lifecycle && lifecycle.match) ? lifecycle.match.matchId : null,
      startsAt: ('match' in lifecycle && lifecycle.match) ? lifecycle.match.startsAt : null,
      remainingMs,
      isMyTurn: lifecycle.kind === 'playing' ? lifecycle.isMyTurn : false,
      turnDeadline: lifecycle.kind === 'playing' ? lifecycle.turnDeadline : null,
      turnSubmissionPending: lifecycle.kind === 'playing' && lifecycle.turnSubmissionPending,
      localScore: lifecycle.kind === 'playing' ? lifecycle.localScore : 0,
      opponentScore: lifecycle.kind === 'playing' ? lifecycle.opponentScore : 0,
      opponentPlayerId: lifecycle.kind === 'playing' ? lifecycle.opponentPlayerId : null,
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
      messages: this.#chatLog.view,
    };
  }

  #derivePhase(): MultiplayerPhase {
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
