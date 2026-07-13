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
import {
  createDiscFactories, DiscFactory, DiscQueue, PlayableDiscGenerator,
} from './disc.js';
import {
  computeClearSteps, computeDropSteps, computeGravityDropSteps, computeGravityTiltSteps,
  computePushStep, PhysicsTrace, pointsForStack,
} from './physics.js';
import { CLASSIC_MODE } from './modes/index.js';
import { turnsForLevel } from './modes/mode.js';
import {
  createGameSeed, createSeededRandom, deriveSeed, SnapshotRandomSource,
} from './random.js';
import {
  deserializeBoard, parseSaveGame, SAVE_GAME_RULES_VERSION, SAVE_GAME_VERSION,
  serializeBoard, type SaveGameV1,
} from './save.js';

export type RejectedTurnReason = 'game-over' | 'wrong-phase' | 'invalid-column' | 'full-column' | 'tilt-required';
export type GameOverReason = 'push-overflow' | 'board-full';

export interface TurnResult {
  accepted: boolean;
  reason?: RejectedTurnReason;
  /** Board immediately before the turn, for animation playback or assertions. */
  boardBefore: Board;
  steps: PhysicsStep[];
  scoreAwarded: number;
  /** Numbered discs cleared while resolving the accepted turn, including level-end push clears. */
  stackSize: number;
  gameOver: boolean;
  /** Present when this accepted turn caused the game to end. */
  gameOverReason?: GameOverReason;
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

export interface ExportSaveOptions {
  longestStreak?: number;
  savedAt?: number;
  appBuild?: string;
}

interface SeededFactories extends ReturnType<typeof createDiscFactories> {
  playableRandom: SnapshotRandomSource;
  pushRandom: SnapshotRandomSource;
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
  private playableRandom: SnapshotRandomSource | undefined;
  private pushRandom: SnapshotRandomSource | undefined;
  private playableGenerator: PlayableDiscGenerator | undefined;

  constructor(options: GameEngineOptions = {}) {
    this.mode = options.mode ?? CLASSIC_MODE;
    this.customDiscFactory = options.discFactory;
    this.customCrackedDiscFactory = options.crackedDiscFactory;
    const seed = options.seed === undefined ? createGameSeed() : options.seed >>> 0;
    const factories = this.createSeededFactories(seed);
    this.retainSeededGeneration(factories);
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

  /**
   * Captures an authoritative, stable turn boundary. Presentation-only phases,
   * game-over states, and injected/tutorial generation cannot be resumed
   * deterministically and are deliberately rejected.
   */
  exportSave(options: ExportSaveOptions = {}): SaveGameV1 {
    if (this.state.generationSource !== 'seeded'
      || !this.playableRandom || !this.pushRandom || !this.playableGenerator) {
      throw new Error('Cannot save a game that uses injected disc generation');
    }
    if (this.state.phase !== GamePhase.WaitingForDrop) {
      throw new Error('Can only save at a stable waiting-for-drop turn boundary');
    }

    const save: SaveGameV1 = {
      version: SAVE_GAME_VERSION,
      rulesVersion: SAVE_GAME_RULES_VERSION,
      savedAt: options.savedAt ?? Date.now(),
      modeId: this.mode.id,
      state: {
        phase: 'waiting',
        board: serializeBoard(this.state.board),
        cursorCol: this.state.cursorCol,
        score: this.state.score,
        dropCount: this.state.dropCount,
        level: this.state.level,
        turnsPerLevel: this.state.turnsPerLevel,
        turnsRemaining: this.state.turnsRemaining,
        ...(this.state.gravity ? { gravity: { angle: this.state.gravity.angle } } : {}),
      },
      generation: {
        source: 'seeded',
        seed: this.state.generationSeed,
        queue: [...this.queue.snapshot()],
        playableGenerator: this.playableGenerator.snapshot(),
        random: {
          playableState: this.playableRandom.snapshot(),
          pushState: this.pushRandom.snapshot(),
        },
      },
      session: { longestStreak: options.longestStreak ?? 0 },
      meta: { source: 'autosave' },
    };
    if (options.appBuild !== undefined) save.appBuild = options.appBuild;
    return save;
  }

  /**
   * Validates and restores an untrusted save using the supplied mode rules.
   * The existing GameState object remains alive for controller/render clients.
   * Returns the validated copy so controller-owned session metadata is easy to
   * restore alongside the engine state.
   */
  loadSave(value: unknown, mode: GameModeConfig): SaveGameV1 {
    const save = parseSaveGame(value, mode);
    if (!save) throw new Error('Invalid or incompatible save game');

    this.mode = mode;
    this.customDiscFactory = undefined;
    this.customCrackedDiscFactory = undefined;
    const factories = this.createSeededFactories(save.generation.seed);
    this.retainSeededGeneration(factories);

    const board = deserializeBoard(save.state.board);
    this.queue = new DiscQueue(factories.discFactory, save.state.level, board);
    this.queue.restore(save.generation.queue);
    factories.playableGenerator.restore(save.generation.playableGenerator);
    factories.playableRandom.restore(save.generation.random.playableState);
    factories.pushRandom.restore(save.generation.random.pushState);
    this.crackedDiscFactory = factories.crackedDiscFactory;

    this.state.generationSeed = save.generation.seed;
    this.state.generationSource = 'seeded';
    this.state.phase = GamePhase.WaitingForDrop;
    this.state.board = board;
    this.state.currentDisc = this.queue.peek();
    this.state.nextDisc = this.queue.peekNext();
    this.state.cursorCol = save.state.cursorCol;
    this.state.score = save.state.score;
    this.state.dropCount = save.state.dropCount;
    this.state.level = save.state.level;
    this.state.turnsPerLevel = save.state.turnsPerLevel;
    this.state.turnsRemaining = save.state.turnsRemaining;
    this.state.gravity = save.state.gravity ? {
      angle: save.state.gravity.angle,
      turnStartAngle: save.state.gravity.angle,
      maxTiltDelta: mode.gravity!.maxTiltDeltaDeg,
    } : undefined;
    return save;
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

  // Drops a disc into a lane. Classic resolves immediately. Gravity turns are
  // staged through stageGravityDrop() and commitTilt(), so every gravity drop
  // changes direction before it can settle.
  drop(lane: number): TurnResult {
    const boardBefore = deepCloneBoard(this.state.board);
    const trace: PhysicsTrace = { scans: [], frames: [] };
    const reject = (reason: RejectedTurnReason, gameOver = false): TurnResult => {
      if (gameOver) this.state.phase = GamePhase.GameOver;
      return { accepted: false, reason, boardBefore, steps: [], scoreAwarded: 0, stackSize: 0, gameOver, trace };
    };

    if (this.state.phase === GamePhase.GameOver) return reject('game-over', true);
    if (this.state.phase !== GamePhase.WaitingForDrop) return reject('wrong-phase');

    if (this.mode.gravity) return reject('tilt-required');

    if (!Number.isInteger(lane) || lane < 0 || lane >= this.state.board[0]!.length) return reject('invalid-column');
    if (isColumnFull(this.state.board, lane)) return reject('full-column');

    this.state.cursorCol = lane;
    const steps = computeDropSteps(this.state.board, this.queue.peek(), lane, this.mode, trace);
    return this.finishTurn(steps, boardBefore, trace);
  }

  /**
   * Stages a Gravity-mode lane without changing the board or spending a turn.
   * The disc will enter through this direction's edge after the player rotates
   * and confirms; keeping the entry edge fixed is what lets a tilt reshape a
   * chosen placement instead of merely changing where it starts.
   */
  stageGravityDrop(lane: number): RejectedTurnReason | undefined {
    if (!this.mode.gravity || !this.state.gravity) return 'wrong-phase';
    if (this.state.phase === GamePhase.GameOver) return 'game-over';
    if (this.state.phase !== GamePhase.WaitingForDrop) return 'wrong-phase';

    const entryEdge = entryEdgeForAngle(this.state.gravity.angle);
    if (!Number.isInteger(lane) || lane < 0 || lane >= this.currentLaneCount()) return 'invalid-column';
    if (isLaneFull(this.state.board, lane, entryEdge)) return 'full-column';

    this.state.cursorCol = lane;
    this.state.gravity.turnStartAngle = this.state.gravity.angle;
    this.state.gravity.pendingLane = lane;
    this.state.phase = GamePhase.Aiming;
    return undefined;
  }

  // Adjusts the staged Gravity turn's angle. A staged lane is required: tilt
  // is no longer a standalone cleanup turn that can be used without a drop.
  tiltGravity(delta: number): void {
    if (!this.state.gravity) return;
    if (this.state.phase !== GamePhase.Aiming || this.state.gravity.pendingLane === undefined) return;

    const gravity = this.state.gravity;
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
    const gravity = this.state.gravity;
    if (gravity?.pendingLane !== undefined) {
      const entryEdge = entryEdgeForAngle(gravity.turnStartAngle);
      const rows = scratch.length;
      const cols = scratch[0]!.length;
      const entryPos = entryPositionForLane(entryEdge, gravity.pendingLane, rows, cols);
      placeDisc(scratch, entryPos.row, entryPos.col, this.queue.peek());
    }
    if (gravity) settleContinuous(scratch, snapAngleToEightDirections(gravity.angle));
    return scratch;
  }

  // Pure preview of where a drop into this lane would actually land under
  // the current gravity angle — the true final resting cell, not just the
  // entry edge. Returns null if the lane is full or the mode has no gravity
  // config. Does not mutate anything.
  previewDropLanding(lane: number): GridPos | null {
    if (!this.mode.gravity || !this.state.gravity) return null;
    const gravity = this.state.gravity;
    const staged = gravity.pendingLane !== undefined;
    const selectedLane = gravity.pendingLane ?? lane;
    const entryEdge = entryEdgeForAngle(staged ? gravity.turnStartAngle : gravity.angle);
    if (isLaneFull(this.state.board, selectedLane, entryEdge)) return null;

    const rows = this.state.board.length;
    const cols = this.state.board[0]!.length;
    const scratch = deepCloneBoard(this.state.board);
    const onEntryPos = entryPositionForLane(entryEdge, selectedLane, rows, cols);
    const disc = this.queue.peek();
    placeDisc(scratch, onEntryPos.row, onEntryPos.col, disc);

    const result = settleContinuous(scratch, gravity.angle);
    const move = result.moves.find(m => m.disc.id === disc.id);
    return move ? move.to : onEntryPos;
  }

  // Backs out of an in-progress tilt for free — state.board was never
  // touched during Aiming, so this only needs to restore the angle and phase.
  cancelTilt(): void {
    if (this.state.phase !== GamePhase.Aiming || !this.state.gravity) return;
    this.state.gravity.angle = this.state.gravity.turnStartAngle;
    delete this.state.gravity.pendingLane;
    this.state.phase = GamePhase.WaitingForDrop;
  }

  // Commits the staged Gravity drop. A turn must resolve at a different
  // snapped angle from where it began, so gravity changes every turn.
  commitTilt(): TurnResult {
    const boardBefore = deepCloneBoard(this.state.board);
    const trace: PhysicsTrace = { scans: [], frames: [] };
    const reject = (reason: RejectedTurnReason, gameOver = false): TurnResult => {
      if (gameOver) this.state.phase = GamePhase.GameOver;
      return { accepted: false, reason, boardBefore, steps: [], scoreAwarded: 0, stackSize: 0, gameOver, trace };
    };

    if (this.state.phase === GamePhase.GameOver) return reject('game-over', true);
    if (this.state.phase !== GamePhase.Aiming || !this.state.gravity || this.state.gravity.pendingLane === undefined) return reject('wrong-phase');

    // Snap to one of 8 directions and PERSIST that snapped value (not the
    // raw dragged angle) into state.gravity.angle — every other gravity
    // angle read (drop's entry edge/settle, the next tilt's turnStartAngle,
    // previewDropLanding) reads this same field, so persisting the snapped
    // value here is what keeps the whole mode consistently on the 8-shape
    // lattice from this point on, not just this one commit.
    const snappedAngle = snapAngleToEightDirections(this.state.gravity.angle);
    if (snappedAngle === snapAngleToEightDirections(this.state.gravity.turnStartAngle)) return reject('tilt-required');
    const entryEdge = entryEdgeForAngle(this.state.gravity.turnStartAngle);
    const lane = this.state.gravity.pendingLane!;
    this.state.gravity.angle = snappedAngle;
    delete this.state.gravity.pendingLane;
    // Recenter the lane cursor when a tilt flips the entry axis (columns ↔
    // rows): the same numeric index is otherwise silently reinterpreted on the
    // new axis with no clamping, so the post-drop highlight/ghost land on an
    // unrelated lane once play resumes. currentLaneCount() reads the
    // just-committed angle, so its range already matches the new axis. A
    // same-axis tilt (e.g. 0° → 180°, both top/bottom entry) leaves the cursor
    // where the player put it.
    const newEdge = entryEdgeForAngle(snappedAngle);
    const axisFlipped = (entryEdge === 'left' || entryEdge === 'right')
      !== (newEdge === 'left' || newEdge === 'right');
    if (axisFlipped) {
      this.state.cursorCol = Math.floor(this.currentLaneCount() / 2);
    }
    const steps = computeGravityDropSteps(
      this.state.board, this.queue.peek(), lane, entryEdge, snappedAngle, this.mode, trace,
    );
    return this.finishTurn(steps, boardBefore, trace);
  }

  // Shared turn-resolution tail for drop() and commitTilt(): both have
  // already produced the entry steps (a disc placed and/or the board
  // resettled) on this.state.board — from here on, push/level/score/
  // game-over/queue bookkeeping is identical regardless of how they got there.
  private finishTurn(steps: PhysicsStep[], boardBefore: Board, trace: PhysicsTrace): TurnResult {
    this.state.dropCount++;

    // A level-end push can continue a cascade started by this drop. Preserve
    // the next chain level so the push-side resolver does not restart at zero.
    // A push that happens without an entry clear remains an independent clear.
    const entryStackSize = steps.reduce(
      (total, step) => total + (step.kind === StepKind.Clear ? step.cleared.length : 0),
      0,
    );
    const nextChainLevel = steps.reduce(
      (next, step) => step.kind === StepKind.Clear
        ? Math.max(next, step.chainLevel + 1)
        : next,
      0,
    );
    let pushStackSize = 0;

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

      // Overflow is terminal at the instant the push discards an occupied
      // entry-edge cell. Keep the fatal Push step for playback, but do not
      // resolve or score changes on a board that is already game over.
      if (!pushOverflow) {
        // The new row/column increases every lane's count along the push axis.
        // Resolve any matches now so they are visibly caused by the push
        // instead of disappearing on a later, unrelated drop.
        const pushClearSteps = this.state.gravity
          ? computeClearSteps(
            this.state.board, this.mode, trace, b => settleContinuous(b, pushAngle), pushAngle,
            nextChainLevel,
          )
          : computeClearSteps(
            this.state.board, this.mode, trace, undefined, 0, nextChainLevel,
          );
        steps.push(...pushClearSteps);
        pushStackSize = pushClearSteps.reduce(
          (total, step) => total + (step.kind === StepKind.Clear ? step.cleared.length : 0),
          0,
        );
      }
    }

    // Stack scores every numbered disc cleared while resolving the accepted
    // turn. A level-boundary push is part of that same resolution, whether it
    // continues an existing chain or initiates the turn's first clear.
    const stackSize = entryStackSize + pushStackSize;
    if (this.mode.scoring.kind === 'stack' && stackSize > 0) {
      steps.push({
        kind: StepKind.Bonus,
        bonusKind: 'stack',
        pointsAwarded: pointsForStack(stackSize, this.mode.scoring.pointsPerStackUnit),
      });
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
    const gameOverReason: GameOverReason | undefined = pushOverflow
      ? 'push-overflow'
      : isBoardFull(this.state.board) ? 'board-full' : undefined;
    const gameOver = gameOverReason !== undefined;
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

    return {
      accepted: true,
      boardBefore,
      steps,
      scoreAwarded,
      stackSize,
      gameOver,
      ...(gameOverReason ? { gameOverReason } : {}),
      trace,
    };
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
    this.retainSeededGeneration(factories);
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
    this.retainSeededGeneration(factories);
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
    this.playableRandom = undefined;
    this.pushRandom = undefined;
    this.playableGenerator = undefined;
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
    this.retainSeededGeneration(factories);
    this.queue = new DiscQueue(factories.discFactory, this.state.level, this.state.board);
    this.crackedDiscFactory = factories.crackedDiscFactory;
    this.state.generationSeed = normalizedSeed;
    this.state.generationSource = 'seeded';
    this.state.currentDisc = this.queue.peek();
    this.state.nextDisc = this.queue.peekNext();
  }

  private createSeededFactories(seed: number): SeededFactories {
    const playableRandom = createSeededRandom(deriveSeed(seed, 0x504c4159));
    const pushRandom = createSeededRandom(deriveSeed(seed, 0x50555348));
    return {
      ...createDiscFactories(this.mode, playableRandom, pushRandom),
      playableRandom,
      pushRandom,
    };
  }

  private retainSeededGeneration(factories: SeededFactories): void {
    this.playableRandom = factories.playableRandom;
    this.pushRandom = factories.pushRandom;
    this.playableGenerator = factories.playableGenerator;
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
