import type { Board } from './model.js';
import type { GameModeConfig } from './modes/mode.js';
import type { GameState } from './state.js';
import { GamePhase } from './state.js';
import type { PhysicsStep } from './events.js';
import { StepKind } from './events.js';
import { deepCloneBoard, isColumnFull, makeEmptyBoard } from './board.js';
import { createDiscFactories, DiscFactory, DiscQueue } from './disc.js';
import { computeClearSteps, computeDropSteps, computePushStep, PhysicsTrace } from './physics.js';
import { CLASSIC_MODE } from './modes/index.js';
import { turnsForLevel } from './modes/mode.js';
import { createGameSeed, createSeededRandom, deriveSeed } from './random.js';

export type RejectedTurnReason = 'game-over' | 'invalid-column' | 'full-column';

export interface TurnResult {
  accepted: boolean;
  reason?: RejectedTurnReason;
  /** Board immediately before the turn, for animation playback or assertions. */
  boardBefore: Board;
  steps: PhysicsStep[];
  scoreAwarded: number;
  gameOver: boolean;
  trace: PhysicsTrace;
}

export interface GameEngineOptions {
  mode?: GameModeConfig;
  /** Reproduce built-in disc generation with a known unsigned 32-bit seed. */
  seed?: number;
  discFactory?: DiscFactory;
  crackedDiscFactory?: DiscFactory;
  board?: Board;
  score?: number;
  dropCount?: number;
}

/**
 * Synchronous, headless game rules. It has no dependency on the DOM, rendering,
 * audio, input, animation frames, or wall-clock time.
 */
export class GameEngine {
  readonly state: GameState;
  private mode: GameModeConfig;
  private queue: DiscQueue;
  private crackedDiscFactory: DiscFactory;
  private customDiscFactory: DiscFactory | undefined;
  private customCrackedDiscFactory: DiscFactory | undefined;

  constructor(options: GameEngineOptions = {}) {
    this.mode = options.mode ?? CLASSIC_MODE;
    this.customDiscFactory = options.discFactory;
    this.customCrackedDiscFactory = options.crackedDiscFactory;
    const seed = options.seed === undefined ? createGameSeed() : options.seed >>> 0;
    const factories = this.createSeededFactories(seed);
    const initialBoard = options.board
      ? deepCloneBoard(options.board)
      : makeEmptyBoard(this.mode.board.cols, this.mode.board.rows);
    const queueFactory = options.discFactory
      ? (_level: number, _board: Board) => options.discFactory!()
      : factories.discFactory;
    this.queue = new DiscQueue(queueFactory, 1, initialBoard);
    this.crackedDiscFactory = options.crackedDiscFactory ?? factories.crackedDiscFactory;
    const dropCount = options.dropCount ?? 0;
    this.state = {
      generationSeed: seed,
      phase: GamePhase.WaitingForDrop,
      board: initialBoard,
      currentDisc: this.queue.peek(),
      nextDisc: this.queue.peekNext(),
      cursorCol: Math.floor(this.mode.board.cols / 2),
      score: options.score ?? 0,
      dropCount,
      level: 1,
      turnsPerLevel: turnsForLevel(this.mode, 1),
      turnsRemaining: turnsForLevel(this.mode, 1),
    };
  }

  moveCursor(col: number): void {
    if (!Number.isInteger(col)) return;
    this.state.cursorCol = Math.max(0, Math.min(this.state.board[0]!.length - 1, col));
  }

  drop(col: number): TurnResult {
    const boardBefore = deepCloneBoard(this.state.board);
    const trace: PhysicsTrace = { scans: [], frames: [] };
    const reject = (reason: RejectedTurnReason, gameOver = false): TurnResult => {
      if (gameOver) this.state.phase = GamePhase.GameOver;
      return { accepted: false, reason, boardBefore, steps: [], scoreAwarded: 0, gameOver, trace };
    };

    if (this.state.phase === GamePhase.GameOver) return reject('game-over', true);
    if (!Number.isInteger(col) || col < 0 || col >= this.state.board[0]!.length) return reject('invalid-column');
    if (isColumnFull(this.state.board, col)) return reject('full-column');

    this.state.cursorCol = col;
    const steps = computeDropSteps(this.state.board, this.queue.peek(), col, this.mode, trace);
    this.state.dropCount++;

    // A turn is consumed as soon as its drop resolves, so a push (triggered
    // below when this exhausts the level's budget) sees the correct count.
    this.state.turnsRemaining--;
    const levelComplete = this.state.turnsRemaining <= 0;

    let pushOverflow = false;
    if (levelComplete) {
      const push = computePushStep(this.state.board, this.crackedDiscFactory, this.mode);
      steps.push(push.step);
      trace.frames.push({ label: 'Push new cracked row', board: deepCloneBoard(this.state.board) });
      pushOverflow = push.gameOver;

      // The new row increases every column count. Resolve any matches now so
      // they are visibly caused by the push instead of disappearing on a later,
      // unrelated drop.
      steps.push(...computeClearSteps(this.state.board, this.mode, trace));
    }

    if (levelComplete && !pushOverflow) {
      steps.push({
        kind: StepKind.Bonus,
        bonusKind: 'level',
        pointsAwarded: this.mode.levelBonus,
      });
    }

    const scoreAwarded = steps.reduce(
      (total, step) => total + (
        step.kind === StepKind.Clear || step.kind === StepKind.Bonus
          ? step.pointsAwarded
          : 0
      ),
      0,
    );
    this.state.score += scoreAwarded;

    // Only a push shoving a row-0 disc off the board ends the game — resting in
    // row 0 through normal stacking is a valid, non-terminal state. mode.isGameOver
    // is already applied at the correct point, inside computePushStep, before the
    // shift; its result flows in here via pushOverflow.
    const gameOver = pushOverflow;
    this.state.phase = gameOver ? GamePhase.GameOver : GamePhase.WaitingForDrop;

    // Board and score carry over unchanged into the new level. Skipped on game
    // over so the level/budget freeze at the state the player died in.
    if (!gameOver && levelComplete) {
      this.state.level++;
      this.state.turnsPerLevel = turnsForLevel(this.mode, this.state.level);
      this.state.turnsRemaining = this.state.turnsPerLevel;
    }

    // Keep the already-previewed discs stable. Only the new tail disc uses the
    // current level's spawn probability after a level transition.
    this.queue.advance(this.state.level, this.state.board);
    this.state.currentDisc = this.queue.peek();
    this.state.nextDisc = this.queue.peekNext();

    return { accepted: true, boardBefore, steps, scoreAwarded, gameOver, trace };
  }

  // Switches to a (possibly new) mode: rebuilds the disc queue/factories from
  // the mode's own spawn config — deliberately ignoring any custom factory
  // that may have been injected at construction, since adopting a new mode
  // means adopting that mode's own generation rules — and resets gameplay
  // state in place. state itself is never replaced — DebugPanel and Game hold
  // a reference to it that must stay valid across mode switches.
  reconfigure(mode: GameModeConfig): void {
    this.mode = mode;
    this.customDiscFactory = undefined;
    this.customCrackedDiscFactory = undefined;
    const seed = createGameSeed();
    const factories = this.createSeededFactories(seed);
    const board = makeEmptyBoard(this.mode.board.cols, this.mode.board.rows);
    this.state.board = board;
    this.queue = new DiscQueue(factories.discFactory, 1, board);
    this.crackedDiscFactory = factories.crackedDiscFactory;
    this.state.generationSeed = seed;
    this.resetState(board);
  }

  // Resets gameplay state for a fresh game in the same mode, reusing whichever
  // disc factory the engine already has (custom-injected or mode-derived)
  // instead of rebuilding it — this preserves deterministic factories (as used
  // in tests) across a restart, matching pre-mode-system behavior.
  restart(): void {
    const seed = createGameSeed();
    this.state.generationSeed = seed;
    const factories = this.createSeededFactories(seed);
    const board = makeEmptyBoard(this.mode.board.cols, this.mode.board.rows);
    this.state.board = board;
    if (this.customDiscFactory) {
      this.queue.reset(1, board);
    } else {
      this.queue = new DiscQueue(factories.discFactory, 1, board);
    }
    this.crackedDiscFactory = this.customCrackedDiscFactory ?? factories.crackedDiscFactory;
    this.resetState(board);
  }

  private createSeededFactories(seed: number): ReturnType<typeof createDiscFactories> {
    const playableRandom = createSeededRandom(deriveSeed(seed, 0x504c4159));
    const pushRandom = createSeededRandom(deriveSeed(seed, 0x50555348));
    return createDiscFactories(this.mode, playableRandom, pushRandom);
  }

  private resetState(board: Board): void {
    this.state.phase = GamePhase.WaitingForDrop;
    this.state.board = board;
    this.state.currentDisc = this.queue.peek();
    this.state.nextDisc = this.queue.peekNext();
    this.state.cursorCol = Math.floor(this.mode.board.cols / 2);
    this.state.score = 0;
    this.state.dropCount = 0;
    this.state.level = 1;
    this.state.turnsPerLevel = turnsForLevel(this.mode, 1);
    this.state.turnsRemaining = this.state.turnsPerLevel;
  }
}
