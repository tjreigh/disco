import type { TurnResult } from '../game/engine.js';
import type { MultiplayerModeDefinition } from '../game/modes/mode.js';
import {
  localizeMultiplayerResult,
  multiplayerModeIdentity,
  MULTIPLAYER_PROTOCOL_VERSION,
  sameMultiplayerModeIdentity,
} from '../shared/multiplayer-contracts.js';
import { parseMultiplayerServerMessage } from '../shared/multiplayer-messages.js';
import type {
  MultiplayerClientMessage,
  MultiplayerConnectionState,
  MultiplayerLocalResult,
  MultiplayerModeIdentity,
  MultiplayerPlayerProgress,
  MultiplayerProgress,
} from '../shared/multiplayer-contracts.js';
import { LocalBoardSession } from './local-board-session.js';
import type { LocalBoardSessionView } from './local-board-session.js';

export interface SessionClock {
  now(): number;
}

export interface MultiplayerSessionTransport {
  send(message: MultiplayerClientMessage): void;
  subscribe(listener: (message: unknown) => void): () => void;
  subscribeConnection(listener: (state: MultiplayerConnectionState) => void): () => void;
}

export type MultiplayerLocalPhase =
  | 'lobby'
  | 'ready'
  | 'countdown'
  | 'playing'
  | 'finished'
  | 'disconnected'
  | 'reconnecting';

export type MultiplayerCompatibilityError =
  | 'invalid-message'
  | 'protocol-mismatch'
  | 'rules-mismatch'
  | 'session-mismatch';

export interface MultiplayerSessionView {
  readonly phase: MultiplayerLocalPhase;
  readonly connection: MultiplayerConnectionState;
  readonly roomId: string;
  readonly playerId: string;
  readonly mode: MultiplayerModeIdentity;
  readonly localReady: boolean;
  readonly opponentReady: boolean;
  readonly matchId: string | null;
  readonly startsAt: number | null;
  readonly deadline: number | null;
  readonly remainingMs: number | null;
  readonly opponent: MultiplayerPlayerProgress | null;
  readonly result: MultiplayerLocalResult | null;
  readonly compatibilityError: MultiplayerCompatibilityError | null;
  readonly board: LocalBoardSessionView;
}

export interface MultiplayerSessionControllerOptions {
  readonly roomId: string;
  readonly playerId: string;
  readonly mode: MultiplayerModeDefinition;
  readonly clock: SessionClock;
  readonly transport: MultiplayerSessionTransport;
}

interface MatchContext {
  readonly matchId: string;
  readonly startsAt: number;
  readonly deadline: number;
  readonly seed: number;
  readonly opponent: MultiplayerPlayerProgress | null;
}

type MatchLifecycle =
  | {
    readonly kind: 'lobby';
    readonly localReady: boolean;
    readonly opponentReady: boolean;
  }
  | { readonly kind: 'countdown'; readonly match: MatchContext }
  | { readonly kind: 'playing'; readonly match: MatchContext }
  | { readonly kind: 'awaiting-result'; readonly match: MatchContext }
  | {
    readonly kind: 'complete';
    readonly match: MatchContext;
    readonly result: MultiplayerLocalResult;
  }
  | {
    readonly kind: 'incompatible';
    readonly error: MultiplayerCompatibilityError;
  };

type WithoutClientEnvelope<T> = T extends MultiplayerClientMessage
  ? Omit<T, 'protocolVersion' | 'roomId' | 'playerId'>
  : never;
type MultiplayerClientPayload = WithoutClientEnvelope<MultiplayerClientMessage>;

/**
 * Client-side timed-match lifecycle around one local board.
 *
 * Match lifecycle and transport connection are independent state axes. Network
 * input is parsed at this boundary before it can affect either state machine.
 */
export class MultiplayerSessionController {
  private readonly roomId: string;
  private readonly playerId: string;
  private readonly definition: MultiplayerModeDefinition;
  private readonly mode: MultiplayerModeIdentity;
  private readonly clock: SessionClock;
  private readonly transport: MultiplayerSessionTransport;
  private readonly session: LocalBoardSession;
  private readonly unsubscribeMessages: () => void;
  private readonly unsubscribeConnection: () => void;
  private lifecycle: MatchLifecycle = {
    kind: 'lobby',
    localReady: false,
    opponentReady: false,
  };
  private connection: MultiplayerConnectionState = 'connected';
  private progressSequence = 0;

  constructor(options: MultiplayerSessionControllerOptions) {
    this.roomId = options.roomId;
    this.playerId = options.playerId;
    this.definition = options.mode;
    this.mode = multiplayerModeIdentity(options.mode);
    this.clock = options.clock;
    this.transport = options.transport;
    this.session = new LocalBoardSession({
      rules: options.mode.rules,
      events: {
        onStableTurn: result => this.publishStableTurn(result),
      },
    });
    this.session.enterMenu();
    this.unsubscribeMessages = this.transport.subscribe(message => this.receive(message));
    this.unsubscribeConnection = this.transport.subscribeConnection(state => {
      this.handleConnection(state);
    });
  }

  get view(): MultiplayerSessionView {
    const match = this.matchContext();
    const now = this.clock.now();
    const target = this.lifecycle.kind === 'countdown'
      ? match?.startsAt ?? null
      : match?.deadline ?? null;
    return {
      phase: this.localPhase(),
      connection: this.connection,
      roomId: this.roomId,
      playerId: this.playerId,
      mode: this.mode,
      localReady: this.lifecycle.kind === 'lobby' ? this.lifecycle.localReady : true,
      opponentReady: this.lifecycle.kind === 'lobby' ? this.lifecycle.opponentReady : true,
      matchId: match?.matchId ?? null,
      startsAt: match?.startsAt ?? null,
      deadline: match?.deadline ?? null,
      remainingMs: target === null ? null : Math.max(0, target - now),
      opponent: match?.opponent ?? null,
      result: this.lifecycle.kind === 'complete' ? this.lifecycle.result : null,
      compatibilityError: this.lifecycle.kind === 'incompatible'
        ? this.lifecycle.error
        : null,
      board: this.session.view,
    };
  }

  setReady(ready: boolean): void {
    if (this.connection !== 'connected' || this.lifecycle.kind !== 'lobby') return;
    this.lifecycle = { ...this.lifecycle, localReady: ready };
    this.send({ type: 'set-ready', ready });
  }

  move(lane: number): boolean {
    if (!this.acceptsGameplay()) return false;
    this.session.moveCursor(this.clampLane(lane));
    return true;
  }

  drop(lane: number): TurnResult | null {
    if (!this.acceptsGameplay()) return null;
    return this.session.drop(this.clampLane(lane));
  }

  stageDrop(lane: number): boolean {
    if (!this.acceptsGameplay()) return false;
    return this.session.stageDrop(this.clampLane(lane)) === undefined;
  }

  tilt(delta: number): boolean {
    if (!this.acceptsGameplay()) return false;
    this.session.tilt(delta);
    return true;
  }

  cancelTilt(): boolean {
    if (!this.acceptsGameplay()) return false;
    this.session.cancelTilt();
    return true;
  }

  commitTilt(): TurnResult | null {
    if (!this.acceptsGameplay()) return null;
    return this.session.commitTilt(this.clock.now());
  }

  tick(): void {
    this.advanceForClock();
    this.session.tick(this.clock.now());
  }

  destroy(): void {
    this.unsubscribeMessages();
    this.unsubscribeConnection();
  }

  private receive(value: unknown): void {
    if (this.lifecycle.kind === 'incompatible') return;
    const parsed = parseMultiplayerServerMessage(value);
    if (!parsed.ok) {
      this.failCompatibility(parsed.error);
      return;
    }
    const message = parsed.message;
    if (message.roomId !== this.roomId) return;
    if (!sameMultiplayerModeIdentity(message.mode, this.mode)) {
      this.failCompatibility('rules-mismatch');
      return;
    }

    switch (message.type) {
      case 'room-state':
        if (this.lifecycle.kind !== 'lobby') return;
        this.lifecycle = {
          kind: 'lobby',
          localReady: message.localReady,
          opponentReady: message.opponentReady,
        };
        break;
      case 'match-countdown':
        if (this.lifecycle.kind !== 'lobby') return;
        if (message.deadline - message.startsAt !== this.definition.session.durationMs) {
          this.failCompatibility('session-mismatch');
          return;
        }
        this.progressSequence = 0;
        this.lifecycle = {
          kind: 'countdown',
          match: {
            matchId: message.matchId,
            startsAt: message.startsAt,
            deadline: message.deadline,
            seed: message.seed,
            opponent: null,
          },
        };
        this.advanceForClock();
        break;
      case 'opponent-progress':
        this.updateOpponent(message.matchId, message.progress);
        break;
      case 'match-finished':
        this.completeMatch(message.matchId, message.result);
        break;
    }
  }

  private handleConnection(state: MultiplayerConnectionState): void {
    if (state === this.connection) return;
    this.connection = state;
    if (state === 'disconnected') {
      this.session.pause(this.clock.now());
      return;
    }
    if (state === 'reconnecting') return;

    this.session.resume(this.clock.now());
    if (this.lifecycle.kind === 'incompatible' || this.lifecycle.kind === 'complete') return;
    const match = this.matchContext();
    this.send({
      type: 'resume-session',
      matchId: match?.matchId ?? null,
      lastProgressSequence: this.progressSequence,
    });
    if (this.lifecycle.kind === 'playing'
      && this.clock.now() < this.lifecycle.match.deadline) {
      this.send({
        type: 'publish-progress',
        matchId: this.lifecycle.match.matchId,
        progress: this.currentProgress(),
      });
    } else if (this.lifecycle.kind === 'playing') {
      this.finishLocalRun();
    } else if (this.lifecycle.kind === 'awaiting-result') {
      this.send({
        type: 'finish-match',
        matchId: this.lifecycle.match.matchId,
        progress: this.currentProgress(),
      });
    }
    this.advanceForClock();
  }

  private advanceForClock(): void {
    const now = this.clock.now();
    if (this.lifecycle.kind === 'countdown' && now >= this.lifecycle.match.startsAt) {
      const match = this.lifecycle.match;
      this.session.configure(this.definition.rules, match.seed);
      this.lifecycle = { kind: 'playing', match };
    }
    if (this.lifecycle.kind === 'playing'
      && now >= this.lifecycle.match.deadline
      && this.connection === 'connected') {
      this.finishLocalRun();
    }
  }

  private updateOpponent(matchId: string, progress: MultiplayerPlayerProgress): void {
    const match = this.matchContext();
    if (!match || match.matchId !== matchId || this.lifecycle.kind === 'complete') return;
    if (progress.playerId === this.playerId) {
      this.failCompatibility('invalid-message');
      return;
    }
    if (match.opponent && progress.sequence <= match.opponent.sequence) return;
    this.replaceMatch({ ...match, opponent: { ...progress } });
  }

  private completeMatch(
    matchId: string,
    result: Parameters<typeof localizeMultiplayerResult>[0],
  ): void {
    const match = this.matchContext();
    if (!match || match.matchId !== matchId || this.lifecycle.kind === 'complete') return;
    const localized = localizeMultiplayerResult(result, this.playerId);
    if (!localized) {
      this.failCompatibility('invalid-message');
      return;
    }
    this.lifecycle = { kind: 'complete', match, result: localized };
  }

  private publishStableTurn(result: TurnResult): void {
    if (!result.accepted || this.lifecycle.kind !== 'playing') return;
    this.progressSequence++;
    if (result.gameOver) {
      this.finishLocalRun();
      return;
    }
    this.send({
      type: 'publish-progress',
      matchId: this.lifecycle.match.matchId,
      progress: this.currentProgress(),
    });
  }

  private finishLocalRun(): void {
    if (this.lifecycle.kind !== 'playing') return;
    const match = this.lifecycle.match;
    this.send({
      type: 'finish-match',
      matchId: match.matchId,
      progress: this.currentProgress(),
    });
    this.lifecycle = { kind: 'awaiting-result', match };
  }

  private currentProgress(): MultiplayerProgress {
    return {
      sequence: this.progressSequence,
      score: this.session.state.score,
      turnsPlayed: this.session.state.dropCount,
    };
  }

  private acceptsGameplay(): boolean {
    if (this.connection !== 'connected' || this.lifecycle.kind !== 'playing') return false;
    if (this.clock.now() >= this.lifecycle.match.deadline) {
      this.finishLocalRun();
      return false;
    }
    return true;
  }

  private clampLane(lane: number): number {
    return Math.max(0, Math.min(this.session.view.laneCount - 1, lane));
  }

  private localPhase(): MultiplayerLocalPhase {
    if (this.lifecycle.kind === 'incompatible' || this.lifecycle.kind === 'complete') {
      return 'finished';
    }
    if (this.connection !== 'connected') return this.connection;
    switch (this.lifecycle.kind) {
      case 'lobby': return this.lifecycle.localReady ? 'ready' : 'lobby';
      case 'countdown': return 'countdown';
      case 'playing': return 'playing';
      case 'awaiting-result': return 'finished';
    }
  }

  private matchContext(): MatchContext | null {
    return this.lifecycle.kind === 'countdown'
      || this.lifecycle.kind === 'playing'
      || this.lifecycle.kind === 'awaiting-result'
      || this.lifecycle.kind === 'complete'
      ? this.lifecycle.match
      : null;
  }

  private replaceMatch(match: MatchContext): void {
    switch (this.lifecycle.kind) {
      case 'countdown':
      case 'playing':
      case 'awaiting-result':
        this.lifecycle = { kind: this.lifecycle.kind, match };
        break;
      case 'complete':
        this.lifecycle = { ...this.lifecycle, match };
        break;
      case 'lobby':
      case 'incompatible':
        break;
    }
  }

  private failCompatibility(error: MultiplayerCompatibilityError): void {
    this.lifecycle = { kind: 'incompatible', error };
  }

  private send(message: MultiplayerClientPayload): void {
    this.transport.send({
      protocolVersion: MULTIPLAYER_PROTOCOL_VERSION,
      roomId: this.roomId,
      playerId: this.playerId,
      ...message,
    } as MultiplayerClientMessage);
  }
}
