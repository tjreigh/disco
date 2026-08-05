import type { Board, Disc, GridPos } from './model.js';
import type { GameRulesConfig } from './modes/mode.js';
import type { GameState } from './state.js';
import { GamePhase } from './state.js';
import type { PhysicsStep } from './events.js';
import { StepKind } from './events.js';
import {
  deepCloneBoard, isColumnFull, landingRow, makeEmptyBoard,
} from './board.js';
import { GravitySystem } from './gravity/system.js';
import {
  createDiscFactories, DiscFactory, DiscQueue, PlayableDiscGenerator,
  type DiscQueueSnapshot, type PlayableDiscGeneratorSnapshot, type QueuedDiscSnapshot,
} from './disc.js';
import {
  computeClearSteps, computeDropSteps, computePushStep, PhysicsTrace, pointsForStack,
} from './physics.js';
import { CLASSIC_RULES } from './modes/index.js';
import {
  rewindModifier,
  turnCostForInstability,
  turnsForLevel,
} from './modes/mode.js';
import {
  ParadoxSystem, type RewindPreview, type TurnCheckpoint,
} from './paradox/system.js';
export type { RewindFractureTarget, RewindPreview } from './paradox/system.js';
import {
  createGameSeed, createSeededRandom, deriveSeed, SnapshotRandomSource,
} from './random.js';
import {
  deserializeBoard, parseSaveGame, SAVE_GAME_VERSION,
  serializeBoard, type SaveGameV1, type SavedGenerationState, type SavedRewindCheckpoint,
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
  rules?: GameRulesConfig;
  /** Reproduce built-in disc generation with a known unsigned 32-bit seed. */
  seed?: number;
  discFactory?: DiscFactory;
  crackedDiscFactory?: DiscFactory;
  board?: Board;
  score?: number;
  dropCount?: number;
}

export interface ScriptedGameStateOptions {
  rules?: GameRulesConfig;
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
  playTimeMs?: number;
  discsBroken?: number;
  /** Controller-owned streak values aligned oldest-to-newest with rewind history. */
  rewindLongestStreaks?: readonly number[];
  savedAt?: number;
  appBuild?: string;
}

interface SeededFactories extends ReturnType<typeof createDiscFactories> {
  playableRandom: SnapshotRandomSource;
  pushRandom: SnapshotRandomSource;
  echoRandom: SnapshotRandomSource;
}

/**
 * Synchronous, headless game rules. It has no dependency on the DOM, rendering,
 * audio, input, animation frames, or wall-clock time.
 */
export class GameEngine {
  readonly state: GameState;
  private rules: GameRulesConfig;
  private queue: DiscQueue;
  private crackedDiscFactory: DiscFactory;
  private customDiscFactory: DiscFactory | undefined;
  private customCrackedDiscFactory: DiscFactory | undefined;
  private playableRandom: SnapshotRandomSource | undefined;
  private pushRandom: SnapshotRandomSource | undefined;
  private echoRandom: SnapshotRandomSource | undefined;
  private playableGenerator: PlayableDiscGenerator | undefined;
  private readonly paradoxSystem: ParadoxSystem;
  private readonly gravitySystem: GravitySystem;

  constructor(options: GameEngineOptions = {}) {
    this.rules = options.rules ?? CLASSIC_RULES;
    this.paradoxSystem = new ParadoxSystem(this.rules);
    this.gravitySystem = new GravitySystem(this.rules);
    this.customDiscFactory = options.discFactory;
    this.customCrackedDiscFactory = options.crackedDiscFactory;
    const seed = options.seed === undefined ? createGameSeed() : options.seed >>> 0;
    const factories = this.createSeededFactories(seed);
    this.retainSeededGeneration(factories);
    const initialBoard = options.board
      ? deepCloneBoard(options.board)
      : makeEmptyBoard(this.rules.board.cols, this.rules.board.rows);
    const queueFactory = options.discFactory
      ? (_level: number, _board: Board) => options.discFactory!()
      : factories.discFactory;
    this.queue = new DiscQueue(queueFactory, 1, initialBoard);
    this.crackedDiscFactory = options.crackedDiscFactory ?? factories.crackedDiscFactory;
    const dropCount = options.dropCount ?? 0;
    this.state = {
      generationSeed: seed,
      generationSource: options.discFactory || options.crackedDiscFactory ? 'injected' : 'seeded',
      phase: this.rules.failure.isTerminalBoard(initialBoard)
        ? GamePhase.GameOver
        : GamePhase.WaitingForDrop,
      board: initialBoard,
      currentDisc: this.queue.peek(),
      nextDisc: this.queue.peekNext(),
      cursorCol: Math.floor(this.rules.board.cols / 2),
      score: options.score ?? 0,
      dropCount,
      level: 1,
      turnsPerLevel: turnsForLevel(this.rules.progression, 1),
      turnsRemaining: turnsForLevel(this.rules.progression, 1),
      gravity: this.gravitySystem.initialState(),
      paradox: this.paradoxSystem.initialState(),
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
    const savesFatalRewind = this.state.phase === GamePhase.GameOver
      && rewindModifier(this.rules) !== undefined
      && this.paradoxSystem.checkpoints.some(checkpoint => checkpoint.anchor != null);
    if (this.state.phase !== GamePhase.WaitingForDrop && !savesFatalRewind) {
      throw new Error('Can only save at a stable waiting-for-drop turn boundary');
    }

    const save: SaveGameV1 = {
      version: SAVE_GAME_VERSION,
      rulesVersion: this.rules.version,
      savedAt: options.savedAt ?? Date.now(),
      modeId: this.rules.id,
      state: {
        phase: this.state.phase === GamePhase.GameOver ? 'game-over' : 'waiting',
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
          echoState: this.echoRandom!.snapshot(),
        },
      },
      session: {
        longestStreak: options.longestStreak ?? 0,
        ...(options.playTimeMs !== undefined ? { playTimeMs: options.playTimeMs } : {}),
        ...(options.discsBroken !== undefined ? { discsBroken: options.discsBroken } : {}),
      },
      ...(rewindModifier(this.rules) ? {
        paradox: {
          instability: this.state.paradox?.instability ?? 0,
          ...(this.paradoxSystem.checkpoints.length > 0 ? {
            rewinds: this.paradoxSystem.checkpoints.map((checkpoint, index) => this.serializeRewindCheckpoint(
              checkpoint,
              options.rewindLongestStreaks?.[index] ?? options.longestStreak ?? 0,
            )),
          } : {}),
        },
      } : {}),
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
  loadSave(value: unknown, rules: GameRulesConfig): SaveGameV1 {
    const save = parseSaveGame(value, rules);
    if (!save) throw new Error('Invalid or incompatible save game');

    this.rules = rules;
    this.paradoxSystem.reconfigure(rules);
    this.gravitySystem.reconfigure(rules);
    this.customDiscFactory = undefined;
    this.customCrackedDiscFactory = undefined;
    const factories = this.createSeededFactories(save.generation.seed);
    this.retainSeededGeneration(factories);

    const board = deserializeBoard(save.state.board);
    this.queue = new DiscQueue(factories.discFactory, save.state.level, board);
    this.queue.restore(this.toQueueSnapshot(save.generation.queue));
    factories.playableGenerator.restore(save.generation.playableGenerator);
    factories.playableRandom.restore(save.generation.random.playableState);
    factories.pushRandom.restore(save.generation.random.pushState);
    if (save.generation.random.echoState !== undefined) {
      factories.echoRandom.restore(save.generation.random.echoState);
    }
    this.crackedDiscFactory = factories.crackedDiscFactory;

    this.state.generationSeed = save.generation.seed;
    this.state.generationSource = 'seeded';
    this.state.phase = save.state.phase === 'game-over' ? GamePhase.GameOver : GamePhase.WaitingForDrop;
    this.state.board = board;
    this.state.currentDisc = this.queue.peek();
    this.state.nextDisc = this.queue.peekNext();
    this.state.cursorCol = save.state.cursorCol;
    this.state.score = save.state.score;
    this.state.dropCount = save.state.dropCount;
    this.state.level = save.state.level;
    this.state.turnsPerLevel = save.state.turnsPerLevel;
    this.state.turnsRemaining = save.state.turnsRemaining;
    this.state.gravity = this.gravitySystem.restoredState(save.state.gravity?.angle);
    this.state.paradox = save.paradox ? { instability: save.paradox.instability } : undefined;
    if (this.state.paradox) {
      const col = Math.max(0, Math.min(board[0]!.length - 1, save.state.cursorCol));
      this.paradoxSystem.reconcileTemporalDebt(
        board,
        this.state.paradox.instability,
        { row: landingRow(board, col) ?? 0, col },
        this.queue.peek().value,
      );
    }
    const savedRewinds = save.paradox?.rewinds ?? (save.paradox?.rewind ? [save.paradox.rewind] : []);
    const rewindHistory = savedRewinds.map<TurnCheckpoint>(rewind => {
      const rewindBoard = deserializeBoard(rewind.state.board);
      const queue = this.toQueueSnapshot(rewind.generation.queue);
      this.paradoxSystem.reconcileTemporalDebt(
        rewindBoard,
        rewind.instability,
        rewind.anchor,
        queue[0].value,
      );
      return {
        generationSeed: rewind.generation.seed,
        generationSource: 'seeded',
        board: rewindBoard,
        cursorCol: rewind.state.cursorCol,
        score: rewind.state.score,
        dropCount: rewind.state.dropCount,
        level: rewind.state.level,
        turnsPerLevel: rewind.state.turnsPerLevel,
        turnsRemaining: rewind.state.turnsRemaining,
        gravity: this.gravitySystem.restoredState(rewind.state.gravity?.angle),
        paradox: { instability: rewind.instability },
        queue,
        playableGenerator: rewind.generation.playableGenerator,
        playableRandomState: rewind.generation.random.playableState,
        pushRandomState: rewind.generation.random.pushState,
        echoRandomState: rewind.generation.random.echoState
          ?? deriveSeed(rewind.generation.seed, 0x4543484f),
        anchor: { ...rewind.anchor },
      };
    });
    this.paradoxSystem.replaceHistory(rewindHistory);
    return save;
  }

  /** True only at a stable boundary with a complete deterministic checkpoint. */
  canRewind(turns = 1): boolean {
    return this.paradoxSystem.canRewind(turns, this.state.phase, this.hasSnapshotGeneration());
  }

  /** Returns an independent preview and never consumes or mutates the checkpoint. */
  previewRewind(turns = 1): RewindPreview | null {
    return this.paradoxSystem.previewRewind(turns, this.state.phase, this.hasSnapshotGeneration());
  }

  /** Restores the selected turn boundary and consumes the abandoned timeline. */
  commitRewind(turns = 1): RewindPreview | null {
    const prepared = this.paradoxSystem.prepareRewind(
      turns,
      this.state.phase,
      this.hasSnapshotGeneration(),
    );
    if (!prepared) return null;
    const { checkpoint, preview } = prepared;
    this.restoreRewindCheckpoint(checkpoint);
    this.state.paradox = { instability: preview.instabilityAfter };
    this.paradoxSystem.applyRewindFractures(
      this.state.board,
      preview.fractures,
      preview.instabilityAfter,
    );
    this.paradoxSystem.clearHistory();
    return preview;
  }

  // `col` is the generic lane cursor: a column index for top/bottom entry
  // (Classic always, Gravity mode most of the time), or a row index when
  // Gravity mode's current angle has snapped its entry edge to left/right.
  // Only meaningful from WaitingForDrop — locked during Aiming (a tilt is
  // in progress) and after game over.
  moveCursor(col: number): void {
    if (this.state.phase !== GamePhase.WaitingForDrop) return;
    if (!Number.isInteger(col)) return;
    const laneCount = this.gravitySystem.laneCount(this.state.board, this.state.gravity);
    this.state.cursorCol = Math.max(0, Math.min(laneCount - 1, col));
  }

  // Drops a disc into a lane. Classic resolves immediately. Gravity turns are
  // staged through stageGravityDrop() and commitTilt(), so every gravity drop
  // changes direction before it can settle.
  drop(lane: number, ownerId?: string): TurnResult {
    const boardBefore = deepCloneBoard(this.state.board);
    const trace: PhysicsTrace = { scans: [], frames: [] };
    const reject = (reason: RejectedTurnReason, gameOver = false): TurnResult => {
      if (gameOver) this.state.phase = GamePhase.GameOver;
      return { accepted: false, reason, boardBefore, steps: [], scoreAwarded: 0, stackSize: 0, gameOver, trace };
    };

    if (this.state.phase === GamePhase.GameOver) return reject('game-over', true);
    if (this.state.phase !== GamePhase.WaitingForDrop) return reject('wrong-phase');

    if (this.gravitySystem.enabled) return reject('tilt-required');

    if (!Number.isInteger(lane) || lane < 0 || lane >= this.state.board[0]!.length) return reject('invalid-column');
    if (isColumnFull(this.state.board, lane)) return reject('full-column');

    const checkpoint = this.captureRewindCheckpoint();
    this.state.cursorCol = lane;
    const steps = computeDropSteps(this.state.board, this.queue.peek(), lane, this.rules, trace, undefined, 0, ownerId);
    const drop = steps.find(step => step.kind === StepKind.Drop);
    if (checkpoint && drop?.kind === StepKind.Drop) checkpoint.anchor = { ...drop.landPos };
    return this.finishTurn(steps, boardBefore, trace);
  }

  /**
   * Stages a Gravity-mode lane without changing the board or spending a turn.
   * The disc will enter through this direction's edge after the player rotates
   * and confirms; keeping the entry edge fixed is what lets a tilt reshape a
   * chosen placement instead of merely changing where it starts.
   */
  stageGravityDrop(lane: number): RejectedTurnReason | undefined {
    return this.gravitySystem.stageDrop(this.state, lane);
  }

  // Adjusts the staged Gravity turn's angle. A staged lane is required: tilt
  // is no longer a standalone cleanup turn that can be used without a drop.
  tiltGravity(delta: number): void {
    this.gravitySystem.tilt(this.state, delta);
  }

  // Pure preview of how state.board would look if the in-progress tilt were
  // committed right now — does not mutate anything. Only meaningful during
  // GamePhase.Aiming; lets the player see the result before paying a turn for it.
  // Settles at the SNAPPED angle (see commitTilt), not the raw drag value —
  // otherwise this preview would show a shape commitTilt then doesn't
  // actually produce, which is exactly the "looks like it should clear but
  // doesn't" confusion snapping the real angle is meant to eliminate.
  previewSettledBoard(): Board {
    return this.gravitySystem.previewSettledBoard(this.state, this.queue.peek());
  }

  // Pure preview of where a drop into this lane would actually land under
  // the current gravity angle — the true final resting cell, not just the
  // entry edge. Returns null if the lane is full or the mode has no gravity
  // config. Does not mutate anything.
  previewDropLanding(lane: number): GridPos | null {
    return this.gravitySystem.previewDropLanding(this.state, lane, this.queue.peek());
  }

  // Backs out of an in-progress tilt for free — state.board was never
  // touched during Aiming, so this only needs to restore the angle and phase.
  cancelTilt(): void {
    this.gravitySystem.cancelTilt(this.state);
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

    const prepared = this.gravitySystem.prepareTiltCommit(this.state, this.queue.peek(), trace);
    if (!prepared.accepted) {
      return reject(prepared.reason, prepared.reason === 'game-over');
    }
    return this.finishTurn(prepared.steps, boardBefore, trace);
  }

  // Shared turn-resolution tail for drop() and commitTilt(): both have
  // already produced the entry steps (a disc placed and/or the board
  // resettled) on this.state.board — from here on, push/level/score/
  // game-over/queue bookkeeping is identical regardless of how they got there.
  private finishTurn(steps: PhysicsStep[], boardBefore: Board, trace: PhysicsTrace): TurnResult {
    this.state.dropCount++;

    // At high Paradox instability, the completed player drop can repeat into
    // another legal column. It resolves through the same physics pipeline as
    // a normal drop, but remains part of this turn: no extra queue advance,
    // pressure cost, history checkpoint, or opportunity to echo recursively.
    this.paradoxSystem.appendTemporalEcho(
      this.state.board,
      steps,
      trace,
      this.echoRandom,
      this.state.paradox?.instability ?? 0,
    );

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

    // Instability accelerates Paradox's pressure clock. Other modes always
    // resolve to a cost of one, keeping their existing level cadence intact.
    const turnCost = turnCostForInstability(this.rules, this.state.paradox?.instability ?? 0);
    this.state.turnsRemaining -= turnCost;
    const levelComplete = this.state.turnsRemaining <= 0;

    let pushOverflow = false;
    if (levelComplete) {
      // The push enters from whichever edge gravity currently pulls TOWARD
      // (Classic always 'bottom'; Gravity mode's floor edge changes with the
      // tilt) — see computePushStep. Resolving any resulting matches at that
      // same angle keeps a push-triggered chain consistent with how the push
      // itself just visually happened, instead of always falling back to
      // straight-down/grid-aligned checks unrelated to the current tilt.
      const resolution = this.gravitySystem.resolutionContext(this.state.gravity);
      const push = computePushStep(this.state.board, this.crackedDiscFactory, resolution.angleDeg);
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
        const pushClearSteps = computeClearSteps(
          this.state.board,
          this.rules,
          trace,
          resolution.settle,
          resolution.angleDeg,
          nextChainLevel,
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
    if (this.rules.scoring.kind === 'stack-score@1' && stackSize > 0) {
      steps.push({
        kind: StepKind.Bonus,
        bonusKind: 'stack',
        pointsAwarded: pointsForStack(stackSize, this.rules.scoring.pointsPerStackUnit),
      });
    }

    if (levelComplete && !pushOverflow) {
      steps.push({
        kind: StepKind.Bonus,
        bonusKind: 'level',
        pointsAwarded: this.rules.scoring.levelBonus,
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
    //    normal stacking is a valid, non-terminal state. computePushStep
    //    detects the discarded entry-edge cell before the shift and passes
    //    that fact to the explicit failure policy as pushOverflow.
    // 2. A fully-occupied board after this turn's resolution. Turn resolution
    //    loops until nothing is clearable, so a board that is still completely
    //    full at that fixed point can never change again on its own: every
    //    column rejects a drop (no legal move → no turn consumption → no push),
    //    so the state is permanently stuck. This check runs after push+clear
    //    resolution above, so a board that momentarily fills mid-turn and then
    //    clears is NOT terminal, and a level bonus awarded on a level-completing
    //    turn (pushed into `steps` above) still counts — both intended.
    const gameOverReason: GameOverReason | undefined = this.rules.failure.gameOverReason(
      pushOverflow,
      this.state.board,
    );
    const gameOver = gameOverReason !== undefined;
    this.state.phase = gameOver ? GamePhase.GameOver : GamePhase.WaitingForDrop;

    // Board and score carry over unchanged into the new level. Skipped on game
    // over so the level/budget freeze at the state the player died in.
    if (!gameOver && levelComplete) {
      this.state.level++;
      this.state.turnsPerLevel = turnsForLevel(this.rules.progression, this.state.level);
      this.state.turnsRemaining = this.state.turnsPerLevel;
    }

    // Keep the already-previewed discs stable. Only the new tail disc uses the
    // current level's spawn probability after a level transition.
    this.queue.advance(this.state.level, this.state.board);
    this.state.currentDisc = this.queue.peek();
    this.state.nextDisc = this.queue.peekNext();

    this.paradoxSystem.recoverInstability(this.state.paradox, steps);

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
  reconfigure(rules: GameRulesConfig, seedOverride?: number): void {
    this.rules = rules;
    this.paradoxSystem.reconfigure(rules);
    this.gravitySystem.reconfigure(rules);
    this.customDiscFactory = undefined;
    this.customCrackedDiscFactory = undefined;
    const seed = seedOverride === undefined ? createGameSeed() : seedOverride >>> 0;
    const factories = this.createSeededFactories(seed);
    this.retainSeededGeneration(factories);
    const board = makeEmptyBoard(this.rules.board.cols, this.rules.board.rows);
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
    const board = makeEmptyBoard(this.rules.board.cols, this.rules.board.rows);
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
    this.rules = options.rules ?? this.rules;
    this.paradoxSystem.reconfigure(this.rules);
    this.gravitySystem.reconfigure(this.rules);
    this.customDiscFactory = undefined;
    this.customCrackedDiscFactory = options.crackedDiscFactory;
    this.playableRandom = undefined;
    this.pushRandom = undefined;
    this.echoRandom = undefined;
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
    this.state.phase = this.rules.failure.isTerminalBoard(board)
      ? GamePhase.GameOver
      : GamePhase.WaitingForDrop;
    this.state.board = board;
    this.state.currentDisc = this.queue.peek();
    this.state.nextDisc = this.queue.peekNext();
    this.state.cursorCol = Math.floor(this.rules.board.cols / 2);
    this.state.score = options.score ?? 0;
    this.state.dropCount = options.dropCount ?? 0;
    this.state.level = level;
    this.state.turnsPerLevel = turnsForLevel(this.rules.progression, level);
    this.state.turnsRemaining = options.turnsRemaining ?? this.state.turnsPerLevel;
    // Re-derive gravity state for whichever mode is now active — a scripted
    // scenario can switch modes (e.g. a tutorial), and the previous mode's
    // gravity state (or lack of one) must not leak into this one.
    this.state.gravity = this.gravitySystem.initialState();
    this.state.paradox = this.paradoxSystem.initialState();
    if (this.state.gravity && options.gravityAngleDeg !== undefined) {
      this.state.gravity.angle = options.gravityAngleDeg;
      this.state.gravity.turnStartAngle = options.gravityAngleDeg;
    }
  }

  // After a tutorial/scripted scenario hands control back to normal play, keep
  // the current board/progress but replace the injected queue with the mode's
  // regular seeded generation.
  resumeSeededGeneration(seed: number = createGameSeed()): void {
    this.paradoxSystem.clearHistory();
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
    const echoRandom = createSeededRandom(deriveSeed(seed, 0x4543484f));
    return {
      ...createDiscFactories(this.rules, playableRandom, pushRandom),
      playableRandom,
      pushRandom,
      echoRandom,
    };
  }

  private retainSeededGeneration(factories: SeededFactories): void {
    this.playableRandom = factories.playableRandom;
    this.pushRandom = factories.pushRandom;
    this.echoRandom = factories.echoRandom;
    this.playableGenerator = factories.playableGenerator;
  }

  private hasSnapshotGeneration(): boolean {
    return this.state.generationSource === 'seeded'
      && this.playableRandom !== undefined
      && this.pushRandom !== undefined
      && this.echoRandom !== undefined
      && this.playableGenerator !== undefined;
  }

  private toQueueSnapshot(queue: readonly QueuedDiscSnapshot[]): DiscQueueSnapshot {
    const [current, next, tail] = queue;
    if (!current || !next || !tail) throw new Error('Invalid saved queue');
    return [{ ...current }, { ...next }, { ...tail }];
  }

  private serializeGeneration(
    seed: number,
    queue: DiscQueueSnapshot,
    playableGenerator: PlayableDiscGeneratorSnapshot,
    playableRandomState: number,
    pushRandomState: number,
    echoRandomState: number,
  ): SavedGenerationState {
    return {
      source: 'seeded',
      seed,
      queue: queue.map(disc => ({ ...disc })),
      playableGenerator: {
        recentValues: [...playableGenerator.recentValues],
        recentKinds: [...playableGenerator.recentKinds],
      },
      random: {
        playableState: playableRandomState,
        pushState: pushRandomState,
        echoState: echoRandomState,
      },
    };
  }

  private serializeRewindCheckpoint(
    checkpoint: TurnCheckpoint,
    longestStreak: number,
  ): SavedRewindCheckpoint {
    return {
      state: {
        phase: 'waiting',
        board: serializeBoard(checkpoint.board),
        cursorCol: checkpoint.cursorCol,
        score: checkpoint.score,
        dropCount: checkpoint.dropCount,
        level: checkpoint.level,
        turnsPerLevel: checkpoint.turnsPerLevel,
        turnsRemaining: checkpoint.turnsRemaining,
        ...(checkpoint.gravity ? { gravity: { angle: checkpoint.gravity.angle } } : {}),
      },
      generation: this.serializeGeneration(
        checkpoint.generationSeed,
        checkpoint.queue,
        checkpoint.playableGenerator,
        checkpoint.playableRandomState,
        checkpoint.pushRandomState,
        checkpoint.echoRandomState,
      ),
      anchor: { ...checkpoint.anchor! },
      instability: checkpoint.paradox?.instability ?? 0,
      session: { longestStreak },
    };
  }

  private captureRewindCheckpoint(): TurnCheckpoint | null {
    const hasSnapshotGeneration = this.hasSnapshotGeneration();
    if (!this.paradoxSystem.enabled || !hasSnapshotGeneration) {
      this.paradoxSystem.clearHistory();
      return null;
    }
    const checkpoint: TurnCheckpoint = {
      generationSeed: this.state.generationSeed,
      generationSource: 'seeded',
      board: deepCloneBoard(this.state.board),
      cursorCol: this.state.cursorCol,
      score: this.state.score,
      dropCount: this.state.dropCount,
      level: this.state.level,
      turnsPerLevel: this.state.turnsPerLevel,
      turnsRemaining: this.state.turnsRemaining,
      gravity: this.state.gravity ? { ...this.state.gravity } : undefined,
      paradox: this.state.paradox ? { ...this.state.paradox } : undefined,
      queue: this.queue.snapshot(),
      playableGenerator: this.playableGenerator!.snapshot(),
      playableRandomState: this.playableRandom!.snapshot(),
      pushRandomState: this.pushRandom!.snapshot(),
      echoRandomState: this.echoRandom!.snapshot(),
      anchor: null,
    };
    return this.paradoxSystem.captureCheckpoint(checkpoint, hasSnapshotGeneration);
  }

  private restoreRewindCheckpoint(checkpoint: TurnCheckpoint): void {
    this.queue.restore(checkpoint.queue);
    this.playableGenerator!.restore(checkpoint.playableGenerator);
    this.playableRandom!.restore(checkpoint.playableRandomState);
    this.pushRandom!.restore(checkpoint.pushRandomState);
    this.echoRandom!.restore(checkpoint.echoRandomState);

    this.state.generationSeed = checkpoint.generationSeed;
    this.state.generationSource = checkpoint.generationSource;
    this.state.phase = GamePhase.WaitingForDrop;
    this.state.board = deepCloneBoard(checkpoint.board);
    this.state.currentDisc = this.queue.peek();
    this.state.nextDisc = this.queue.peekNext();
    this.state.cursorCol = checkpoint.cursorCol;
    this.state.score = checkpoint.score;
    this.state.dropCount = checkpoint.dropCount;
    this.state.level = checkpoint.level;
    this.state.turnsPerLevel = checkpoint.turnsPerLevel;
    this.state.turnsRemaining = checkpoint.turnsRemaining;
    this.state.gravity = checkpoint.gravity ? { ...checkpoint.gravity } : undefined;
    this.state.paradox = checkpoint.paradox ? { ...checkpoint.paradox } : undefined;
  }

  private resetState(board: Board): void {
    this.paradoxSystem.clearHistory();
    this.state.phase = GamePhase.WaitingForDrop;
    this.state.board = board;
    this.state.currentDisc = this.queue.peek();
    this.state.nextDisc = this.queue.peekNext();
    this.state.cursorCol = Math.floor(this.rules.board.cols / 2);
    this.state.score = 0;
    this.state.dropCount = 0;
    this.state.level = 1;
    this.state.turnsPerLevel = turnsForLevel(this.rules.progression, 1);
    this.state.turnsRemaining = this.state.turnsPerLevel;
    this.state.gravity = this.gravitySystem.initialState();
    this.state.paradox = this.paradoxSystem.initialState();
  }
}
