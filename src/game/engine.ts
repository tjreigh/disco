import type { Board, Disc, GridPos } from './model.js';
import type { GameModeConfig } from './modes/mode.js';
import type { GameState, GravityState } from './state.js';
import { GamePhase } from './state.js';
import type { PhysicsStep } from './events.js';
import { StepKind } from './events.js';
import { deepCloneBoard, isBoardFull, isColumnFull, makeEmptyBoard, placeDisc } from './board.js';
import {
  entryEdgeForAngle, entryPositionForLane, isLaneFull, settleContinuous, snapAngleToEightDirections,
} from './gravity.js';
import { createDiscFactories, DiscFactory, DiscQueue } from './disc.js';
import {
  computeClearSteps, computeDropSteps, computeGravityDropSteps, computeGravityTiltSteps,
  computePushStep, PhysicsTrace,
} from './physics.js';
import { CLASSIC_MODE } from './modes/index.js';
import { turnsForLevel } from './modes/mode.js';
import { createGameSeed, createSeededRandom, deriveSeed } from './random.js';

export type RejectedTurnReason = 'game-over' | 'wrong-phase' | 'invalid-column' | 'full-column';

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

/**
 * board/score/dropCount are test affordances for constructing an engine in a
 * specific mid-game shape — not a resume API. level and turnsRemaining are
 * deliberately not accepted here: an engine always starts at level 1, and the
 * turn budget is derived from the mode, not injected.
 */
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

export interface ScriptedGameStateOptions {
  mode?: GameModeConfig;
  board: Board;
  currentDisc: Disc;
  nextDisc?: Disc;
  queuedDiscs?: readonly Disc[];
  crackedDiscFactory?: DiscFactory;
  score?: number;
  dropCount?: number;
  level?: number;
  turnsRemaining?: number;
  /** Gravity-mode scripted scenarios only: starting angle, defaulting to the mode's initialAngleDeg (e.g. a tutorial step that wants the board pre-tilted). Ignored for modes without gravity. */
  gravityAngleDeg?: number;
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
      generationSource: options.discFactory || options.crackedDiscFactory ? 'injected' : 'seeded',
      phase: isBoardFull(initialBoard) ? GamePhase.GameOver : GamePhase.WaitingForDrop,
      board: initialBoard,
      currentDisc: this.queue.peek(),
      nextDisc: this.queue.peekNext(),
      cursorCol: Math.floor(this.mode.board.cols / 2),
      score: options.score ?? 0,
      dropCount,
      level: 1,
      turnsPerLevel: turnsForLevel(this.mode, 1),
      turnsRemaining: turnsForLevel(this.mode, 1),
      gravity: this.initialGravityState(),
    };
  }

  // `col` is the generic lane cursor: a column index for top/bottom entry
  // (Classic always, Gravity mode most of the time), or a row index when
  // Gravity mode's current angle has snapped its entry edge to left/right.
  // Only meaningful from WaitingForDrop — locked during Aiming (a tilt is
  // in progress) and after game over.
  moveCursor(col: number): void {
    if (this.state.phase !== GamePhase.WaitingForDrop) return;
    if (!Number.isInteger(col)) return;
    this.state.cursorCol = Math.max(0, Math.min(this.currentLaneCount() - 1, col));
  }

  // Drops a disc into a lane. Always resolves immediately — in Gravity mode
  // this enters at the edge opposite the *current* gravity angle and the
  // whole board resettles under that same angle (no tilt happens as part of
  // a drop; tilting is its own separate turn action, see tiltGravity).
  drop(lane: number): TurnResult {
    const boardBefore = deepCloneBoard(this.state.board);
    const trace: PhysicsTrace = { scans: [], frames: [] };
    const reject = (reason: RejectedTurnReason, gameOver = false): TurnResult => {
      if (gameOver) this.state.phase = GamePhase.GameOver;
      return { accepted: false, reason, boardBefore, steps: [], scoreAwarded: 0, gameOver, trace };
    };

    if (this.state.phase === GamePhase.GameOver) return reject('game-over', true);
    if (this.state.phase !== GamePhase.WaitingForDrop) return reject('wrong-phase');

    if (this.mode.gravity) {
      const gravity = this.state.gravity!;
      const entryEdge = entryEdgeForAngle(gravity.angle);
      if (!Number.isInteger(lane) || lane < 0 || lane >= this.currentLaneCount()) return reject('invalid-column');
      if (isLaneFull(this.state.board, lane, entryEdge)) return reject('full-column');

      this.state.cursorCol = lane;
      const steps = computeGravityDropSteps(
        this.state.board, this.queue.peek(), lane, entryEdge, gravity.angle, this.mode, trace,
      );
      return this.finishTurn(steps, boardBefore, trace);
    }

    if (!Number.isInteger(lane) || lane < 0 || lane >= this.state.board[0]!.length) return reject('invalid-column');
    if (isColumnFull(this.state.board, lane)) return reject('full-column');

    this.state.cursorCol = lane;
    const steps = computeDropSteps(this.state.board, this.queue.peek(), lane, this.mode, trace);
    return this.finishTurn(steps, boardBefore, trace);
  }

  // Adjusts the gravity angle by delta. The first call from WaitingForDrop
  // begins a new tilt action — captures turnStartAngle (the range boundary
  // for this action) and moves to GamePhase.Aiming; state.board is NOT
  // touched, so this is entirely free to explore (use previewSettledBoard()
  // to see how the board would land) and cancelTilt() backs out for free.
  // Only commitTilt() actually spends a turn. No-op outside a gravity mode
  // or outside WaitingForDrop/Aiming.
  tiltGravity(delta: number): void {
    if (!this.state.gravity) return;
    if (this.state.phase !== GamePhase.WaitingForDrop && this.state.phase !== GamePhase.Aiming) return;

    const gravity = this.state.gravity;
    if (this.state.phase === GamePhase.WaitingForDrop) {
      gravity.turnStartAngle = gravity.angle;
      this.state.phase = GamePhase.Aiming;
    }
    const min = gravity.turnStartAngle - gravity.maxTiltDelta;
    const max = gravity.turnStartAngle + gravity.maxTiltDelta;
    gravity.angle = Math.max(min, Math.min(max, gravity.angle + delta));
  }

  // Pure preview of how state.board would look if the in-progress tilt were
  // committed right now — does not mutate anything. Only meaningful during
  // GamePhase.Aiming; lets the player see the result before paying a turn for it.
  // Settles at the SNAPPED angle (see commitTilt), not the raw drag value —
  // otherwise this preview would show a shape commitTilt then doesn't
  // actually produce, which is exactly the "looks like it should clear but
  // doesn't" confusion snapping the real angle is meant to eliminate.
  previewSettledBoard(): Board {
    const scratch = deepCloneBoard(this.state.board);
    if (this.state.gravity) settleContinuous(scratch, snapAngleToEightDirections(this.state.gravity.angle));
    return scratch;
  }

  // Pure preview of where a drop into this lane would actually land under
  // the current gravity angle — the true final resting cell, not just the
  // entry edge. Returns null if the lane is full or the mode has no gravity
  // config. Does not mutate anything.
  previewDropLanding(lane: number): GridPos | null {
    if (!this.mode.gravity || !this.state.gravity) return null;
    const entryEdge = entryEdgeForAngle(this.state.gravity.angle);
    if (isLaneFull(this.state.board, lane, entryEdge)) return null;

    const rows = this.state.board.length;
    const cols = this.state.board[0]!.length;
    const scratch = deepCloneBoard(this.state.board);
    const onEntryPos = entryPositionForLane(entryEdge, lane, rows, cols);
    const disc = this.queue.peek();
    placeDisc(scratch, onEntryPos.row, onEntryPos.col, disc);

    const result = settleContinuous(scratch, this.state.gravity.angle);
    const move = result.moves.find(m => m.disc.id === disc.id);
    return move ? move.to : onEntryPos;
  }

  // Backs out of an in-progress tilt for free — state.board was never
  // touched during Aiming, so this only needs to restore the angle and phase.
  cancelTilt(): void {
    if (this.state.phase !== GamePhase.Aiming || !this.state.gravity) return;
    this.state.gravity.angle = this.state.gravity.turnStartAngle;
    this.state.phase = GamePhase.WaitingForDrop;
  }

  // Commits the in-progress tilt: the whole board resettles under the
  // current gravity angle (no new disc), then normal clear/chain/push
  // resolution runs exactly as in drop(). Only valid from GamePhase.Aiming.
  // This is the point a tilt action actually spends a turn.
  commitTilt(): TurnResult {
    const boardBefore = deepCloneBoard(this.state.board);
    const trace: PhysicsTrace = { scans: [], frames: [] };
    const reject = (reason: RejectedTurnReason, gameOver = false): TurnResult => {
      if (gameOver) this.state.phase = GamePhase.GameOver;
      return { accepted: false, reason, boardBefore, steps: [], scoreAwarded: 0, gameOver, trace };
    };

    if (this.state.phase === GamePhase.GameOver) return reject('game-over', true);
    if (this.state.phase !== GamePhase.Aiming || !this.state.gravity) return reject('wrong-phase');

    // Snap to one of 8 directions and PERSIST that snapped value (not the
    // raw dragged angle) into state.gravity.angle — every other gravity
    // angle read (drop's entry edge/settle, the next tilt's turnStartAngle,
    // previewDropLanding) reads this same field, so persisting the snapped
    // value here is what keeps the whole mode consistently on the 8-shape
    // lattice from this point on, not just this one commit.
    const snappedAngle = snapAngleToEightDirections(this.state.gravity.angle);
    this.state.gravity.angle = snappedAngle;
    const steps = computeGravityTiltSteps(this.state.board, snappedAngle, this.mode, trace);
    return this.finishTurn(steps, boardBefore, trace);
  }

  // Shared turn-resolution tail for drop() and commitTilt(): both have
  // already produced the entry steps (a disc placed and/or the board
  // resettled) on this.state.board — from here on, push/level/score/
  // game-over/queue bookkeeping is identical regardless of how they got there.
  private finishTurn(steps: PhysicsStep[], boardBefore: Board, trace: PhysicsTrace): TurnResult {
    this.state.dropCount++;

    // A turn is consumed as soon as its drop resolves, so a push (triggered
    // below when this exhausts the level's budget) sees the correct count.
    this.state.turnsRemaining--;
    const levelComplete = this.state.turnsRemaining <= 0;

    let pushOverflow = false;
    if (levelComplete) {
      // The push enters from whichever edge gravity currently pulls TOWARD
      // (Classic always 'bottom'; Gravity mode's floor edge changes with the
      // tilt) — see computePushStep. Resolving any resulting matches at that
      // same angle keeps a push-triggered chain consistent with how the push
      // itself just visually happened, instead of always falling back to
      // straight-down/grid-aligned checks unrelated to the current tilt.
      const pushAngle = this.state.gravity?.angle ?? 0;
      const push = computePushStep(this.state.board, this.crackedDiscFactory, pushAngle);
      steps.push(push.step);
      trace.frames.push({ label: 'Push new cracked row', board: deepCloneBoard(this.state.board) });
      pushOverflow = push.gameOver;

      // The new row/column increases every lane's count along the push axis.
      // Resolve any matches now so they are visibly caused by the push
      // instead of disappearing on a later, unrelated drop.
      if (this.state.gravity) {
        steps.push(...computeClearSteps(
          this.state.board, this.mode, trace, b => settleContinuous(b, pushAngle), pushAngle,
        ));
      } else {
        steps.push(...computeClearSteps(this.state.board, this.mode, trace));
      }
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

    // Two terminal conditions:
    // 1. A push shoving a row-0 disc off the board — resting in row 0 through
    //    normal stacking is a valid, non-terminal state. mode.isGameOver is
    //    already applied at the correct point, inside computePushStep, before
    //    the shift; its result flows in here via pushOverflow.
    // 2. A fully-occupied board after this turn's resolution. Turn resolution
    //    loops until nothing is clearable, so a board that is still completely
    //    full at that fixed point can never change again on its own: every
    //    column rejects a drop (no legal move → no turn consumption → no push),
    //    so the state is permanently stuck. This check runs after push+clear
    //    resolution above, so a board that momentarily fills mid-turn and then
    //    clears is NOT terminal, and a level bonus awarded on a level-completing
    //    turn (pushed into `steps` above) still counts — both intended.
    const gameOver = pushOverflow || isBoardFull(this.state.board);
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
  reconfigure(mode: GameModeConfig, seedOverride?: number): void {
    this.mode = mode;
    this.customDiscFactory = undefined;
    this.customCrackedDiscFactory = undefined;
    const seed = seedOverride === undefined ? createGameSeed() : seedOverride >>> 0;
    const factories = this.createSeededFactories(seed);
    const board = makeEmptyBoard(this.mode.board.cols, this.mode.board.rows);
    this.state.board = board;
    this.queue = new DiscQueue(factories.discFactory, 1, board);
    this.crackedDiscFactory = factories.crackedDiscFactory;
    this.state.generationSeed = seed;
    this.state.generationSource = 'seeded';
    this.resetState(board);
  }

  // Resets gameplay state for a fresh game in the same mode, reusing whichever
  // disc factory the engine already has (custom-injected or mode-derived)
  // instead of rebuilding it — this preserves deterministic factories (as used
  // in tests) across a restart, matching pre-mode-system behavior.
  restart(): void {
    const seed = createGameSeed();
    this.state.generationSeed = seed;
    this.state.generationSource = this.customDiscFactory || this.customCrackedDiscFactory ? 'injected' : 'seeded';
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

  // Loads a deterministic single-scenario state for tutorials. This keeps the
  // existing GameState object alive for UI/debug references while replacing the
  // board and incoming queue with scripted values.
  loadScriptedState(options: ScriptedGameStateOptions): void {
    this.mode = options.mode ?? this.mode;
    this.customDiscFactory = undefined;
    this.customCrackedDiscFactory = options.crackedDiscFactory;
    const board = deepCloneBoard(options.board);
    const level = options.level ?? 1;
    const scriptedQueue = [
      options.currentDisc,
      options.nextDisc ?? options.queuedDiscs?.[0] ?? options.currentDisc,
      ...(options.queuedDiscs ?? []),
    ];
    let index = 0;
    const factory: DiscFactory = () => ({ ...scriptedQueue[Math.min(index++, scriptedQueue.length - 1)]! });
    this.queue = new DiscQueue((_level, _board) => factory(), level, board);
    this.crackedDiscFactory = options.crackedDiscFactory ?? (() => ({ ...options.currentDisc }));
    this.state.generationSeed = 0;
    this.state.generationSource = 'injected';
    this.state.phase = isBoardFull(board) ? GamePhase.GameOver : GamePhase.WaitingForDrop;
    this.state.board = board;
    this.state.currentDisc = this.queue.peek();
    this.state.nextDisc = this.queue.peekNext();
    this.state.cursorCol = Math.floor(this.mode.board.cols / 2);
    this.state.score = options.score ?? 0;
    this.state.dropCount = options.dropCount ?? 0;
    this.state.level = level;
    this.state.turnsPerLevel = turnsForLevel(this.mode, level);
    this.state.turnsRemaining = options.turnsRemaining ?? this.state.turnsPerLevel;
    // Re-derive gravity state for whichever mode is now active — a scripted
    // scenario can switch modes (e.g. a tutorial), and the previous mode's
    // gravity state (or lack of one) must not leak into this one.
    this.state.gravity = this.initialGravityState();
    if (this.state.gravity && options.gravityAngleDeg !== undefined) {
      this.state.gravity.angle = options.gravityAngleDeg;
      this.state.gravity.turnStartAngle = options.gravityAngleDeg;
    }
  }

  // After a tutorial/scripted scenario hands control back to normal play, keep
  // the current board/progress but replace the injected queue with the mode's
  // regular seeded generation.
  resumeSeededGeneration(seed: number = createGameSeed()): void {
    this.customDiscFactory = undefined;
    this.customCrackedDiscFactory = undefined;
    const normalizedSeed = seed >>> 0;
    const factories = this.createSeededFactories(normalizedSeed);
    this.queue = new DiscQueue(factories.discFactory, this.state.level, this.state.board);
    this.crackedDiscFactory = factories.crackedDiscFactory;
    this.state.generationSeed = normalizedSeed;
    this.state.generationSource = 'seeded';
    this.state.currentDisc = this.queue.peek();
    this.state.nextDisc = this.queue.peekNext();
  }

  private createSeededFactories(seed: number): ReturnType<typeof createDiscFactories> {
    const playableRandom = createSeededRandom(deriveSeed(seed, 0x504c4159));
    const pushRandom = createSeededRandom(deriveSeed(seed, 0x50555348));
    return createDiscFactories(this.mode, playableRandom, pushRandom);
  }

  // Column count for top/bottom entry, row count for left/right entry. Classic
  // (no gravity config) is always column-based.
  private currentLaneCount(): number {
    if (this.state.gravity) {
      const entryEdge = entryEdgeForAngle(this.state.gravity.angle);
      if (entryEdge === 'left' || entryEdge === 'right') return this.state.board.length;
    }
    return this.state.board[0]!.length;
  }

  private initialGravityState(): GravityState | undefined {
    if (!this.mode.gravity) return undefined;
    return {
      angle: this.mode.gravity.initialAngleDeg,
      turnStartAngle: this.mode.gravity.initialAngleDeg,
      maxTiltDelta: this.mode.gravity.maxTiltDeltaDeg,
    };
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
    this.state.gravity = this.initialGravityState();
  }
}
