import { Board, GamePhase, GameState, PhysicsStep, StepKind } from './types.js';
import { GRID_COLS, GRID_ROWS } from './constants.js';
import { makeEmptyBoard } from './board.js';
import { GameEngine } from './engine.js';
import { DebugPanel } from './debug.js';
import { AnimationQueue } from './animation.js';
import { Renderer } from './renderer.js';
import { InputHandler } from './input.js';
import { AudioManager } from './audio.js';

export class Game {
  private state: GameState;
  private engine: GameEngine;
  private renderer: Renderer;
  private input: InputHandler;
  private audio: AudioManager;
  private debug: DebugPanel;
  private animQueue: AnimationQueue | null = null;
  private rafId = 0;
  // Tracks the board as it should look right now, advanced one physics step at a
  // time as each animation completes. This is what the renderer draws static discs
  // from. state.board is already in the final post-physics state, so drawing from
  // it would show discs at their final positions before the animations reach them.
  private visualBoard: Board;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new Renderer(canvas);
    this.audio    = new AudioManager();
    this.engine   = new GameEngine();
    this.state    = this.engine.state;
    this.debug    = new DebugPanel(this.state);
    this.visualBoard = makeEmptyBoard();

    this.input = new InputHandler(
      canvas,
      intent => this.handleIntent(intent),
      () => this.state.phase === GamePhase.GameOver,
    );
    // Bind before the first rAF call — rAF invokes the callback without `this`,
    // so without binding, every method call inside loop() would fail.
    this.loop  = this.loop.bind(this);
    this.rafId = requestAnimationFrame(this.loop);
  }

  handleResize(): void {
    this.renderer.resize();
  }

  private handleIntent(intent: { kind: string; col?: number }): void {
    // Restart is always accepted, even mid-animation or after game over.
    if (intent.kind === 'restart') {
      this.restart();
      return;
    }

    // All other intents are ignored while animating or after game over.
    if (this.state.phase !== GamePhase.WaitingForDrop) return;

    if (intent.kind === 'move' && typeof intent.col === 'number') {
      const col = Math.max(0, Math.min(GRID_COLS - 1, intent.col));
      this.engine.moveCursor(col);
    } else if (intent.kind === 'drop' && typeof intent.col === 'number') {
      const col = Math.max(0, Math.min(GRID_COLS - 1, intent.col));
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

    this.animQueue = new AnimationQueue(
      steps,
      step => {
        this.applyStepToVisualBoard(step);
        this.debug.advancePlayback();
      },
      () => {
        if (result.gameOver) {
          this.setGameOver();
        } else {
          this.state.phase = GamePhase.WaitingForDrop;
          this.debug.refresh();
        }
      },
    );
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
        for (let r = 0; r < GRID_ROWS - 1; r++) vb[r] = vb[r + 1]!;
        vb[GRID_ROWS - 1] = step.newRow.map(d => ({ ...d }));
        break;
    }
  }

  private setGameOver(): void {
    this.state.phase = GamePhase.GameOver;
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
    this.visualBoard = makeEmptyBoard();
  }

  private loop(now: DOMHighResTimeStamp): void {
    this.rafId = requestAnimationFrame(this.loop);

    if (this.animQueue) {
      this.animQueue.tick(now);
      if (this.animQueue.isDone()) this.animQueue = null;
    }

    const anims = this.animQueue?.getActiveAnimations() ?? [];
    this.renderer.draw(this.state, this.visualBoard, anims);
  }
}
