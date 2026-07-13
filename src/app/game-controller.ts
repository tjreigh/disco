import type { Board } from '../game/model.js';
import type { GameModeConfig } from '../game/modes/mode.js';
import type { GameState } from '../game/state.js';
import { GamePhase } from '../game/state.js';
import type { PhysicsStep } from '../game/events.js';
import { StepKind } from '../game/events.js';
import type { GravityShiftCue, ScoreIndicator, ScorePopup } from '../ui/rendering/animation-types.js';
import { deepCloneBoard, makeEmptyBoard } from '../game/board.js';
import { entryEdgeForAngle, snapAngleToEightDirections } from '../game/gravity.js';
import { GameEngine } from '../game/engine.js';
import type { GameOverReason, TurnResult } from '../game/engine.js';
import { CLASSIC_MODE, GAME_MODES } from '../game/modes/index.js';
import { DebugPanel } from '../ui/debug/debug-panel.js';
import {
  AnimationQueue, spawnGravityShiftCue, spawnScoreIndicator, spawnScorePopups,
  tickGravityShiftCue, tickScoreIndicators, tickScorePopups,
} from '../ui/rendering/animation-queue.js';
import { Renderer } from '../ui/rendering/renderer.js';
import { InputHandler } from '../platform/input-handler.js';
import type { InputIntent } from '../platform/input-handler.js';
import { AudioManager } from '../platform/audio-manager.js';
import { HomeScreen } from '../ui/home-screen.js';
import { GameOverScreen } from '../ui/game-over-screen.js';
import type { GameStats } from '../game/stats.js';
import { recordCompletedGame, updateRecords } from '../game/stats.js';
import { AccountStatsStore } from '../platform/account-stats-store.js';
import { applyStepToVisualBoard } from './visual-board.js';
import { setGridSize } from '../ui/rendering/layout.js';
import { TUTORIALS } from './tutorial.js';
import type { TutorialDefinition, TutorialStep } from './tutorial.js';
import { isTutorialStepSuccessful } from './tutorial.js';
import { TutorialOverlay } from '../ui/tutorial-overlay.js';
import { GameControls } from '../ui/game-controls.js';
import { GameHud } from '../ui/game-hud.js';
import { LocalSaveStore } from '../platform/local-save-store.js';
import type { UiMounts } from '../ui/ui-root.js';

interface LevelProgressDisplay {
  level: number;
  turnsPerLevel: number;
  turnsRemaining: number;
}

const TURN_PIP_CAPACITY = Math.max(...GAME_MODES.map(mode => mode.initialTurnsPerLevel));

export class Game {
  private state: GameState;
  private engine: GameEngine;
  private mode: GameModeConfig;
  private renderer: Renderer;
  private input: InputHandler;
  private audio: AudioManager;
  private debug: DebugPanel;
  private homeScreen: HomeScreen;
  private gameOverScreen: GameOverScreen;
  private tutorialOverlay: TutorialOverlay;
  private gameControls: GameControls;
  private gameHud: GameHud;
  private readonly saveStore: LocalSaveStore;
  private animQueue: AnimationQueue | null = null;
  private rafId = 0;
  // Tracks the board as it should look right now, advanced one physics step at a
  // time as each animation completes. This is what the renderer draws static discs
  // from. state.board is already in the final post-physics state, so drawing from
  // it would show discs at their final positions before the animations reach them.
  private visualBoard: Board;
  // Presentation-only score that lags behind the authoritative state.score,
  // catching up incrementally as each clear step's animation begins — mirrors
  // how visualBoard lags behind state.board.
  private displayedScore = 0;
  private scorePopups: ScorePopup[] = [];
  private scoreIndicators: ScoreIndicator[] = [];
  // One-shot visual sweeping the ambient gravity wash from the old direction
  // to the new one the instant a tilt commits — see spawnGravityShiftCue.
  private gravityShiftCue: GravityShiftCue | null = null;
  private stats: GameStats;
  private statsStore: AccountStatsStore;
  private unsubscribeStatsStore: (() => void) | null = null;
  private longestStreakThisGame = 0;
  private highScoreAtGameStart = 0;
  private bestRecordAtGameStart = 0;
  // Stack mode's current player-triggered cascade. This is presentation-only;
  // the engine owns both the final stack size and score award.
  private activeStack = 0;
  private stackInitialClearSize = 0;
  private stackChainBatches: Array<{ level: number; cleared: number }> = [];
  private lastStackScore: {
    initial: number;
    chains: Array<{ level: number; cleared: number }>;
    stack: number;
    points: number;
  } | null = null;
  private stackCascadeActive = false;
  private gameRecorded = false;
  private displayedLevelProgress: LevelProgressDisplay;
  private isPaused = false;
  private pauseStartedAt = 0;
  private activeTutorial: TutorialDefinition | null = null;
  private tutorialStepIndex = 0;

  constructor(canvas: HTMLCanvasElement, mounts?: UiMounts) {
    const stageMount = mounts?.stage ?? canvas.parentElement ?? document.body;
    const controlsMount = mounts?.controls
      ?? document.querySelector<HTMLElement>('.shell-region--bottom')
      ?? document.body;
    const overlayMount = mounts?.overlays ?? document.body;
    const utilityMount = mounts?.utilities ?? document.body;
    const modalBackground = mounts?.modalBackground ?? [];
    this.renderer = new Renderer(canvas);
    this.audio    = new AudioManager();
    this.mode     = CLASSIC_MODE; // placeholder until a mode is chosen on the home screen
    this.engine   = new GameEngine({ mode: this.mode });
    this.state    = this.engine.state;
    this.state.phase = GamePhase.Menu; // suppress gameplay until a mode is selected
    this.displayedLevelProgress = this.snapshotLevelProgress();
    this.debug    = new DebugPanel(this.state, undefined, utilityMount);
    this.tutorialOverlay = new TutorialOverlay(overlayMount);
    this.gameControls = new GameControls(intent => this.handleIntent(intent), controlsMount);
    this.gameHud = new GameHud(stageMount);
    this.visualBoard = makeEmptyBoard(this.mode.board.cols, this.mode.board.rows);
    this.statsStore = new AccountStatsStore(GAME_MODES);
    this.saveStore = new LocalSaveStore(GAME_MODES);
    this.stats = this.statsStore.loadStats(this.mode.id);
    this.captureGameStartRecords();

    this.homeScreen = new HomeScreen(
      GAME_MODES,
      mode => this.startGame(mode),
      modeId => this.statsStore.loadStats(modeId),
      () => this.statsStore.getState(),
      () => this.statsStore.login(),
      () => void this.statsStore.logout(),
      overlayMount,
      modalBackground,
    );
    this.gameOverScreen = new GameOverScreen(overlayMount, modalBackground);
    this.homeScreen.onRequestGameMenu = () => this.openGameMenu();
    this.homeScreen.onRequestResume = () => this.resumeGame();
    this.homeScreen.onRequestRestart = () => this.restart();
    this.homeScreen.onRequestHome = () => this.returnToMenu();
    this.homeScreen.onRequestToggleSound = () => this.toggleSound();
    this.homeScreen.onRequestTutorial = mode => this.startTutorial(mode);
    this.homeScreen.onRequestResumeSavedGame = () => this.resumeSavedGame();
    this.gameOverScreen.onRequestNewGame = () => this.restart();
    this.gameOverScreen.onRequestHome = () => this.returnToMenu();
    this.tutorialOverlay.onRetry = () => this.retryTutorialStep();
    this.tutorialOverlay.onExit = () => this.returnToMenu();
    this.tutorialOverlay.onContinue = () => this.tutorialOverlay.hide();
    this.homeScreen.setSoundEnabled(this.audio.isEnabled());
    this.unsubscribeStatsStore = this.statsStore.subscribe(() => this.handleStatsStoreUpdate());
    this.refreshSavedGameAction();
    this.homeScreen.open();

    this.input = new InputHandler(
      canvas,
      intent => this.handleIntent(intent),
      () => this.state.cursorCol,
      () => this.currentAxis(),
    );
    // Bind before the first rAF call — rAF invokes the callback without `this`,
    // so without binding, every method call inside loop() would fail.
    this.loop  = this.loop.bind(this);
    this.rafId = requestAnimationFrame(this.loop);
  }

  handleResize(): void {
    this.renderer.resize();
  }

  // Lets E2E tests get a deterministic disc sequence (?seed=123 in the URL)
  // instead of the normal random-per-playthrough seed. Not otherwise surfaced
  // in the UI — this is a testability hook, not a player-facing feature.
  private debugSeedOverride(): number | undefined {
    const raw = new URLSearchParams(window.location.search).get('seed');
    if (raw === null) return undefined;
    const parsed = Number(raw);
    return Number.isInteger(parsed) ? parsed : undefined;
  }

  private startGame(mode: GameModeConfig): void {
    this.gameOverScreen.close();
    this.saveStore.remove();
    this.refreshSavedGameAction();
    this.activeTutorial = null;
    this.tutorialOverlay.hide();
    this.mode = mode;
    this.engine.reconfigure(mode, this.debugSeedOverride()); // mutates engine.state in place; never replaces it
    this.stats = this.statsStore.loadStats(mode.id);
    this.captureGameStartRecords();
    setGridSize(mode.board.cols, mode.board.rows);
    this.renderer.resize();
    this.visualBoard = makeEmptyBoard(mode.board.cols, mode.board.rows);
    this.displayedScore = this.state.score;
    this.syncLevelProgressDisplay();
    this.scorePopups = [];
    this.scoreIndicators = [];
    this.gravityShiftCue = null;
    this.longestStreakThisGame = 0;
    this.activeStack = 0;
    this.stackInitialClearSize = 0;
    this.stackChainBatches = [];
    this.lastStackScore = null;
    this.stackCascadeActive = false;
    this.gameRecorded = false;
    this.debug.reset();
    this.isPaused = false;
    this.homeScreen.close();
  }

  private startTutorial(mode: GameModeConfig): void {
    this.gameOverScreen.close();
    const tutorial = TUTORIALS[mode.id];
    if (!tutorial) return;
    this.mode = mode;
    this.stats = this.statsStore.loadStats(mode.id);
    this.captureGameStartRecords();
    setGridSize(mode.board.cols, mode.board.rows);
    this.renderer.resize();
    this.activeTutorial = tutorial;
    this.tutorialStepIndex = 0;
    this.longestStreakThisGame = 0;
    this.activeStack = 0;
    this.stackInitialClearSize = 0;
    this.stackChainBatches = [];
    this.lastStackScore = null;
    this.stackCascadeActive = false;
    this.gameRecorded = true; // tutorials never count as completed games
    this.debug.reset();
    this.isPaused = false;
    this.scorePopups = [];
    this.scoreIndicators = [];
    this.gravityShiftCue = null;
    this.animQueue = null;
    this.loadTutorialStep();
    this.homeScreen.close();
  }

  private returnToMenu(): void {
    this.isPaused = false;
    this.gameOverScreen.close();
    this.homeScreen.closeGameMenu();
    this.activeTutorial = null;
    this.tutorialOverlay.hide();
    this.animQueue = null;
    this.scorePopups = [];
    this.scoreIndicators = [];
    this.gravityShiftCue = null;
    this.displayedScore = this.state.score;
    this.state.phase = GamePhase.Menu;
    this.refreshSavedGameAction();
    this.homeScreen.open();
  }

  // Column count for top/bottom entry, row count for left/right entry — this
  // already generalizes to a Gravity-mode tutorial step too (e.g. one loaded
  // pre-tilted via TutorialStep.gravityAngleDeg), since it only reads
  // state.gravity, which loadScriptedState now always keeps in sync with the
  // active mode/step.
  private currentLaneCount(): number {
    if (this.state.gravity) {
      const entryEdge = entryEdgeForAngle(this.state.gravity.angle);
      if (entryEdge === 'left' || entryEdge === 'right') return this.state.board.length;
    }
    return this.state.board[0]!.length;
  }

  private currentAxis(): 'col' | 'row' {
    if (this.state.gravity) {
      const entryEdge = entryEdgeForAngle(this.state.gravity.angle);
      if (entryEdge === 'left' || entryEdge === 'right') return 'row';
    }
    return 'col';
  }

  private handleIntent(intent: InputIntent): void {
    if (this.homeScreen.isGameMenuOpen()) return;
    if (this.state.phase === GamePhase.Menu) return; // overlay owns input; mode
                                                        // selection and menu return go
                                                        // through HomeScreen's own DOM
                                                        // listeners, not InputIntent.

    // Restart is always accepted, even mid-animation or after game over.
    if (intent.kind === 'restart') {
      this.restart();
      return;
    }

    // A Gravity turn stages a lane first. Q/E then rotates that staged drop;
    // there is no standalone tilt action outside Aiming.
    if (intent.kind === 'tilt') {
      if (this.state.phase === GamePhase.Aiming) {
        this.engine.tiltGravity(intent.delta);
        this.debug.refresh();
      }
      return;
    }

    // Backs out of a staged gravity drop for free — nothing was committed yet.
    if (intent.kind === 'cancel') {
      if (this.state.phase === GamePhase.Aiming) {
        this.engine.cancelTilt();
        // No-op when hidden or outside a tutorial — restores the step's own prompt.
        this.tutorialOverlay.setAimingPrompt(null);
        this.debug.refresh();
      }
      return;
    }

    if (intent.kind === 'move') {
      if (this.state.phase !== GamePhase.WaitingForDrop) return;
      const lastLane = this.currentLaneCount() - 1;
      const col = Math.max(0, Math.min(lastLane, intent.col));
      this.engine.moveCursor(col);
      return;
    }

    if (intent.kind === 'drop') {
      // Same physical action (click/tap/Enter/Space) confirms a tilt while one is in progress.
      if (this.state.phase === GamePhase.Aiming) {
        this.handleCommitTilt();
        return;
      }
      if (this.state.phase !== GamePhase.WaitingForDrop) return;

      const lastLane = this.currentLaneCount() - 1;
      const col = Math.max(0, Math.min(lastLane, intent.col));
      const tutorialStep = this.currentTutorialStep();
      if (tutorialStep && !tutorialStep.allowedCols.includes(col)) {
        this.engine.moveCursor(tutorialStep.allowedCols[0] ?? col);
        return;
      }
      this.state.cursorCol = col;
      if (this.mode.gravity) {
        const rejected = this.engine.stageGravityDrop(col);
        if (rejected === undefined && tutorialStep?.tiltPrompt) {
          this.tutorialOverlay.setAimingPrompt(tutorialStep.tiltPrompt);
        }
        this.debug.refresh();
      } else {
        this.handleDrop(col);
      }
    }
  }

  private handleDrop(col: number): void {
    const previousLevelProgress = this.snapshotLevelProgress();
    const result = this.engine.drop(col);
    this.processTurnResult(result, previousLevelProgress);
  }

  private handleCommitTilt(): void {
    const previousLevelProgress = this.snapshotLevelProgress();
    // Capture the pre-tilt direction before commitTilt overwrites the angle;
    // the cue sweeps from here to the committed angle so the rotation reads as
    // a distinct event instead of snapping on the first post-commit frame.
    const gravity = this.state.gravity;
    const fromAngle = gravity?.turnStartAngle ?? 0;
    const result = this.engine.commitTilt();
    if (result.accepted && gravity) {
      this.gravityShiftCue = spawnGravityShiftCue(fromAngle, gravity.angle, performance.now());
    }
    this.processTurnResult(result, previousLevelProgress);
  }

  private processTurnResult(result: TurnResult, previousLevelProgress: LevelProgressDisplay): void {
    if (!result.accepted) {
      this.debug.recordTurn(result);
      if (result.gameOver) {
        this.recordGameEnd();
        this.setGameOver(result.gameOverReason);
      }
      return;
    }

    const { steps } = result;
    const longestStreakThisTurn = steps.reduce(
      (longest, step) => step.kind === StepKind.Clear
        ? Math.max(longest, step.chainLevel + 1)
        : longest,
      0,
    );
    const recordForTurn = this.isStackMode() ? result.stackSize : longestStreakThisTurn;
    this.longestStreakThisGame = Math.max(this.longestStreakThisGame, recordForTurn);
    this.activeStack = 0;
    this.stackInitialClearSize = 0;
    this.stackChainBatches = [];
    this.stackCascadeActive = this.isStackMode();
    if (!this.activeTutorial) {
      const recordsImproved = updateRecords(this.stats, this.state.score, this.longestStreakThisGame);
      if (recordsImproved && !result.gameOver) this.statsStore.saveStats(this.mode.id, this.stats);
      if (result.gameOver) {
        this.saveStore.remove();
      } else {
        this.saveStore.write(this.engine.exportSave({ longestStreak: this.longestStreakThisGame }));
      }
      this.refreshSavedGameAction();
    }
    this.visualBoard = result.boardBefore;
    this.setAnimatedLevelProgress(previousLevelProgress);
    if (result.gameOver && !this.activeTutorial) this.recordGameEnd();

    // The engine has already completed the turn synchronously. The browser
    // temporarily overrides its final phase while replaying the returned steps.
    this.state.phase = GamePhase.Animating;
    this.debug.recordTurn(result);

    // Baseline for this turn's contribution — displayedScore ticks up to
    // this.state.score (already final) as each ClearStep's animation begins.
    this.displayedScore = this.state.score - result.scoreAwarded;

    this.animQueue = new AnimationQueue(
      steps,
      (step, now) => this.handleStepStart(step, now),
      step => {
        applyStepToVisualBoard(this.visualBoard, step);
        if (step.kind !== StepKind.Bonus) this.debug.advancePlayback();
      },
      () => {
        this.displayedScore = this.state.score; // convergence safety net
        this.syncLevelProgressDisplay();
        if (result.gameOver) {
          this.setGameOver(result.gameOverReason);
        } else if (this.activeTutorial) {
          this.completeTutorialTurn(result);
        } else {
          this.state.phase = GamePhase.WaitingForDrop;
          this.debug.refresh();
        }
      },
    );
  }

  // Fires the instant a step's animation begins, keeping score and its visual
  // explanation synchronized with physics playback.
  private handleStepStart(step: PhysicsStep, now: DOMHighResTimeStamp): void {
    if (step.kind === StepKind.Drop) {
      this.audio.playDrop();
    } else if (step.kind === StepKind.Push) {
      this.audio.playPush();
    } else if (step.kind === StepKind.Clear) {
      this.audio.playClear(step.chainLevel);
    } else if (step.kind === StepKind.Reveal) {
      this.audio.playReveal();
    }

    if (step.kind === StepKind.Clear) {
      if (this.stackCascadeActive) {
        const previousStack = this.activeStack;
        this.activeStack += step.cleared.length;
        if (step.chainLevel === 0) {
          this.stackInitialClearSize += step.cleared.length;
        } else {
          const level = step.chainLevel + 1; // Classic labels the initial clear CHAIN 1.
          const existing = this.stackChainBatches.find(batch => batch.level === level);
          if (existing) existing.cleared += step.cleared.length;
          else this.stackChainBatches.push({ level, cleared: step.cleared.length });
        }
        const stackUnit = this.mode.scoring.kind === 'stack' ? this.mode.scoring.pointsPerStackUnit : 0;
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
        const multiplier = Math.pow(chainLength, this.mode.chainExponent);
        this.scoreIndicators.push(spawnScoreIndicator(
          `CHAIN ${chainLength}`,
          `×${formatMultiplier(multiplier)}  +${step.pointsAwarded}`,
          now,
        ));
      }
    } else if (step.kind === StepKind.Bonus && !this.activeTutorial) {
      if (step.bonusKind === 'stack') {
        this.stackCascadeActive = false;
        this.lastStackScore = {
          initial: this.stackInitialClearSize,
          chains: this.stackChainBatches.map(batch => ({ ...batch })),
          stack: this.activeStack,
          points: step.pointsAwarded,
        };
        this.scoreIndicators.push(spawnScoreIndicator(
          `STACK ${this.activeStack}`,
          `+${step.pointsAwarded.toLocaleString('en-US')}`,
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

  private setGameOver(reason?: GameOverReason): void {
    this.saveStore.remove();
    this.refreshSavedGameAction();
    this.state.phase = GamePhase.GameOver;
    this.syncLevelProgressDisplay();
    this.recordGameEnd();
    this.debug.refresh();
    this.audio.playGameOver();
    this.gameOverScreen.open({
      score: this.state.score,
      stats: this.stats,
      isStackMode: this.isStackMode(),
      bestRunRecord: this.longestStreakThisGame,
      previousHighScore: this.highScoreAtGameStart,
      previousBestRecord: this.bestRecordAtGameStart,
      ...(reason ? { reason } : {}),
    });
    // Drop any in-progress animation — the game-over overlay renders on top,
    // so partial animation state is invisible and we can discard it safely.
    this.animQueue = null;
  }

  private recordGameEnd(): void {
    if (this.activeTutorial) return;
    if (!this.gameRecorded) {
      recordCompletedGame(this.stats, this.state.score);
      this.statsStore.recordCompletedGame(
        this.mode.id,
        this.stats,
        this.state.score,
        this.longestStreakThisGame,
      );
      this.gameRecorded = true;
    }
  }

  private handleStatsStoreUpdate(): void {
    this.homeScreen.refreshStats();
    this.homeScreen.refreshAuth();
    if (this.state.phase === GamePhase.Menu || this.state.phase === GamePhase.GameOver) {
      this.stats = this.statsStore.loadStats(this.mode.id);
    }
  }

  private restart(): void {
    this.isPaused = false;
    this.gameOverScreen.close();
    this.homeScreen.closeGameMenu();
    this.animQueue = null;
    if (this.activeTutorial) {
      this.isPaused = false;
      this.retryTutorialStep();
      return;
    }
    this.saveStore.remove();
    this.refreshSavedGameAction();
    this.engine.restart();
    this.debug.reset();
    this.visualBoard = makeEmptyBoard(this.mode.board.cols, this.mode.board.rows);
    this.displayedScore = this.state.score;
    this.syncLevelProgressDisplay();
    this.scorePopups = [];
    this.scoreIndicators = [];
    this.gravityShiftCue = null;
    this.longestStreakThisGame = 0;
    this.captureGameStartRecords();
    this.activeStack = 0;
    this.stackInitialClearSize = 0;
    this.stackChainBatches = [];
    this.lastStackScore = null;
    this.stackCascadeActive = false;
    this.gameRecorded = false;
  }

  private currentTutorialStep(): TutorialStep | null {
    return this.activeTutorial?.steps[this.tutorialStepIndex] ?? null;
  }

  private retryTutorialStep(): void {
    if (!this.activeTutorial) return;
    this.homeScreen.closeGameMenu();
    this.animQueue = null;
    this.scorePopups = [];
    this.scoreIndicators = [];
    this.gravityShiftCue = null;
    this.loadTutorialStep();
  }

  private loadTutorialStep(): void {
    const tutorial = this.activeTutorial;
    const step = this.currentTutorialStep();
    if (!tutorial || !step) return;

    this.engine.loadScriptedState({
      mode: this.mode,
      board: step.board,
      currentDisc: step.currentDisc,
      nextDisc: step.nextDisc,
      ...(step.gravityAngleDeg !== undefined ? { gravityAngleDeg: step.gravityAngleDeg } : {}),
    });
    this.visualBoard = deepCloneBoard(step.board);
    this.displayedScore = this.state.score;
    this.syncLevelProgressDisplay();
    this.state.cursorCol = step.allowedCols[0] ?? this.state.cursorCol;
    this.tutorialOverlay.show(tutorial, this.tutorialStepIndex);
    this.debug.refresh();
  }

  private completeTutorialTurn(result: { accepted: boolean; steps: readonly PhysicsStep[] }): void {
    if (!this.activeTutorial) return;
    const step = this.currentTutorialStep();
    if (!step || !isTutorialStepSuccessful(step, result, this.state.gravity?.angle)) {
      this.loadTutorialStep();
      return;
    }

    this.tutorialStepIndex++;
    if (this.tutorialStepIndex >= this.activeTutorial.steps.length) {
      const completedTutorial = this.activeTutorial;
      this.engine.resumeSeededGeneration();
      this.state.score = 0;
      this.activeTutorial = null;
      this.longestStreakThisGame = 0;
      this.gameRecorded = false;
      this.stats = this.statsStore.loadStats(this.mode.id);
      this.captureGameStartRecords();
      this.displayedScore = this.state.score;
      this.state.phase = GamePhase.WaitingForDrop;
      this.tutorialOverlay.showComplete(completedTutorial, this.mode.name);
      this.debug.refresh();
      return;
    }

    this.loadTutorialStep();
  }

  private openGameMenu(): void {
    if (this.state.phase === GamePhase.Menu) return;
    this.pausePlayback();
    this.homeScreen.setSoundEnabled(this.audio.isEnabled());
    this.homeScreen.openGameMenu();
  }

  private resumeGame(): void {
    this.resumePlayback();
    this.homeScreen.closeGameMenu();
  }

  private resumeSavedGame(): void {
    const save = this.saveStore.read();
    if (!save) {
      this.refreshSavedGameAction();
      return;
    }
    const mode = GAME_MODES.find(candidate => candidate.id === save.modeId);
    if (!mode) {
      this.saveStore.remove();
      this.refreshSavedGameAction();
      return;
    }

    try {
      this.gameOverScreen.close();
      const loaded = this.engine.loadSave(save, mode);
      this.mode = mode;
      this.stats = this.statsStore.loadStats(mode.id);
      this.captureGameStartRecords();
      setGridSize(mode.board.cols, mode.board.rows);
      this.renderer.resize();
      this.activeTutorial = null;
      this.tutorialOverlay.hide();
      this.visualBoard = deepCloneBoard(this.state.board);
      this.displayedScore = this.state.score;
      this.syncLevelProgressDisplay();
      this.scorePopups = [];
      this.scoreIndicators = [];
      this.gravityShiftCue = null;
      this.animQueue = null;
      this.longestStreakThisGame = loaded.session.longestStreak;
      this.activeStack = 0;
      this.stackInitialClearSize = 0;
      this.stackChainBatches = [];
      this.lastStackScore = null;
      this.stackCascadeActive = false;
      this.gameRecorded = false;
      this.debug.reset();
      this.isPaused = false;
      this.pauseStartedAt = 0;
      this.homeScreen.closeGameMenu();
      this.homeScreen.close();
    } catch {
      this.saveStore.remove();
      this.refreshSavedGameAction();
    }
  }

  private refreshSavedGameAction(): void {
    const save = this.saveStore.read();
    const mode = save ? GAME_MODES.find(candidate => candidate.id === save.modeId) : undefined;
    this.homeScreen.setSavedGame(save && mode
      ? { modeName: mode.name, score: save.state.score }
      : null);
  }

  private captureGameStartRecords(): void {
    this.highScoreAtGameStart = this.stats.highScore;
    this.bestRecordAtGameStart = this.stats.longestStreak;
  }

  private toggleSound(): void {
    this.homeScreen.setSoundEnabled(this.audio.toggleEnabled());
  }

  private pausePlayback(): void {
    if (this.isPaused) return;
    if (this.state.phase !== GamePhase.WaitingForDrop && this.state.phase !== GamePhase.Animating) return;
    this.isPaused = true;
    this.pauseStartedAt = performance.now();
  }

  private resumePlayback(): void {
    if (!this.isPaused) return;
    const deltaMs = performance.now() - this.pauseStartedAt;
    this.animQueue?.shiftTime(deltaMs);
    this.scorePopups = this.scorePopups.map(popup => ({ ...popup, startTime: popup.startTime + deltaMs }));
    this.scoreIndicators = this.scoreIndicators.map(indicator => ({ ...indicator, startTime: indicator.startTime + deltaMs }));
    if (this.gravityShiftCue) {
      this.gravityShiftCue = { ...this.gravityShiftCue, startTime: this.gravityShiftCue.startTime + deltaMs };
    }
    this.isPaused = false;
    this.pauseStartedAt = 0;
  }

  private snapshotLevelProgress(): LevelProgressDisplay {
    return {
      level: this.state.level,
      turnsPerLevel: this.state.turnsPerLevel,
      turnsRemaining: this.state.turnsRemaining,
    };
  }

  private syncLevelProgressDisplay(): void {
    this.displayedLevelProgress = this.snapshotLevelProgress();
  }

  private setAnimatedLevelProgress(previous: LevelProgressDisplay): void {
    if (this.state.level > previous.level) {
      this.displayedLevelProgress = {
        level: previous.level,
        turnsPerLevel: previous.turnsPerLevel,
        turnsRemaining: 0,
      };
    } else {
      this.syncLevelProgressDisplay();
    }
  }

  destroy(): void {
    cancelAnimationFrame(this.rafId);
    this.unsubscribeStatsStore?.();
    this.input.destroy();
    this.gameControls.destroy();
    this.gameHud.destroy();
  }

  private loop(now: DOMHighResTimeStamp): void {
    this.rafId = requestAnimationFrame(this.loop);

    if (!this.isPaused) {
      this.scorePopups = tickScorePopups(this.scorePopups, now);
      this.scoreIndicators = tickScoreIndicators(this.scoreIndicators, now);
      this.gravityShiftCue = tickGravityShiftCue(this.gravityShiftCue, now);
    }
    if (!this.isPaused && this.animQueue) {
      // When a gravity-shift cue is still in its head-start phase (the first
      // ~15 % of its lifespan), skip the physics animation so the ambient
      // wash sweep and edge-glow bar play first as a distinct visual event.
      // Once the cue reaches the threshold the animation begins, and the cue
      // continues playing over it — first the direction change, then the drop.
      if (!this.gravityShiftCue || this.gravityShiftCue.progress >= 0.15) {
        this.animQueue.tick(now);
      }
      if (this.animQueue?.isDone()) this.animQueue = null;
    }

    const anims = this.animQueue?.getActiveAnimations() ?? [];
    // "A tilt is owed" = no committable tilt exists yet, using the SAME
    // snapped comparison commitTilt rejects on ('tilt-required') — a player
    // who tilts +45° and returns to the start angle owes a tilt again. This
    // single value drives every attention cue (tilt buttons, HUD hint,
    // compass ring, tutorial lane pulse/arrows) so they can never disagree
    // with each other or with the engine.
    const gravity = this.state.gravity;
    const needsTilt = this.state.phase === GamePhase.Aiming
      && gravity !== undefined
      && snapAngleToEightDirections(gravity.angle) === snapAngleToEightDirections(gravity.turnStartAngle);
    const canConfirmTilt = this.state.phase === GamePhase.Aiming && !needsTilt;
    this.gameControls.render({
      phase: this.state.phase,
      hasGravity: Boolean(this.mode.gravity),
      cursorLane: this.state.cursorCol,
      laneCount: this.currentLaneCount(),
      axis: this.currentAxis(),
      canConfirmTilt,
      needsTilt,
      disabled: this.homeScreen.isGameMenuOpen() || this.isPaused,
    });
    this.gameHud.render({
      phase: this.state.phase,
      score: this.displayedScore,
      currentDisc: this.state.currentDisc,
      nextDisc: this.state.nextDisc,
      level: this.displayedLevelProgress.level,
      initialTurnsPerLevel: this.mode.initialTurnsPerLevel,
      turnsPerLevel: this.displayedLevelProgress.turnsPerLevel,
      turnsRemaining: this.displayedLevelProgress.turnsRemaining,
      turnPipCapacity: TURN_PIP_CAPACITY,
      hasGravity: Boolean(this.mode.gravity),
      gravityAngle: this.state.gravity?.angle,
      gravityTurnStartAngle: this.state.gravity?.turnStartAngle,
      gravityMaxTiltDelta: this.state.gravity?.maxTiltDelta,
      needsTilt,
      canConfirmTilt,
      isStackMode: this.isStackMode(),
      currentStack: this.activeStack,
      bestStack: Math.max(this.stats.longestStreak, this.longestStreakThisGame),
      lastStackScore: this.lastStackScore,
    });
    const tutorialStep = this.currentTutorialStep();
    // While a tilt is in progress, show how the board WOULD land at the
    // current angle rather than its actual (untouched) committed state —
    // this is a pure preview, recomputed every frame, nothing is mutated
    // until the tilt is confirmed.
    const boardToDraw = this.state.phase === GamePhase.Aiming
      ? this.engine.previewSettledBoard()
      : this.visualBoard;
    // Gravity mode's ghost preview shows the TRUE predicted landing cell
    // (not just the entry edge) so a drop's outcome is never a surprise —
    // only meaningful while a lane is actually selectable.
    const previewLanding = this.state.phase === GamePhase.WaitingForDrop && this.mode.gravity
      ? this.engine.previewDropLanding(this.state.cursorCol)
      : null;
    this.renderer.draw(
      this.state,
      boardToDraw,
      anims,
      this.stats,
      this.scorePopups,
      this.scoreIndicators,
      tutorialStep
        ? { allowedCols: tutorialStep.allowedCols, staged: this.state.phase === GamePhase.Aiming, needsTilt }
        : null,
      previewLanding,
      this.isStackMode(),
      this.gravityShiftCue,
    );
  }

  private isStackMode(): boolean {
    return this.mode.scoring?.kind === 'stack';
  }
}

function formatMultiplier(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}
