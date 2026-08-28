import { applyStepToVisualBoard } from './visual-board.js';
import { deepCloneBoard, makeEmptyBoard, placeDisc } from '../game/board.js';
import { makeDisc } from '../game/disc.js';
import { GameEngine } from '../game/engine.js';
import type { ScriptedGameStateOptions, TurnResult } from '../game/engine.js';
import { StepKind } from '../game/events.js';
import { CLASSIC_RULES } from '../game/modes/index.js';
import { DiscKind, type Disc } from '../game/model.js';
import { GamePhase } from '../game/state.js';
import { emptyStats } from '../game/stats.js';
import {
  AnimationQueue, spawnScorePopups, tickScorePopups,
} from '../ui/rendering/animation-queue.js';
import type { ScorePopup } from '../ui/rendering/animation-types.js';
import { setGridSize, setHudBands } from '../ui/rendering/layout.js';
import { Renderer } from '../ui/rendering/renderer.js';

const INITIAL_PAUSE_MS = 1_500;
const BETWEEN_MOVES_MS = 900;
const FINAL_PAUSE_MS = 3_000;
const DEMO_MOVES = [0, 2, 6] as const;

export interface DemoScenario extends ScriptedGameStateOptions {
  readonly moves: readonly number[];
}

function numbered(value: number): Disc {
  return makeDisc(value, DiscKind.Numbered);
}

/**
 * Builds the attract-loop demo scenario: three compact, independent setups on
 * one real Classic board.
 *
 * @remarks
 * Column 0 clears normally; column 2 reveals a cracked neighbor; columns 5–6
 * chain.
 */
export function createDemoScenario(): DemoScenario {
  const board = makeEmptyBoard(CLASSIC_RULES.board.cols, CLASSIC_RULES.board.rows);

  placeDisc(board, 5, 0, numbered(3));
  placeDisc(board, 6, 0, numbered(3));

  placeDisc(board, 5, 2, numbered(3));
  placeDisc(board, 6, 2, numbered(3));
  placeDisc(board, 6, 3, makeDisc(4, DiscKind.DoubleCracked));

  placeDisc(board, 4, 5, numbered(2));
  placeDisc(board, 5, 5, numbered(2));
  placeDisc(board, 6, 5, numbered(5));
  placeDisc(board, 6, 6, numbered(6));

  return {
    rules: CLASSIC_RULES,
    board,
    currentDisc: numbered(3),
    nextDisc: numbered(3),
    queuedDiscs: [numbered(2)],
    moves: DEMO_MOVES,
  };
}

/** Passive attract-mode playback backed by the production engine and renderer. */
export class DemoController {
  private readonly engine = new GameEngine({ rules: CLASSIC_RULES, seed: 0 });
  private readonly renderer: Renderer;
  private readonly stats = emptyStats();
  private readonly visibilityObserver: IntersectionObserver | null;
  private readonly reducedMotionQuery: MediaQueryList | null;
  private visualBoard = makeEmptyBoard(CLASSIC_RULES.board.cols, CLASSIC_RULES.board.rows);
  private animationQueue: AnimationQueue | null = null;
  private scorePopups: ScorePopup[] = [];
  private scenarioMoves: readonly number[] = [];
  private moveIndex = 0;
  private nextActionAt = 0;
  private activeTime = 0;
  private lastFrameTime: number | null = null;
  private frameId = 0;
  private isIntersecting = true;
  private reducedMotion = false;

  constructor(private readonly canvas: HTMLCanvasElement) {
    setGridSize(CLASSIC_RULES.board.cols, CLASSIC_RULES.board.rows);
    setHudBands(0, 0);
    this.renderer = new Renderer(canvas);

    this.reducedMotionQuery = typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)')
      : null;
    this.reducedMotion = this.reducedMotionQuery?.matches ?? false;
    this.reducedMotionQuery?.addEventListener('change', this.handleReducedMotionChange);
    document.addEventListener('visibilitychange', this.handleVisibilityChange);

    this.visibilityObserver = typeof IntersectionObserver === 'function'
      ? new IntersectionObserver(this.handleIntersection, { threshold: 0.01 })
      : null;
    this.visibilityObserver?.observe(canvas);

    this.resetScenario();
    if (!this.reducedMotion) this.syncPlayback();
  }

  handleResize(): void {
    this.renderer.resize();
    this.draw();
  }

  destroy(): void {
    cancelAnimationFrame(this.frameId);
    this.visibilityObserver?.disconnect();
    this.reducedMotionQuery?.removeEventListener('change', this.handleReducedMotionChange);
    document.removeEventListener('visibilitychange', this.handleVisibilityChange);
    setHudBands();
  }

  private readonly handleIntersection = (entries: IntersectionObserverEntry[]): void => {
    const entry = entries.at(-1);
    if (!entry) return;
    this.isIntersecting = entry.isIntersecting && entry.intersectionRatio > 0;
    this.syncPlayback();
  };

  private readonly handleVisibilityChange = (): void => {
    this.syncPlayback();
  };

  private readonly handleReducedMotionChange = (event: MediaQueryListEvent): void => {
    this.reducedMotion = event.matches;
    cancelAnimationFrame(this.frameId);
    this.frameId = 0;
    this.activeTime = 0;
    this.lastFrameTime = null;
    this.resetScenario();
    if (!this.reducedMotion) this.syncPlayback();
  };

  private isPlaybackVisible(): boolean {
    return document.visibilityState !== 'hidden' && this.isIntersecting;
  }

  private syncPlayback(): void {
    if (this.reducedMotion || !this.isPlaybackVisible()) {
      cancelAnimationFrame(this.frameId);
      this.frameId = 0;
      this.lastFrameTime = null;
      return;
    }
    if (this.frameId === 0) this.frameId = requestAnimationFrame(this.loop);
  }

  private resetScenario(): void {
    const scenario = createDemoScenario();
    this.engine.loadScriptedState(scenario);
    this.scenarioMoves = scenario.moves;
    this.visualBoard = deepCloneBoard(this.engine.state.board);
    this.animationQueue = null;
    this.scorePopups = [];
    this.moveIndex = 0;
    this.nextActionAt = this.activeTime + INITIAL_PAUSE_MS;
    this.draw();
  }

  private readonly loop = (now: DOMHighResTimeStamp): void => {
    this.frameId = 0;
    if (this.reducedMotion || !this.isPlaybackVisible()) {
      this.lastFrameTime = null;
      return;
    }

    if (this.lastFrameTime !== null) this.activeTime += now - this.lastFrameTime;
    this.lastFrameTime = now;
    this.scorePopups = tickScorePopups(this.scorePopups, this.activeTime);

    if (this.animationQueue) {
      this.animationQueue.tick(this.activeTime);
      if (this.animationQueue.isDone()) {
        this.animationQueue = null;
        this.nextActionAt = this.activeTime + (
          this.moveIndex < this.scenarioMoves.length ? BETWEEN_MOVES_MS : FINAL_PAUSE_MS
        );
      }
    } else if (this.activeTime >= this.nextActionAt) {
      if (this.moveIndex < this.scenarioMoves.length) this.playNextMove();
      else this.resetScenario();
    }

    this.draw();
    this.frameId = requestAnimationFrame(this.loop);
  };

  private playNextMove(): void {
    const lane = this.scenarioMoves[this.moveIndex];
    if (lane === undefined) return;
    const result = this.engine.drop(lane);
    if (!result.accepted) throw new Error(`Invalid deterministic demo move at index ${this.moveIndex}`);
    this.moveIndex++;
    this.beginPlayback(result);
  }

  private beginPlayback(result: TurnResult): void {
    this.visualBoard = result.boardBefore;
    this.animationQueue = new AnimationQueue(
      result.steps,
      (step, now) => {
        if (step.kind !== StepKind.Clear || step.cleared.length === 0) return;
        const perDisc = Math.floor(step.pointsAwarded / step.cleared.length);
        this.scorePopups.push(...spawnScorePopups(step.cleared, perDisc, now));
      },
      step => applyStepToVisualBoard(this.visualBoard, step),
      () => {},
    );
    this.animationQueue.tick(this.activeTime);
  }

  private draw(): void {
    // Hide the interactive cursor and ghost disc without mutating the engine's
    // authoritative phase. The engine must remain WaitingForDrop between
    // animations so the next scripted move is legal.
    const renderState = { ...this.engine.state, phase: GamePhase.Animating };
    this.renderer.draw(
      renderState,
      this.visualBoard,
      this.animationQueue?.getActiveAnimations() ?? [],
      this.stats,
      this.scorePopups,
      [],
    );
  }
}
