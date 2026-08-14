import { deepCloneBoard, makeEmptyBoard } from '../game/board.js';
import { GameEngine } from '../game/engine.js';
import { formatMultiplier } from './format.js';
import type {
  GameOverReason,
  RewindPreview,
  ScriptedGameStateOptions,
  TurnResult,
} from '../game/engine.js';
import type { PhysicsStep } from '../game/events.js';
import { StepKind } from '../game/events.js';
import { entryEdgeForAngle, snapAngleToEightDirections } from '../game/gravity/settling.js';
import type { Board, GridPos } from '../game/model.js';
import type { GameRulesConfig } from '../game/modes/mode.js';
import { rewindModifier } from '../game/modes/mode.js';
import type { SaveGameV1 } from '../game/save.js';
import type { GameState } from '../game/state.js';
import { GamePhase } from '../game/state.js';
import type {
  GravityShiftCue,
  RichDiscAnimation,
  ScoreIndicator,
  ScorePopup,
} from '../ui/rendering/animation-types.js';
import {
  AnimationQueue,
  spawnGravityShiftCue,
  spawnScoreIndicator,
  spawnScorePopups,
  tickGravityShiftCue,
  tickScoreIndicators,
  tickScorePopups,
} from '../ui/rendering/animation-queue.js';
import { applyStepToVisualBoard } from './visual-board.js';

export interface LevelProgressView {
  readonly level: number;
  readonly turnsPerLevel: number;
  readonly turnsRemaining: number;
}

export interface StackScoreView {
  readonly initial: number;
  readonly chains: readonly { level: number; cleared: number }[];
  readonly stack: number;
  readonly points: number;
}

export interface LocalBoardSessionView {
  readonly rules: GameRulesConfig;
  readonly state: GameState;
  readonly visualBoard: Board;
  readonly displayedScore: number;
  readonly displayedLevelProgress: LevelProgressView;
  readonly animations: readonly RichDiscAnimation[];
  readonly scorePopups: readonly ScorePopup[];
  readonly scoreIndicators: readonly ScoreIndicator[];
  readonly gravityShiftCue: GravityShiftCue | null;
  readonly rewindPreview: RewindPreview | null;
  readonly longestStreak: number;
  readonly rewindLongestStreaks: readonly number[];
  readonly lastGameOverReason: GameOverReason | undefined;
  readonly activeStack: number;
  readonly stackCascadeActive: boolean;
  readonly lastStackScore: StackScoreView | null;
  readonly laneCount: number;
  readonly axis: 'col' | 'row';
  readonly needsTilt: boolean;
  readonly canConfirmTilt: boolean;
  readonly paused: boolean;
}

export interface LocalBoardSessionEvents {
  /** Accepted turn, before presentation temporarily changes the engine phase. */
  readonly onStableTurn?: (result: TurnResult) => void;
  /** Fired after presentation setup for accepted turns, or immediately for rejected turns. */
  readonly onTurn?: (result: TurnResult) => void;
  readonly onStepStart?: (step: PhysicsStep, now: DOMHighResTimeStamp) => void;
  readonly onStepComplete?: (step: PhysicsStep) => void;
  readonly onPlaybackComplete?: (result: TurnResult) => void;
}

export interface LocalBoardSessionOptions {
  readonly rules: GameRulesConfig;
  readonly seed?: number;
  readonly events?: LocalBoardSessionEvents;
}

/**
 * One locally rendered board, independent of solo menus, account stats, saves,
 * tutorials, room state, and wall-clock match rules.
 *
 * The engine resolves a turn synchronously. This session then owns the lagging
 * visual board and presentation queue until they converge at a stable boundary.
 */
export class LocalBoardSession {
  readonly state: GameState;

  private readonly engine: GameEngine;
  private rules: GameRulesConfig;
  private readonly events: LocalBoardSessionEvents;
  private visualBoard: Board;
  private displayedScore = 0;
  private displayedLevelProgress: LevelProgressView;
  private animQueue: AnimationQueue | null = null;
  private scorePopups: ScorePopup[] = [];
  private scoreIndicators: ScoreIndicator[] = [];
  private gravityShiftCue: GravityShiftCue | null = null;
  private rewindPreview: RewindPreview | null = null;
  private longestStreak = 0;
  private rewindLongestStreaks: number[] = [];
  private lastGameOverReason: GameOverReason | undefined;
  private activeStack = 0;
  private stackInitialClearSize = 0;
  private stackChainBatches: Array<{ level: number; cleared: number }> = [];
  private lastStackScore: StackScoreView | null = null;
  private stackCascadeActive = false;
  private tutorialPresentation = false;
  private paused = false;
  private pauseStartedAt = 0;

  constructor(options: LocalBoardSessionOptions) {
    this.rules = options.rules;
    this.events = options.events ?? {};
    this.engine = new GameEngine({
      rules: options.rules,
      ...(options.seed !== undefined ? { seed: options.seed } : {}),
    });
    this.state = this.engine.state;
    this.visualBoard = makeEmptyBoard(this.rules.board.cols, this.rules.board.rows);
    this.displayedLevelProgress = this.snapshotLevelProgress();
  }

  get view(): LocalBoardSessionView {
    const gravity = this.state.gravity;
    const needsTilt = this.state.phase === GamePhase.Aiming
      && gravity !== undefined
      && snapAngleToEightDirections(gravity.angle)
        === snapAngleToEightDirections(gravity.turnStartAngle);
    return {
      rules: this.rules,
      state: this.state,
      visualBoard: this.visualBoard,
      displayedScore: this.displayedScore,
      displayedLevelProgress: this.displayedLevelProgress,
      animations: this.animQueue?.getActiveAnimations() ?? [],
      scorePopups: this.scorePopups,
      scoreIndicators: this.scoreIndicators,
      gravityShiftCue: this.gravityShiftCue,
      rewindPreview: this.rewindPreview,
      longestStreak: this.longestStreak,
      rewindLongestStreaks: this.rewindLongestStreaks,
      lastGameOverReason: this.lastGameOverReason,
      activeStack: this.activeStack,
      stackCascadeActive: this.stackCascadeActive,
      lastStackScore: this.lastStackScore,
      laneCount: this.laneCount(),
      axis: this.axis(),
      needsTilt,
      canConfirmTilt: this.state.phase === GamePhase.Aiming && !needsTilt,
      paused: this.paused,
    };
  }

  configure(rules: GameRulesConfig, seed?: number): void {
    this.rules = rules;
    this.engine.reconfigure(rules, seed);
    this.tutorialPresentation = false;
    this.resetPresentation(makeEmptyBoard(rules.board.cols, rules.board.rows));
    this.resetRunState();
  }

  restart(): void {
    this.engine.restart();
    this.tutorialPresentation = false;
    this.resetPresentation(makeEmptyBoard(this.rules.board.cols, this.rules.board.rows));
    this.resetRunState();
  }

  loadSave(save: SaveGameV1, rules: GameRulesConfig): ReturnType<GameEngine['loadSave']> {
    this.rules = rules;
    const loaded = this.engine.loadSave(save, rules);
    this.tutorialPresentation = false;
    this.resetPresentation(deepCloneBoard(this.state.board));
    this.longestStreak = loaded.session.longestStreak;
    this.rewindLongestStreaks = (
      loaded.paradox?.rewinds
      ?? (loaded.paradox?.rewind ? [loaded.paradox.rewind] : [])
    ).map(rewind => rewind.session.longestStreak);
    this.lastGameOverReason = undefined;
    this.resetStackPresentation();
    return loaded;
  }

  loadScriptedState(options: ScriptedGameStateOptions): void {
    this.rules = options.rules ?? this.rules;
    this.engine.loadScriptedState(options);
    this.tutorialPresentation = true;
    this.resetPresentation(deepCloneBoard(options.board));
    this.resetStackPresentation();
  }

  continueFromTutorial(): void {
    this.engine.resumeSeededGeneration();
    this.state.score = 0;
    this.displayedScore = 0;
    this.state.phase = GamePhase.WaitingForDrop;
    this.tutorialPresentation = false;
    this.longestStreak = 0;
  }

  exportSave(analytics?: { playTimeMs: number; discsBroken: number }): SaveGameV1 {
    return this.engine.exportSave({
      longestStreak: this.longestStreak,
      ...(analytics ? analytics : {}),
      ...(this.rewindLongestStreaks.length > 0
        ? { rewindLongestStreaks: this.rewindLongestStreaks }
        : {}),
    });
  }

  moveCursor(lane: number): void {
    this.engine.moveCursor(lane);
  }

  stageDrop(lane: number): ReturnType<GameEngine['stageGravityDrop']> {
    return this.engine.stageGravityDrop(lane);
  }

  tilt(delta: number): ReturnType<GameEngine['tiltGravity']> {
    return this.engine.tiltGravity(delta);
  }

  cancelTilt(): void {
    this.engine.cancelTilt();
  }

  drop(lane: number): TurnResult {
    const previousLevelProgress = this.snapshotLevelProgress();
    const previousLongestStreak = this.longestStreak;
    const result = this.engine.drop(lane);
    this.acceptTurnResult(result, previousLevelProgress, previousLongestStreak);
    return result;
  }

  commitTilt(now = performance.now()): TurnResult {
    const previousLevelProgress = this.snapshotLevelProgress();
    const gravity = this.state.gravity;
    const fromAngle = gravity?.turnStartAngle ?? 0;
    const result = this.engine.commitTilt();
    if (result.accepted && gravity) {
      this.gravityShiftCue = spawnGravityShiftCue(fromAngle, gravity.angle, now);
    }
    this.acceptTurnResult(result, previousLevelProgress, this.longestStreak);
    return result;
  }

  previewSettledBoard(): Board {
    return this.engine.previewSettledBoard();
  }

  previewDropLanding(lane: number): GridPos | null {
    return this.engine.previewDropLanding(lane);
  }

  canRewind(): boolean {
    return this.engine.canRewind();
  }

  previewRewind(turns?: number): RewindPreview | null {
    const preview = this.engine.previewRewind(turns);
    this.rewindPreview = preview;
    return preview;
  }

  clearRewindPreview(): void {
    this.rewindPreview = null;
  }

  commitRewind(turns = this.rewindPreview?.turnsRewound ?? 1): boolean {
    const restoredLongestStreak = this.rewindLongestStreaks[
      this.rewindLongestStreaks.length - turns
    ];
    const rewind = this.engine.commitRewind(turns);
    if (!rewind) return false;

    this.rewindPreview = null;
    this.lastGameOverReason = undefined;
    this.longestStreak = restoredLongestStreak ?? this.longestStreak;
    this.rewindLongestStreaks = [];
    this.resetPresentation(deepCloneBoard(this.state.board));
    return true;
  }

  enterMenu(): void {
    this.animQueue = null;
    this.rewindPreview = null;
    this.displayedScore = this.state.score;
    this.state.phase = GamePhase.Menu;
    this.paused = false;
    this.pauseStartedAt = 0;
    this.clearTransientPresentation();
  }

  setGameOver(reason?: GameOverReason): void {
    this.state.phase = GamePhase.GameOver;
    this.lastGameOverReason = reason;
    this.syncLevelProgressDisplay();
    this.animQueue = null;
  }

  pause(now = performance.now()): void {
    if (this.paused) return;
    if (this.state.phase !== GamePhase.WaitingForDrop && this.state.phase !== GamePhase.Animating) {
      return;
    }
    this.paused = true;
    this.pauseStartedAt = now;
  }

  resume(now = performance.now()): void {
    if (!this.paused) return;
    const deltaMs = now - this.pauseStartedAt;
    this.animQueue?.shiftTime(deltaMs);
    this.scorePopups = this.scorePopups.map(popup => ({
      ...popup,
      startTime: popup.startTime + deltaMs,
    }));
    this.scoreIndicators = this.scoreIndicators.map(indicator => ({
      ...indicator,
      startTime: indicator.startTime + deltaMs,
    }));
    if (this.gravityShiftCue) {
      this.gravityShiftCue = {
        ...this.gravityShiftCue,
        startTime: this.gravityShiftCue.startTime + deltaMs,
      };
    }
    this.paused = false;
    this.pauseStartedAt = 0;
  }

  tick(now: DOMHighResTimeStamp): void {
    if (this.paused) return;

    this.scorePopups = tickScorePopups(this.scorePopups, now);
    this.scoreIndicators = tickScoreIndicators(this.scoreIndicators, now);
    this.gravityShiftCue = tickGravityShiftCue(this.gravityShiftCue, now);
    if (!this.animQueue) return;

    if (!this.gravityShiftCue || this.gravityShiftCue.progress >= 0.15) {
      this.animQueue.tick(now);
    }
    if (this.animQueue?.isDone()) this.animQueue = null;
  }

  private acceptTurnResult(
    result: TurnResult,
    previousLevelProgress: LevelProgressView,
    previousLongestStreak: number,
  ): void {
    if (!result.accepted) {
      this.events.onTurn?.(result);
      return;
    }

    const longestStreakThisTurn = result.steps.reduce(
      (longest, step) => step.kind === StepKind.Clear
        ? Math.max(longest, step.chainLevel + 1)
        : longest,
      0,
    );
    const recordForTurn = this.isStackMode() ? result.stackSize : longestStreakThisTurn;
    this.longestStreak = Math.max(this.longestStreak, recordForTurn);
    const rewind = rewindModifier(this.rules);
    if (rewind) {
      this.rewindLongestStreaks.push(previousLongestStreak);
      if (this.rewindLongestStreaks.length > rewind.historyDepth) {
        this.rewindLongestStreaks.splice(
          0,
          this.rewindLongestStreaks.length - rewind.historyDepth,
        );
      }
    }

    this.resetStackPresentation();
    this.stackCascadeActive = this.isStackMode();
    this.visualBoard = result.boardBefore;
    this.setAnimatedLevelProgress(previousLevelProgress);
    // Saves/replay publication must observe the synchronous engine boundary,
    // before the browser temporarily changes the final phase to Animating.
    this.events.onStableTurn?.(result);
    this.state.phase = GamePhase.Animating;
    this.displayedScore = this.state.score - result.scoreAwarded;
    this.animQueue = new AnimationQueue(
      result.steps,
      (step, now) => this.handleStepStart(step, now),
      step => {
        applyStepToVisualBoard(this.visualBoard, step);
        this.events.onStepComplete?.(step);
      },
      () => {
        this.displayedScore = this.state.score;
        this.syncLevelProgressDisplay();
        if (!result.gameOver && !this.tutorialPresentation) {
          this.state.phase = GamePhase.WaitingForDrop;
        }
        this.events.onPlaybackComplete?.(result);
      },
    );
    this.events.onTurn?.(result);
  }

  private handleStepStart(step: PhysicsStep, now: DOMHighResTimeStamp): void {
    this.events.onStepStart?.(step, now);
    if (step.kind === StepKind.Drop && step.temporalEcho) {
      this.scoreIndicators.push(spawnScoreIndicator(
        'TEMPORAL ECHO',
        'THE TIMELINE REPEATS',
        now,
      ));
    }

    if (step.kind === StepKind.Clear) {
      if (this.stackCascadeActive) {
        const previousStack = this.activeStack;
        this.activeStack += step.cleared.length;
        if (step.chainLevel === 0) {
          this.stackInitialClearSize += step.cleared.length;
        } else {
          const level = step.chainLevel + 1;
          const existing = this.stackChainBatches.find(batch => batch.level === level);
          if (existing) existing.cleared += step.cleared.length;
          else this.stackChainBatches.push({ level, cleared: step.cleared.length });
        }
        const stackUnit = this.rules.scoring.kind === 'stack-score@1'
          ? this.rules.scoring.pointsPerStackUnit
          : 0;
        const batchAward = stackUnit * (this.activeStack ** 2 - previousStack ** 2);
        this.displayedScore += batchAward;
        this.scorePopups.push(...spawnScorePopups(
          step.cleared,
          batchAward / step.cleared.length,
          now,
        ));
        return;
      }
      this.displayedScore += step.pointsAwarded;
      const perDiscPoints = step.pointsAwarded / step.cleared.length;
      this.scorePopups.push(...spawnScorePopups(step.cleared, perDiscPoints, now));
      const chainLength = step.chainLevel + 1;
      if (chainLength >= 2) {
        const multiplier = Math.pow(
          chainLength,
          this.rules.scoring.kind === 'chain-score@1'
            ? this.rules.scoring.chainExponent
            : 1,
        );
        this.scoreIndicators.push(spawnScoreIndicator(
          `CHAIN ${chainLength}`,
          `×${formatMultiplier(multiplier)}  +${step.pointsAwarded}`,
          now,
        ));
      }
    } else if (step.kind === StepKind.Bonus && !this.tutorialPresentation) {
      if (step.bonusKind === 'stack') {
        this.stackCascadeActive = false;
        const stackUnit = this.rules.scoring.kind === 'stack-score@1'
          ? this.rules.scoring.pointsPerStackUnit
          : 0;
        this.lastStackScore = {
          initial: this.stackInitialClearSize,
          chains: this.stackChainBatches.map(batch => ({ ...batch })),
          stack: this.activeStack,
          points: step.pointsAwarded,
        };
        this.scoreIndicators.push(spawnScoreIndicator(
          `TURN TOTAL ${this.activeStack}`,
          `${stackUnit} × ${this.activeStack}² · +${step.pointsAwarded.toLocaleString('en-US')}`,
          now,
        ));
        return;
      }
      this.displayedScore += step.pointsAwarded;
      this.scoreIndicators.push(spawnScoreIndicator(
        step.bonusKind === 'level' ? 'LEVEL BONUS' : 'BOARD CLEAR',
        `+${step.pointsAwarded.toLocaleString('en-US')}`,
        now,
      ));
    }
  }

  private resetPresentation(board: Board): void {
    this.visualBoard = board;
    this.displayedScore = this.state.score;
    this.syncLevelProgressDisplay();
    this.animQueue = null;
    this.clearTransientPresentation();
    this.rewindPreview = null;
    this.paused = false;
    this.pauseStartedAt = 0;
  }

  private clearTransientPresentation(): void {
    this.scorePopups = [];
    this.scoreIndicators = [];
    this.gravityShiftCue = null;
  }

  private resetRunState(): void {
    this.longestStreak = 0;
    this.rewindLongestStreaks = [];
    this.lastGameOverReason = undefined;
    this.resetStackPresentation();
  }

  private resetStackPresentation(): void {
    this.activeStack = 0;
    this.stackInitialClearSize = 0;
    this.stackChainBatches = [];
    this.lastStackScore = null;
    this.stackCascadeActive = false;
  }

  private laneCount(): number {
    if (this.state.gravity) {
      const edge = entryEdgeForAngle(this.state.gravity.angle);
      if (edge === 'left' || edge === 'right') return this.state.board.length;
    }
    return this.state.board[0]!.length;
  }

  private axis(): 'col' | 'row' {
    if (this.state.gravity) {
      const edge = entryEdgeForAngle(this.state.gravity.angle);
      if (edge === 'left' || edge === 'right') return 'row';
    }
    return 'col';
  }

  private snapshotLevelProgress(): LevelProgressView {
    return {
      level: this.state.level,
      turnsPerLevel: this.state.turnsPerLevel,
      turnsRemaining: this.state.turnsRemaining,
    };
  }

  private syncLevelProgressDisplay(): void {
    this.displayedLevelProgress = this.snapshotLevelProgress();
  }

  private setAnimatedLevelProgress(previous: LevelProgressView): void {
    this.displayedLevelProgress = this.state.level > previous.level
      ? {
          level: previous.level,
          turnsPerLevel: previous.turnsPerLevel,
          turnsRemaining: 0,
        }
      : this.snapshotLevelProgress();
  }

  private isStackMode(): boolean {
    return this.rules.scoring.kind === 'stack-score@1';
  }
}

