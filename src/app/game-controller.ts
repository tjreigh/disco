import type { Board } from '../game/model.js';
import type { GameModeConfig } from '../game/modes/mode.js';
import type { GameState } from '../game/state.js';
import { GamePhase } from '../game/state.js';
import type { PhysicsStep } from '../game/events.js';
import { StepKind } from '../game/events.js';
import type { ScoreIndicator, ScorePopup } from '../ui/rendering/animation-types.js';
import { makeEmptyBoard } from '../game/board.js';
import { GameEngine } from '../game/engine.js';
import { CLASSIC_MODE, GAME_MODES } from '../game/modes/index.js';
import { DebugPanel } from '../ui/debug/debug-panel.js';
import {
  AnimationQueue, spawnScoreIndicator, spawnScorePopups,
  tickScoreIndicators, tickScorePopups,
} from '../ui/rendering/animation-queue.js';
import { Renderer } from '../ui/rendering/renderer.js';
import { InputHandler } from '../platform/input-handler.js';
import type { InputIntent } from '../platform/input-handler.js';
import { AudioManager } from '../platform/audio-manager.js';
import { HomeScreen } from '../ui/home-screen.js';
import type { GameStats } from '../game/stats.js';
import { recordCompletedGame, updateRecords } from '../game/stats.js';
import { loadStats, saveStats } from '../platform/cookie-stats-store.js';

export class Game {
  private state: GameState;
  private engine: GameEngine;
  private mode: GameModeConfig;
  private renderer: Renderer;
  private input: InputHandler;
  private audio: AudioManager;
  private debug: DebugPanel;
  private homeScreen: HomeScreen;
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
  private stats: GameStats;
  private longestStreakThisGame = 0;
  private gameRecorded = false;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new Renderer(canvas);
    this.audio    = new AudioManager();
    this.mode     = CLASSIC_MODE; // placeholder until a mode is chosen on the home screen
    this.engine   = new GameEngine({ mode: this.mode });
    this.state    = this.engine.state;
    this.state.phase = GamePhase.Menu; // suppress gameplay until a mode is selected
    this.debug    = new DebugPanel(this.state);
    this.visualBoard = makeEmptyBoard(this.mode.board.cols, this.mode.board.rows);
    this.stats = loadStats(this.mode.id);

    this.homeScreen = new HomeScreen(GAME_MODES, mode => this.startGame(mode), loadStats);
    this.homeScreen.onRequestMenu = () => this.returnToMenu();
    this.homeScreen.open();

    this.input = new InputHandler(
      canvas,
      intent => this.handleIntent(intent),
      () => this.state.phase === GamePhase.GameOver,
      () => this.state.cursorCol,
    );
    // Bind before the first rAF call — rAF invokes the callback without `this`,
    // so without binding, every method call inside loop() would fail.
    this.loop  = this.loop.bind(this);
    this.rafId = requestAnimationFrame(this.loop);
  }

  handleResize(): void {
    this.renderer.resize();
  }

  private startGame(mode: GameModeConfig): void {
    this.mode = mode;
    this.engine.reconfigure(mode); // mutates engine.state in place; never replaces it
    this.stats = loadStats(mode.id);
    this.visualBoard = makeEmptyBoard(mode.board.cols, mode.board.rows);
    this.displayedScore = this.state.score;
    this.scorePopups = [];
    this.scoreIndicators = [];
    this.longestStreakThisGame = 0;
    this.gameRecorded = false;
    this.debug.reset();
    this.homeScreen.close();
  }

  private returnToMenu(): void {
    this.animQueue = null;
    this.scorePopups = [];
    this.scoreIndicators = [];
    this.displayedScore = this.state.score;
    this.state.phase = GamePhase.Menu;
    this.homeScreen.open();
  }

  private handleIntent(intent: InputIntent): void {
    if (this.state.phase === GamePhase.Menu) return; // overlay owns input; mode
                                                        // selection and menu return go
                                                        // through HomeScreen's own DOM
                                                        // listeners, not InputIntent.

    // Restart is always accepted, even mid-animation or after game over.
    if (intent.kind === 'restart') {
      this.restart();
      return;
    }

    // All other intents are ignored while animating or after game over.
    if (this.state.phase !== GamePhase.WaitingForDrop) return;

    const lastCol = this.state.board[0]!.length - 1;
    if (intent.kind === 'move') {
      const col = Math.max(0, Math.min(lastCol, intent.col));
      this.engine.moveCursor(col);
    } else if (intent.kind === 'drop') {
      const col = Math.max(0, Math.min(lastCol, intent.col));
      this.state.cursorCol = col;
      this.handleDrop(col);
    }
  }

  private handleDrop(col: number): void {
    const result = this.engine.drop(col);
    if (!result.accepted) {
      this.debug.recordTurn(result);
      if (result.gameOver) this.setGameOver();
      return;
    }

    const { steps } = result;
    const longestStreakThisTurn = steps.reduce(
      (longest, step) => step.kind === StepKind.Clear
        ? Math.max(longest, step.chainLevel + 1)
        : longest,
      0,
    );
    this.longestStreakThisGame = Math.max(this.longestStreakThisGame, longestStreakThisTurn);
    updateRecords(this.stats, this.state.score, this.longestStreakThisGame);
    saveStats(this.mode.id, this.stats);
    this.visualBoard = result.boardBefore;
    if (steps.some(step => step.kind === StepKind.Push)) this.audio.playPush();

    this.audio.playDrop();
    const hasClears = steps.some(s => s.kind === StepKind.Clear);
    if (hasClears) {
      const maxChain = steps
        .filter(s => s.kind === StepKind.Clear)
        .reduce((m, s) => (s.kind === StepKind.Clear ? Math.max(m, s.chainLevel) : m), 0);
      this.audio.playClear(maxChain);
    }

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
        this.applyStepToVisualBoard(step);
        this.debug.advancePlayback();
      },
      () => {
        this.displayedScore = this.state.score; // convergence safety net
        if (result.gameOver) {
          this.setGameOver();
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
    if (step.kind === StepKind.Clear) {
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
    } else if (step.kind === StepKind.Bonus) {
      this.displayedScore += step.pointsAwarded;
      this.scoreIndicators.push(spawnScoreIndicator(
        step.bonusKind === 'level' ? 'LEVEL BONUS' : 'BOARD CLEAR',
        `+${step.pointsAwarded.toLocaleString('en-US')}`,
        now,
      ));
    }
  }

  // Applies a completed physics step to visualBoard so the next frame's static
  // draw shows discs at their post-step positions. Called by AnimationQueue after
  // each step's animations finish but before the next step's animations begin.
  private applyStepToVisualBoard(step: PhysicsStep): void {
    const vb = this.visualBoard;
    switch (step.kind) {
      case StepKind.Drop:
        vb[step.toLandRow]![step.col] = { ...step.disc };
        break;
      case StepKind.Clear:
        for (const pos of step.cleared) {
          vb[pos.row]![pos.col] = null;
        }
        break;
      case StepKind.Reveal:
        // positions[i] and discs[i] are parallel; discs carry the post-physics
        // kind. The visual board's disc objects are separate clones so we update
        // kind by matching position rather than object identity.
        for (let i = 0; i < step.positions.length; i++) {
          const pos  = step.positions[i]!;
          const disc = step.discs[i]!;
          const cell = vb[pos.row]![pos.col];
          if (cell != null) cell.kind = disc.kind;
        }
        break;
      case StepKind.Fall:
        for (const m of step.moves) {
          vb[m.to.row]![m.to.col] = vb[m.from.row]![m.from.col]!;
          if (m.from.row !== m.to.row) vb[m.from.row]![m.from.col] = null;
        }
        break;
      case StepKind.Push:
        // Mirror what computePushStep does: shift rows up, place new row at bottom.
        for (let r = 0; r < vb.length - 1; r++) vb[r] = vb[r + 1]!;
        vb[vb.length - 1] = step.newRow.map(d => ({ ...d }));
        break;
      case StepKind.Bonus:
        break;
    }
  }

  private setGameOver(): void {
    this.state.phase = GamePhase.GameOver;
    if (!this.gameRecorded) {
      recordCompletedGame(this.stats, this.state.score);
      saveStats(this.mode.id, this.stats);
      this.gameRecorded = true;
    }
    this.debug.refresh();
    this.audio.playGameOver();
    // Drop any in-progress animation — the game-over overlay renders on top,
    // so partial animation state is invisible and we can discard it safely.
    this.animQueue = null;
  }

  private restart(): void {
    this.animQueue = null;
    this.engine.restart();
    this.debug.reset();
    this.visualBoard = makeEmptyBoard(this.mode.board.cols, this.mode.board.rows);
    this.displayedScore = this.state.score;
    this.scorePopups = [];
    this.scoreIndicators = [];
    this.longestStreakThisGame = 0;
    this.gameRecorded = false;
  }

  private loop(now: DOMHighResTimeStamp): void {
    this.rafId = requestAnimationFrame(this.loop);

    if (this.animQueue) {
      this.animQueue.tick(now);
      if (this.animQueue.isDone()) this.animQueue = null;
    }
    this.scorePopups = tickScorePopups(this.scorePopups, now);
    this.scoreIndicators = tickScoreIndicators(this.scoreIndicators, now);

    const anims = this.animQueue?.getActiveAnimations() ?? [];
    this.renderer.draw(
      this.state,
      this.visualBoard,
      anims,
      this.stats,
      this.displayedScore,
      this.scorePopups,
      this.scoreIndicators,
      this.mode.initialTurnsPerLevel,
    );
  }
}

function formatMultiplier(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}
