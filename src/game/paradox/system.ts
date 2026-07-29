import { deepCloneBoard, isColumnFull } from '../board.js';
import {
  type DiscQueueSnapshot, type PlayableDiscGeneratorSnapshot, type QueuedDiscSnapshot,
  makeDisc,
} from '../disc.js';
import type { PhysicsStep } from '../events.js';
import { StepKind } from '../events.js';
import type { Board, GridPos } from '../model.js';
import { DiscKind } from '../model.js';
import type { GameRulesConfig } from '../modes/mode.js';
import {
  rewindModifier,
  temporalEchoProbability,
  turnCostForInstability,
} from '../modes/mode.js';
import { computeDropSteps, type PhysicsTrace } from '../physics.js';
import type { SnapshotRandomSource } from '../random.js';
import type { GravityState } from '../state.js';
import { GamePhase } from '../state.js';
import {
  applyRewindFractures, reconcileTemporalDebt, selectRewindFractures,
  type RewindFractureTarget,
} from './fractures.js';
export type { RewindFractureTarget } from './fractures.js';

export interface TurnCheckpoint {
  generationSeed: number;
  generationSource: 'seeded';
  board: Board;
  cursorCol: number;
  score: number;
  dropCount: number;
  level: number;
  turnsPerLevel: number;
  turnsRemaining: number;
  gravity: GravityState | undefined;
  paradox: { instability: number } | undefined;
  queue: DiscQueueSnapshot;
  playableGenerator: PlayableDiscGeneratorSnapshot;
  playableRandomState: number;
  pushRandomState: number;
  echoRandomState: number;
  anchor: GridPos | null;
}

/** Independent player-facing view of the state a rewind would restore. */
export interface RewindPreview {
  board: Board;
  cursorCol: number;
  score: number;
  dropCount: number;
  level: number;
  turnsPerLevel: number;
  turnsRemaining: number;
  currentDisc: QueuedDiscSnapshot;
  nextDisc: QueuedDiscSnapshot;
  anchor: GridPos;
  rescuesGameOver: boolean;
  instabilityBefore: number;
  instabilityAfter: number;
  turnCostBefore: number;
  turnCostAfter: number;
  /** Number of completed turns erased by this preview. */
  turnsRewound: number;
  /** Number of prior turn boundaries currently available. */
  historyAvailable: number;
  fractures: RewindFractureTarget[];
}

export interface PreparedRewind {
  checkpoint: TurnCheckpoint;
  preview: RewindPreview;
}

/**
 * Owns the optional Paradox rules layered onto the core turn engine.
 * Deterministic generation snapshots remain engine-owned and are passed in as
 * checkpoint data so this system never controls the queue or normal lifecycle.
 */
export class ParadoxSystem {
  private rules: GameRulesConfig;
  private history: TurnCheckpoint[] = [];

  constructor(rules: GameRulesConfig) {
    this.rules = rules;
  }

  get enabled(): boolean {
    return rewindModifier(this.rules) !== undefined;
  }

  reconfigure(rules: GameRulesConfig): void {
    this.rules = rules;
    this.clearHistory();
  }

  initialState(): { instability: number } | undefined {
    return rewindModifier(this.rules) ? { instability: 0 } : undefined;
  }

  clearHistory(): void {
    this.history = [];
  }

  replaceHistory(checkpoints: TurnCheckpoint[]): void {
    this.history = checkpoints;
  }

  get checkpoints(): readonly TurnCheckpoint[] {
    return this.history;
  }

  captureCheckpoint(checkpoint: TurnCheckpoint, hasSnapshotGeneration: boolean): TurnCheckpoint | null {
    const rewind = rewindModifier(this.rules);
    if (!rewind || !hasSnapshotGeneration) {
      this.clearHistory();
      return null;
    }
    this.history.push(checkpoint);
    if (this.history.length > rewind.historyDepth) {
      this.history.splice(0, this.history.length - rewind.historyDepth);
    }
    return checkpoint;
  }

  canRewind(turns: number, phase: GamePhase, hasSnapshotGeneration: boolean): boolean {
    return rewindModifier(this.rules) !== undefined
      && Number.isInteger(turns)
      && turns >= 1
      && turns <= this.history.length
      && this.history[this.history.length - turns]?.anchor != null
      && (phase === GamePhase.WaitingForDrop || phase === GamePhase.GameOver)
      && hasSnapshotGeneration;
  }

  previewRewind(
    turns: number,
    phase: GamePhase,
    hasSnapshotGeneration: boolean,
  ): RewindPreview | null {
    if (!this.canRewind(turns, phase, hasSnapshotGeneration)) return null;
    return this.makeRewindPreview(this.history[this.history.length - turns]!, turns, phase);
  }

  prepareRewind(
    turns: number,
    phase: GamePhase,
    hasSnapshotGeneration: boolean,
  ): PreparedRewind | null {
    if (!this.canRewind(turns, phase, hasSnapshotGeneration)) return null;
    const checkpoint = this.history[this.history.length - turns]!;
    const preview = this.makeRewindPreview(checkpoint, turns, phase);
    return { checkpoint, preview };
  }

  applyRewindFractures(
    board: Board,
    fractures: readonly RewindFractureTarget[],
    instability: number,
  ): void {
    applyRewindFractures(board, fractures, instability);
  }

  /** Migrates old or incomplete saves so every instability point has a repair path. */
  reconcileTemporalDebt(
    board: Board,
    instability: number,
    anchor: GridPos,
    fallbackDiscValue: number,
  ): void {
    reconcileTemporalDebt(board, instability, anchor, fallbackDiscValue);
  }

  appendTemporalEcho(
    board: Board,
    steps: PhysicsStep[],
    trace: PhysicsTrace,
    random: SnapshotRandomSource | undefined,
    instability: number,
  ): void {
    if (this.rules.placement.kind === 'stage-and-tilt@1' || !random) return;
    const probability = temporalEchoProbability(this.rules, instability);
    if (probability <= 0 || random() >= probability) return;

    const originalDrop = steps.find(step => step.kind === StepKind.Drop && !step.temporalEcho);
    if (!originalDrop || originalDrop.kind !== StepKind.Drop) return;
    const legalColumns = board[0]!
      .map((_cell, col) => col)
      .filter(col => col !== originalDrop.entryPos.col && !isColumnFull(board, col));
    if (legalColumns.length === 0) return;

    const targetIndex = Math.floor(random() * legalColumns.length);
    const targetCol = legalColumns[targetIndex]!;
    const nextChainLevel = steps.reduce(
      (next, step) => step.kind === StepKind.Clear
        ? Math.max(next, step.chainLevel + 1)
        : next,
      0,
    );
    const echoSteps = computeDropSteps(
      board,
      makeDisc(originalDrop.disc.value, originalDrop.disc.kind),
      targetCol,
      this.rules,
      trace,
      undefined,
      nextChainLevel,
    );
    const echoDrop = echoSteps.find(step => step.kind === StepKind.Drop);
    if (!echoDrop || echoDrop.kind !== StepKind.Drop) return;
    echoDrop.temporalEcho = true;
    steps.push(...echoSteps);
  }

  recoverInstability(
    paradox: { instability: number } | undefined,
    steps: readonly PhysicsStep[],
  ): void {
    if (!paradox) return;
    const temporalRepairs = steps.reduce(
      (total, step) => total + (step.kind === StepKind.Reveal
        ? (step.instabilityRecovered ?? step.temporalRepairs?.length ?? 0)
        : 0),
      0,
    );
    paradox.instability = Math.max(0, paradox.instability - temporalRepairs);
  }

  private makeRewindPreview(
    checkpoint: TurnCheckpoint,
    turnsRewound: number,
    phase: GamePhase,
  ): RewindPreview {
    const [currentDisc, nextDisc] = checkpoint.queue;
    const instabilityBefore = checkpoint.paradox?.instability ?? 0;
    const instabilityAfter = instabilityBefore + turnsRewound;
    const erasedTurns = this.history
      .slice(this.history.length - turnsRewound)
      .map(erased => ({ anchor: { ...erased.anchor! }, disc: { ...erased.queue[0] } }));
    const fractures = selectRewindFractures(checkpoint.board, erasedTurns, instabilityAfter);
    const board = deepCloneBoard(checkpoint.board);
    fractures.forEach((target, index) => {
      if (!target.materialized) return;
      board[target.position.row]![target.position.col] = {
        id: -(index + 1),
        value: target.discValue,
        kind: DiscKind.Numbered,
      };
    });
    return {
      board,
      cursorCol: checkpoint.cursorCol,
      score: checkpoint.score,
      dropCount: checkpoint.dropCount,
      level: checkpoint.level,
      turnsPerLevel: checkpoint.turnsPerLevel,
      turnsRemaining: checkpoint.turnsRemaining,
      currentDisc: { ...currentDisc },
      nextDisc: { ...nextDisc },
      anchor: { ...checkpoint.anchor! },
      rescuesGameOver: phase === GamePhase.GameOver,
      instabilityBefore,
      instabilityAfter,
      turnCostBefore: turnCostForInstability(this.rules, instabilityBefore),
      turnCostAfter: turnCostForInstability(this.rules, instabilityAfter),
      turnsRewound,
      historyAvailable: this.history.length,
      fractures,
    };
  }

}
