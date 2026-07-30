import type { TurnResult } from '../game/engine.js';
import type { GameRulesConfig } from '../game/modes/mode.js';
import {
  MULTIPLAYER_PROTOCOL_VERSION,
  rulesIdentity,
  sameRulesIdentity,
} from '../shared/multiplayer-contracts.js';
import type {
  MultiplayerClientMessage,
  MultiplayerConnectionState,
  MultiplayerModeIdentity,
  MultiplayerPlayerProgress,
  MultiplayerResult,
  MultiplayerServerMessage,
} from '../shared/multiplayer-contracts.js';
import { LocalBoardSession } from './local-board-session.js';
import type { LocalBoardSessionView } from './local-board-session.js';

export interface SessionClock {
  now(): number;
}

export interface MultiplayerSessionTransport {
  send(message: MultiplayerClientMessage): void;
  subscribe(listener: (message: MultiplayerServerMessage) => void): () => void;
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

export type MultiplayerCompatibilityError = 'protocol-mismatch' | 'rules-mismatch';

export interface MultiplayerSessionView {
  readonly phase: MultiplayerLocalPhase;
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
  readonly result: MultiplayerResult | null;
  readonly compatibilityError: MultiplayerCompatibilityError | null;
  readonly board: LocalBoardSessionView;
}

export interface MultiplayerSessionControllerOptions {
  readonly roomId: string;
  readonly playerId: string;
  readonly modeId: string;
  readonly rules: GameRulesConfig;
  readonly clock: SessionClock;
  readonly transport: MultiplayerSessionTransport;
}

/**
 * Client-side timed-match lifecycle around one local board.
 *
 * It deliberately knows nothing about accounts, solo saves/stats, tutorials,
 * or concrete sockets. Server messages supply countdown/deadline/result state;
 * an injected monotonic clock decides when local gameplay intents are accepted.
 */
export class MultiplayerSessionController {
  private readonly roomId: string;
  private readonly playerId: string;
  private readonly mode: MultiplayerModeIdentity;
  private readonly rules: GameRulesConfig;
  private readonly clock: SessionClock;
  private readonly transport: MultiplayerSessionTransport;
  private readonly session: LocalBoardSession;
  private readonly unsubscribeMessages: () => void;
  private readonly unsubscribeConnection: () => void;
  private phase: MultiplayerLocalPhase = 'lobby';
  private resumePhase: Exclude<MultiplayerLocalPhase, 'disconnected' | 'reconnecting'> = 'lobby';
  private localReady = false;
  private opponentReady = false;
  private matchId: string | null = null;
  private startsAt: number | null = null;
  private deadline: number | null = null;
  private seed: number | null = null;
  private matchStarted = false;
  private finishSent = false;
  private progressSequence = 0;
  private opponent: MultiplayerPlayerProgress | null = null;
  private result: MultiplayerResult | null = null;
  private compatibilityError: MultiplayerCompatibilityError | null = null;

  constructor(options: MultiplayerSessionControllerOptions) {
    this.roomId = options.roomId;
    this.playerId = options.playerId;
    this.mode = {
      modeId: options.modeId,
      rules: rulesIdentity(options.rules),
    };
    this.rules = options.rules;
    this.clock = options.clock;
    this.transport = options.transport;
    this.session = new LocalBoardSession({
      rules: options.rules,
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
    const now = this.clock.now();
    const target = this.phase === 'countdown' ? this.startsAt : this.deadline;
    return {
      phase: this.phase,
      roomId: this.roomId,
      playerId: this.playerId,
      mode: this.mode,
      localReady: this.localReady,
      opponentReady: this.opponentReady,
      matchId: this.matchId,
      startsAt: this.startsAt,
      deadline: this.deadline,
      remainingMs: target === null ? null : Math.max(0, target - now),
      opponent: this.opponent,
      result: this.result,
      compatibilityError: this.compatibilityError,
      board: this.session.view,
    };
  }

  setReady(ready: boolean): void {
    if (this.phase !== 'lobby' && this.phase !== 'ready') return;
    this.localReady = ready;
    this.phase = ready ? 'ready' : 'lobby';
    this.resumePhase = this.phase;
    this.transport.send(this.baseMessage({
      type: 'set-ready',
      ready,
    }));
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
    const now = this.clock.now();
    if (this.phase === 'countdown' && this.startsAt !== null && now >= this.startsAt) {
      this.startMatch();
    }
    if (this.phase === 'playing' && this.deadline !== null && now >= this.deadline) {
      this.finishAtDeadline();
    }
    this.session.tick(now);
  }

  destroy(): void {
    this.unsubscribeMessages();
    this.unsubscribeConnection();
  }

  private receive(message: MultiplayerServerMessage): void {
    if (message.roomId !== this.roomId) return;
    if (message.protocolVersion !== MULTIPLAYER_PROTOCOL_VERSION) {
      this.failCompatibility('protocol-mismatch');
      return;
    }
    if (
      message.mode.modeId !== this.mode.modeId
      || !sameRulesIdentity(message.mode.rules, this.mode.rules)
    ) {
      this.failCompatibility('rules-mismatch');
      return;
    }

    switch (message.type) {
      case 'room-state':
        if (this.matchId !== null) return;
        this.localReady = message.localReady;
        this.opponentReady = message.opponentReady;
        this.phase = this.localReady ? 'ready' : 'lobby';
        this.resumePhase = this.phase;
        break;
      case 'match-countdown':
        if (message.startsAt >= message.deadline) return;
        this.matchId = message.matchId;
        this.startsAt = message.startsAt;
        this.deadline = message.deadline;
        this.seed = message.seed;
        this.matchStarted = false;
        this.finishSent = false;
        this.progressSequence = 0;
        this.opponent = null;
        this.result = null;
        this.phase = 'countdown';
        this.resumePhase = 'countdown';
        this.tick();
        break;
      case 'opponent-progress':
        if (message.matchId !== this.matchId) return;
        if (this.opponent && message.progress.sequence <= this.opponent.sequence) return;
        this.opponent = { ...message.progress };
        break;
      case 'match-finished':
        if (message.matchId !== this.matchId) return;
        this.result = { ...message.result };
        this.phase = 'finished';
        this.resumePhase = 'finished';
        break;
    }
  }

  private handleConnection(state: MultiplayerConnectionState): void {
    if (state === 'disconnected') {
      if (this.phase !== 'disconnected' && this.phase !== 'reconnecting') {
        this.resumePhase = this.phase;
      }
      this.phase = 'disconnected';
      this.session.pause(this.clock.now());
      return;
    }
    if (state === 'reconnecting') {
      this.phase = 'reconnecting';
      return;
    }

    if (this.phase !== 'disconnected' && this.phase !== 'reconnecting') return;
    this.restoreConnectedPhase();
    this.session.resume(this.clock.now());
    this.transport.send(this.baseMessage({
      type: 'resume-session',
      matchId: this.matchId,
      lastProgressSequence: this.progressSequence,
    }));
  }

  private restoreConnectedPhase(): void {
    const now = this.clock.now();
    if (this.deadline !== null && now >= this.deadline) {
      this.phase = 'playing';
      this.finishAtDeadline();
    } else if (this.startsAt !== null && now >= this.startsAt) {
      this.startMatch();
    } else {
      this.phase = this.resumePhase;
    }
  }

  private startMatch(): void {
    if (!this.matchStarted) {
      this.session.configure(this.rules, this.seed ?? undefined);
      this.matchStarted = true;
    }
    this.phase = 'playing';
    this.resumePhase = 'playing';
  }

  private finishAtDeadline(): void {
    if (!this.matchId || this.finishSent) {
      this.phase = 'finished';
      this.resumePhase = 'finished';
      return;
    }
    this.finishSent = true;
    const progress = this.currentProgress(true);
    this.transport.send(this.baseMessage({
      type: 'finish-match',
      matchId: this.matchId,
      progress,
    }));
    this.phase = 'finished';
    this.resumePhase = 'finished';
  }

  private publishStableTurn(result: TurnResult): void {
    if (!result.accepted || this.phase !== 'playing' || !this.matchId) return;
    this.progressSequence++;
    if (result.gameOver) {
      this.finishSent = true;
      this.transport.send(this.baseMessage({
        type: 'finish-match',
        matchId: this.matchId,
        progress: this.currentProgress(true),
      }));
      this.phase = 'finished';
      this.resumePhase = 'finished';
      return;
    }
    this.transport.send(this.baseMessage({
      type: 'publish-progress',
      matchId: this.matchId,
      progress: this.currentProgress(false),
    }));
  }

  private currentProgress(finished: boolean): MultiplayerPlayerProgress {
    return {
      playerId: this.playerId,
      sequence: this.progressSequence,
      score: this.session.state.score,
      turnsPlayed: this.session.state.dropCount,
      finished,
    };
  }

  private acceptsGameplay(): boolean {
    if (this.phase !== 'playing') return false;
    if (this.deadline !== null && this.clock.now() >= this.deadline) {
      this.finishAtDeadline();
      return false;
    }
    return true;
  }

  private clampLane(lane: number): number {
    return Math.max(0, Math.min(this.session.view.laneCount - 1, lane));
  }

  private failCompatibility(error: MultiplayerCompatibilityError): void {
    this.compatibilityError = error;
    this.phase = 'finished';
    this.resumePhase = 'finished';
  }

  private baseMessage<T extends Omit<MultiplayerClientMessage, 'protocolVersion' | 'roomId' | 'playerId'>>(
    message: T,
  ): T & {
    protocolVersion: typeof MULTIPLAYER_PROTOCOL_VERSION;
    roomId: string;
    playerId: string;
  } {
    return {
      protocolVersion: MULTIPLAYER_PROTOCOL_VERSION,
      roomId: this.roomId,
      playerId: this.playerId,
      ...message,
    };
  }
}

export class FakeMultiplayerTransport implements MultiplayerSessionTransport {
  readonly sent: MultiplayerClientMessage[] = [];

  private messageListener: ((message: MultiplayerServerMessage) => void) | null = null;
  private connectionListener: ((state: MultiplayerConnectionState) => void) | null = null;

  send(message: MultiplayerClientMessage): void {
    this.sent.push(message);
  }

  subscribe(listener: (message: MultiplayerServerMessage) => void): () => void {
    this.messageListener = listener;
    return () => {
      if (this.messageListener === listener) this.messageListener = null;
    };
  }

  subscribeConnection(listener: (state: MultiplayerConnectionState) => void): () => void {
    this.connectionListener = listener;
    return () => {
      if (this.connectionListener === listener) this.connectionListener = null;
    };
  }

  receive(message: MultiplayerServerMessage): void {
    this.messageListener?.(message);
  }

  setConnection(state: MultiplayerConnectionState): void {
    this.connectionListener?.(state);
  }
}
