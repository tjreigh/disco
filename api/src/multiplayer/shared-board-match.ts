import { randomInt } from 'node:crypto';
import { SHARED_DUEL_RULES } from '#game-modes';
import { GameEngine } from '#game-engine';
import type { TurnResult } from '#game-engine';
import type { PhysicsStep } from '#game-engine';
import { computeOwnerScoreDelta } from '#game-scoring';
import type { Board, Disc } from '#game-model';
import { MULTIPLAYER_PROTOCOL_VERSION } from '#multiplayer-contracts';
import type {
  MultiplayerModeIdentity,
  TurnResultWire,
  WireBoard,
  WireDisc,
  WireDropStep,
  WireClearStep,
  WireFallStep,
  WireRevealStep,
  WirePushStep,
  WireBonusStep,
  WireStep,
} from '#multiplayer-contracts';

export interface SharedBoardMatchConfig {
  readonly matchId: string;
  readonly playerIds: readonly [string, string];
  readonly seed: number;
  readonly turnTimeoutMs: number;
  readonly disruptionThreshold: number;
}

export class SharedBoardMatch {
  readonly id: string;
  readonly playerIds: readonly [string, string];
  readonly seed: number;
  readonly turnTimeoutMs: number;
  readonly disruptionThreshold: number;
  readonly engine: GameEngine;
  private readonly scores: Record<string, number>;
  currentPlayerIndex: number;
  turnDeadline: number;
  finished: boolean;

  constructor(config: SharedBoardMatchConfig) {
    this.id = config.matchId;
    this.playerIds = config.playerIds;
    this.seed = config.seed;
    this.turnTimeoutMs = config.turnTimeoutMs;
    this.disruptionThreshold = config.disruptionThreshold;
    this.engine = new GameEngine({ seed: config.seed, rules: SHARED_DUEL_RULES });
    this.scores = {};
    for (const id of config.playerIds) this.scores[id] = 0;
    this.currentPlayerIndex = 0;
    this.turnDeadline = 0;
    this.finished = false;
  }

  get currentPlayerId(): string {
    return this.playerIds[this.currentPlayerIndex]!;
  }

  get opponentId(): string {
    return this.playerIds[this.currentPlayerIndex === 0 ? 1 : 0]!;
  }

  getScore(playerId: string): number {
    return this.scores[playerId] ?? 0;
  }

  isCurrentPlayer(playerId: string): boolean {
    return !this.finished && playerId === this.currentPlayerId;
  }

  processTurn(playerId: string, column: number): MatchTurnResult {
    if (this.finished) {
      return { kind: 'rejected', reason: 'game-over' };
    }
    if (playerId !== this.currentPlayerId) {
      return { kind: 'rejected', reason: 'not-your-turn' };
    }

    const turnResult = this.engine.drop(column, playerId);
    if (!turnResult.accepted) {
      return { kind: 'rejected', reason: turnResult.reason ?? 'invalid' };
    }

    return this.resolveTurn(turnResult, playerId);
  }

  expireTurn(): MatchTurnResult {
    if (this.finished) {
      return { kind: 'rejected', reason: 'game-over' };
    }
    const playerId = this.currentPlayerId;
    const availableCol = this.randomAvailableColumn();
    if (availableCol === null) {
      this.finished = true;
      return {
        kind: 'accepted',
        gameOver: true,
        playerId,
        column: null,
        triggerScoreDelta: 0,
        opponentScoreDelta: 0,
        stackSize: 0,
        board: this.serializeBoard(),
        steps: [],
        gameOverReason: 'board-full',
      };
    }

    const turnResult = this.engine.drop(availableCol, playerId);
    if (!turnResult.accepted) {
      this.finished = true;
      return {
        kind: 'accepted',
        gameOver: true,
        playerId,
        column: availableCol,
        triggerScoreDelta: 0,
        opponentScoreDelta: 0,
        stackSize: 0,
        board: this.serializeBoard(),
        steps: [],
        gameOverReason: turnResult.gameOverReason ?? 'board-full',
      };
    }

    return this.resolveTurn(turnResult, playerId);
  }

  setTurnTimer(now: number): void {
    this.turnDeadline = now + this.turnTimeoutMs;
  }

  isTurnExpired(now: number): boolean {
    return !this.finished && this.turnDeadline > 0 && now >= this.turnDeadline;
  }

  serializeBoard(): WireBoard {
    return serializeBoardForWire(this.engine.state.board);
  }

  private discSnapshot() {
    return {
      currentDisc: toWireDisc(this.engine.state.currentDisc),
      nextDisc: toWireDisc(this.engine.state.nextDisc),
      level: this.engine.state.level,
      turnsPerLevel: this.engine.state.turnsPerLevel,
      turnsRemaining: this.engine.state.turnsRemaining,
    };
  }

  buildTurnAssignedMessage(
    roomId: string,
    mode: MultiplayerModeIdentity,
    matchId: string,
  ) {
    return {
      protocolVersion: MULTIPLAYER_PROTOCOL_VERSION,
      roomId,
      mode,
      type: 'turn-assigned' as const,
      matchId,
      playerId: this.currentPlayerId,
      turnDeadline: this.turnDeadline,
      board: this.serializeBoard(),
      ...this.discSnapshot(),
    };
  }

  buildTurnPlayedMessage(
    roomId: string,
    mode: MultiplayerModeIdentity,
    matchId: string,
    turnResult: TurnResultWire,
  ) {
    return {
      protocolVersion: MULTIPLAYER_PROTOCOL_VERSION,
      roomId,
      mode,
      type: 'turn-played' as const,
      matchId,
      board: this.serializeBoard(),
      turnResult,
      nextPlayerId: this.currentPlayerId,
      ...this.discSnapshot(),
    };
  }

  buildTurnExpiredMessage(
    roomId: string,
    mode: MultiplayerModeIdentity,
    matchId: string,
    turnResult: TurnResultWire,
  ) {
    return {
      protocolVersion: MULTIPLAYER_PROTOCOL_VERSION,
      roomId,
      mode,
      type: 'turn-expired' as const,
      matchId,
      board: this.serializeBoard(),
      turnResult,
      nextPlayerId: this.currentPlayerId,
      ...this.discSnapshot(),
    };
  }

  private resolveTurn(turnResult: TurnResult, playerId: string): MatchTurnResult {
    const scoreDelta = computeOwnerScoreDelta(turnResult.steps, {
      triggerPlayerId: playerId,
      opponentPlayerId: this.opponentId,
      disruptionThreshold: this.disruptionThreshold,
    });

    this.scores[playerId] = (this.scores[playerId] ?? 0) + scoreDelta.triggerDelta;
    this.scores[this.opponentId] = (this.scores[this.opponentId] ?? 0) + scoreDelta.opponentDelta;

    if (turnResult.gameOver) {
      this.finished = true;
      const wireResult = this.toWireResult(turnResult, playerId, scoreDelta);
      return {
        ...wireResult,
        kind: 'accepted' as const,
        gameOver: true as const,
        gameOverReason: turnResult.gameOverReason ?? 'board-full',
      };
    }

    this.currentPlayerIndex = this.currentPlayerIndex === 0 ? 1 : 0;

    return {
      ...this.toWireResult(turnResult, playerId, scoreDelta),
      kind: 'accepted' as const,
      gameOver: false as const,
    };
  }

  private toWireResult(turnResult: TurnResult, playerId: string, scoreDelta: { triggerDelta: number; opponentDelta: number }) {
    return {
      playerId,
      column: this.engine.state.cursorCol,
      triggerScoreDelta: scoreDelta.triggerDelta,
      opponentScoreDelta: scoreDelta.opponentDelta,
      stackSize: turnResult.stackSize,
      board: this.serializeBoard(),
      steps: serializeSteps(turnResult.steps),
    };
  }

  private randomAvailableColumn(): number | null {
    const cols = this.engine.state.board[0]!.length;
    const bottomRow = this.engine.state.board.length - 1;
    const available: number[] = [];
    for (let col = 0; col < cols; col++) {
      if (this.engine.state.board[bottomRow]![col] === null) available.push(col);
    }
    if (available.length === 0) return null;
    return available[randomInt(available.length)]!;
  }
}

export type MatchTurnResult =
  | {
      readonly kind: 'rejected';
      readonly reason: string;
    }
  | ({
      readonly kind: 'accepted';
      readonly gameOver: boolean;
      readonly playerId: string;
      readonly column: number | null;
      readonly triggerScoreDelta: number;
      readonly opponentScoreDelta: number;
      readonly stackSize: number;
      readonly board: WireBoard;
      readonly steps: readonly WireStep[];
    } & (
      | { readonly gameOver: false }
      | { readonly gameOver: true; readonly gameOverReason: 'push-overflow' | 'board-full' }
    ));

function toWireDisc(disc: Disc): WireDisc {
  if (disc.ownerId !== undefined) {
    return { id: disc.id, value: disc.value, kind: disc.kind as string, ownerId: disc.ownerId };
  }
  return { id: disc.id, value: disc.value, kind: disc.kind as string };
}

function serializeBoardForWire(board: Board): WireBoard {
  return board.map(row =>
    row.map(cell => {
      if (!cell) return null;
      return toWireDisc(cell);
    }),
  );
}

function serializeSteps(steps: readonly PhysicsStep[]): WireStep[] {
  const result: WireStep[] = [];
  for (const step of steps) {
    switch (step.kind) {
      case 'drop':
        result.push({
          kind: 'drop' as const,
          disc: toWireDisc(step.disc),
          entryPos: { row: step.entryPos.row, col: step.entryPos.col },
          landPos: { row: step.landPos.row, col: step.landPos.col },
        } satisfies WireDropStep);
        break;
      case 'clear':
        result.push({
          kind: 'clear' as const,
          cleared: step.cleared.map(p => ({ row: p.row, col: p.col })),
          discs: step.discs.map(toWireDisc),
          chainLevel: step.chainLevel,
          pointsAwarded: step.pointsAwarded,
        } satisfies WireClearStep);
        break;
      case 'fall':
        result.push({
          kind: 'fall' as const,
          moves: step.moves.map(m => ({
            from: { row: m.from.row, col: m.from.col },
            to: { row: m.to.row, col: m.to.col },
            disc: toWireDisc(m.disc),
          })),
        } satisfies WireFallStep);
        break;
      case 'reveal':
        result.push({
          kind: 'reveal' as const,
          positions: step.positions.map(p => ({ row: p.row, col: p.col })),
          discs: step.discs.map(toWireDisc),
        } satisfies WireRevealStep);
        break;
      case 'push':
        result.push({
          kind: 'push' as const,
          edge: step.edge,
          newDiscs: step.newDiscs.map(toWireDisc),
        } satisfies WirePushStep);
        break;
      case 'bonus':
        result.push({
          kind: 'bonus' as const,
          bonusKind: step.bonusKind,
          pointsAwarded: step.pointsAwarded,
        } satisfies WireBonusStep);
        break;
    }
  }
  return result;
}
