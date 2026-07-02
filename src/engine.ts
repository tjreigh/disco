import { Board, GamePhase, GameState, PhysicsStep, StepKind } from './types.js';
import { DROPS_PER_PUSH, GRID_COLS } from './constants.js';
import { deepCloneBoard, isColumnFull, makeEmptyBoard } from './board.js';
import {
  DiscFactory, DiscQueue, makeCrackedDisc, makeRandomDisc,
} from './disc.js';
import { computeClearSteps, computeDropSteps, computePushStep, PhysicsTrace } from './physics.js';

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
  discFactory?: DiscFactory;
  crackedDiscFactory?: DiscFactory;
  board?: Board;
  score?: number;
  dropCount?: number;
}

function hasDiscInTopRow(board: Board): boolean {
  return board[0]!.some(cell => cell !== null);
}

/**
 * Synchronous, headless game rules. It has no dependency on the DOM, rendering,
 * audio, input, animation frames, or wall-clock time.
 */
export class GameEngine {
  readonly state: GameState;
  private readonly queue: DiscQueue;
  private readonly crackedDiscFactory: DiscFactory;

  constructor(options: GameEngineOptions = {}) {
    this.queue = new DiscQueue(options.discFactory ?? makeRandomDisc);
    this.crackedDiscFactory = options.crackedDiscFactory ?? makeCrackedDisc;
    const dropCount = options.dropCount ?? 0;
    this.state = {
      phase: GamePhase.WaitingForDrop,
      board: options.board ? deepCloneBoard(options.board) : makeEmptyBoard(),
      currentDisc: this.queue.peek(),
      nextDisc: this.queue.peekNext(),
      cursorCol: 3,
      score: options.score ?? 0,
      dropCount,
      level: Math.floor(dropCount / 14) + 1,
    };
  }

  moveCursor(col: number): void {
    if (!Number.isInteger(col)) return;
    this.state.cursorCol = Math.max(0, Math.min(GRID_COLS - 1, col));
  }

  drop(col: number): TurnResult {
    const boardBefore = deepCloneBoard(this.state.board);
    const trace: PhysicsTrace = { scans: [], frames: [] };
    const reject = (reason: RejectedTurnReason, gameOver = false): TurnResult => {
      if (gameOver) this.state.phase = GamePhase.GameOver;
      return { accepted: false, reason, boardBefore, steps: [], scoreAwarded: 0, gameOver, trace };
    };

    if (this.state.phase === GamePhase.GameOver) return reject('game-over', true);
    if (!Number.isInteger(col) || col < 0 || col >= GRID_COLS) return reject('invalid-column');
    if (isColumnFull(this.state.board, col)) return reject('full-column', true);

    this.state.cursorCol = col;
    const steps = computeDropSteps(this.state.board, this.queue.peek(), col, trace);
    this.state.dropCount++;
    this.state.level = Math.floor(this.state.dropCount / 14) + 1;

    let pushOverflow = false;
    if (this.state.dropCount % DROPS_PER_PUSH === 0) {
      const push = computePushStep(this.state.board, this.crackedDiscFactory);
      steps.push(push.step);
      trace.frames.push({ label: 'Push new cracked row', board: deepCloneBoard(this.state.board) });
      pushOverflow = push.gameOver;

      // The new row increases every column count. Resolve any matches now so
      // they are visibly caused by the push instead of disappearing on a later,
      // unrelated drop.
      steps.push(...computeClearSteps(this.state.board, trace));
    }

    const scoreAwarded = steps.reduce(
      (total, step) => total + (step.kind === StepKind.Clear ? step.pointsAwarded : 0),
      0,
    );
    this.state.score += scoreAwarded;

    this.queue.advance();
    this.state.currentDisc = this.queue.peek();
    this.state.nextDisc = this.queue.peekNext();

    const gameOver = pushOverflow || hasDiscInTopRow(this.state.board);
    this.state.phase = gameOver ? GamePhase.GameOver : GamePhase.WaitingForDrop;
    return { accepted: true, boardBefore, steps, scoreAwarded, gameOver, trace };
  }

  restart(): void {
    this.queue.reset();
    this.state.phase = GamePhase.WaitingForDrop;
    this.state.board = makeEmptyBoard();
    this.state.currentDisc = this.queue.peek();
    this.state.nextDisc = this.queue.peekNext();
    this.state.cursorCol = 3;
    this.state.score = 0;
    this.state.dropCount = 0;
    this.state.level = 1;
  }
}
