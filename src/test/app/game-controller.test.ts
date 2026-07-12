// @vitest-environment happy-dom
//
// Mocks the browser-facing shell (Renderer, AudioManager, InputHandler,
// HomeScreen, DebugPanel, AccountStatsStore) per game-controller-test-plan.md
// so Game can be driven deterministically without a real canvas/audio/DOM
// overlay. Game itself, GameEngine, AnimationQueue, and the tutorial
// definitions/evaluator all run for real — this is testing orchestration,
// not re-testing what each of those already covers in isolation.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const {
  rendererInstances, audioInstances, inputHandlerInstances,
  homeScreenInstances, debugPanelInstances, statsStoreInstances, saveStoreInstances, saveStoreState,
} = vi.hoisted(() => ({
  rendererInstances: [] as any[],
  audioInstances: [] as any[],
  inputHandlerInstances: [] as any[],
  homeScreenInstances: [] as any[],
  debugPanelInstances: [] as any[],
  statsStoreInstances: [] as any[],
  saveStoreInstances: [] as any[],
  saveStoreState: { current: null as any },
}));

vi.mock('../../ui/rendering/renderer.js', () => ({
  Renderer: class {
    resize = vi.fn();
    draw = vi.fn();
    constructor(_canvas: HTMLCanvasElement) {
      rendererInstances.push(this);
    }
  },
}));

vi.mock('../../platform/audio-manager.js', () => ({
  AudioManager: class {
    private enabled = true;
    isEnabled = vi.fn(() => this.enabled);
    toggleEnabled = vi.fn(() => { this.enabled = !this.enabled; return this.enabled; });
    playDrop = vi.fn();
    playPush = vi.fn();
    playClear = vi.fn();
    playReveal = vi.fn();
    playGameOver = vi.fn();
    constructor() {
      audioInstances.push(this);
    }
  },
}));

vi.mock('../../platform/input-handler.js', () => ({
  InputHandler: class {
    onIntent: (intent: unknown) => void;
    destroy = vi.fn();
    constructor(_canvas: unknown, onIntent: (intent: unknown) => void) {
      this.onIntent = onIntent;
      inputHandlerInstances.push(this);
    }
  },
}));

vi.mock('../../ui/home-screen.js', () => ({
  HomeScreen: class {
    onSelectMode: (mode: unknown) => void;
    onRequestGameMenu?: () => void;
    onRequestResume?: () => void;
    onRequestRestart?: () => void;
    onRequestHome?: () => void;
    onRequestToggleSound?: () => void;
    onRequestTutorial?: (mode: unknown) => void;
    onRequestResumeSavedGame?: () => void;
    open = vi.fn();
    close = vi.fn();
    openGameMenu = vi.fn();
    closeGameMenu = vi.fn();
    isGameMenuOpen = vi.fn(() => false);
    refreshStats = vi.fn();
    refreshAuth = vi.fn();
    setSoundEnabled = vi.fn();
    setSavedGame = vi.fn();
    constructor(_modes: unknown, onSelectMode: (mode: unknown) => void) {
      this.onSelectMode = onSelectMode;
      homeScreenInstances.push(this);
    }
  },
}));

vi.mock('../../platform/local-save-store.js', () => ({
  LocalSaveStore: class {
    read = vi.fn(() => saveStoreState.current);
    write = vi.fn((save: unknown) => { saveStoreState.current = save; });
    remove = vi.fn(() => { saveStoreState.current = null; });
    constructor(_modes: unknown) {
      saveStoreInstances.push(this);
    }
  },
}));

vi.mock('../../ui/debug/debug-panel.js', () => ({
  DebugPanel: class {
    reset = vi.fn();
    recordTurn = vi.fn();
    advancePlayback = vi.fn();
    refresh = vi.fn();
    constructor(_state: unknown) {
      debugPanelInstances.push(this);
    }
  },
}));

vi.mock('../../platform/account-stats-store.js', () => ({
  AccountStatsStore: class {
    loadStats = vi.fn(() => ({ highScore: 0, longestStreak: 0, averageScore: 0, gamesPlayed: 0, totalScore: 0 }));
    subscribe = vi.fn(() => vi.fn());
    getState = vi.fn(() => ({ account: null, identities: [], loading: false, apiAvailable: true }));
    login = vi.fn();
    logout = vi.fn(async () => {});
    saveStats = vi.fn();
    recordCompletedGame = vi.fn();
    constructor(_modes: unknown) {
      statsStoreInstances.push(this);
    }
  },
}));

// Imported after the mocks above so Game picks up the mocked modules.
import { Game } from '../../app/game-controller.js';
import { GamePhase } from '../../game/state.js';
import type { Board } from '../../game/model.js';
import { DiscKind } from '../../game/model.js';
import { makeDisc } from '../../game/disc.js';
import { CLASSIC_MODE, GRAVITY_MODE, STACK_MODE } from '../../game/modes/index.js';
import { CLASSIC_TUTORIAL, GRAVITY_TUTORIAL } from '../../app/tutorial.js';
import { StepKind } from '../../game/events.js';
import { GameEngine } from '../../game/engine.js';

// Untyped deliberately: every caller passes an array of mock instances or
// mock.calls tuples, both of which are convenience-typed `any` throughout
// this file — generic inference over an `any[]` argument doesn't reliably
// propagate `any` back out, so the plain form avoids spurious 'unknown' errors.
function lastOf(arr: readonly any[]): any {
  const item = arr[arr.length - 1];
  if (!item) throw new Error('expected at least one instance to have been constructed');
  return item;
}

function isEmptyBoard(board: Board): boolean {
  return board.every(row => row.every(cell => cell === null));
}

// draw()'s positional signature is awkward to destructure inline
// (especially to reach the trailing tutorial/previewLanding args) — pull out
// just the args a given test cares about, by name, off the most recent call.
function lastDraw(renderer: any): { state: any; board: Board; tutorial: { allowedCols: readonly number[] } | null } {
  const call = lastOf(renderer.draw.mock.calls);
  return { state: call[0], board: call[1], tutorial: call[6] };
}

let rafCallback: FrameRequestCallback | null = null;

beforeEach(() => {
  document.body.replaceChildren();
  rendererInstances.length = 0;
  audioInstances.length = 0;
  inputHandlerInstances.length = 0;
  homeScreenInstances.length = 0;
  debugPanelInstances.length = 0;
  statsStoreInstances.length = 0;
  saveStoreInstances.length = 0;
  saveStoreState.current = null;
  rafCallback = null;
  vi.stubGlobal('requestAnimationFrame', vi.fn((cb: FrameRequestCallback) => { rafCallback = cb; return 1; }));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  // debugSeedOverride() reads window.location.search for a deterministic
  // disc sequence (same ?seed= hook the E2E suite uses) — seed 1's first
  // several Classic values are 6,7,3,4,5,... (verified headlessly elsewhere
  // in this repo), which is enough to keep single-drop tests clear-free.
  Object.defineProperty(window, 'location', {
    value: { search: '?seed=1' },
    writable: true,
    configurable: true,
  });
});

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

// The animation queue only advances one step per tick() call when a step
// transition happens (advance() starts the next step's animations but does
// not itself re-process them within the same call) — so draining a queue of
// unknown length needs repeated, well-spaced ticks, not one big jump.
function drainAnimations(maxFrames = 30): void {
  let now = 0;
  for (let i = 0; i < maxFrames; i++) {
    now += 1000;
    frame(now);
  }
}

function frame(now = 0): void {
  rafCallback?.(now);
}

function createGame(): { game: Game; canvas: HTMLCanvasElement } {
  const canvas = document.createElement('canvas');
  const game = new Game(canvas);
  return { game, canvas };
}

// ─── Constructor / home state ───────────────────────────────────────────────

describe('constructor / home state', () => {
  test('opens the home screen and starts in Menu phase', () => {
    createGame();
    const homeScreen = lastOf(homeScreenInstances);
    expect(homeScreen.open).toHaveBeenCalledTimes(1);

    frame(0);
    const renderer = lastOf(rendererInstances);
    const [state] = lastOf(renderer.draw.mock.calls);
    expect(state.phase).toBe(GamePhase.Menu);
  });

  test('constructs exactly one InputHandler wired to the canvas', () => {
    createGame();
    expect(inputHandlerInstances).toHaveLength(1);
  });

  test('destroy cancels the rAF loop and destroys the input handler', () => {
    const { game } = createGame();
    const input = lastOf(inputHandlerInstances);

    game.destroy();

    expect(vi.mocked(cancelAnimationFrame)).toHaveBeenCalledTimes(1);
    expect(input.destroy).toHaveBeenCalledTimes(1);
  });
});

// ─── Starting normal play ───────────────────────────────────────────────────

describe('starting normal play', () => {
  test('selecting Classic closes home, resizes the renderer, resets debug, and reaches an empty WaitingForDrop board', () => {
    createGame();
    const homeScreen = lastOf(homeScreenInstances);
    const renderer = lastOf(rendererInstances);
    const debugPanel = lastOf(debugPanelInstances);

    homeScreen.onSelectMode(CLASSIC_MODE);

    expect(homeScreen.close).toHaveBeenCalledTimes(1);
    expect(renderer.resize).toHaveBeenCalled();
    expect(debugPanel.reset).toHaveBeenCalledTimes(1);

    frame(0);
    const [state, board] = lastOf(renderer.draw.mock.calls);
    expect(state.phase).toBe(GamePhase.WaitingForDrop);
    expect(isEmptyBoard(board)).toBe(true);
    expect(lastOf(saveStoreInstances).remove).toHaveBeenCalledTimes(1);
  });
});

// ─── DOM controls ───────────────────────────────────────────────────────────

describe('DOM controls', () => {
  test('Gravity tilt buttons drive the Game intent path into Aiming', () => {
    createGame();
    const homeScreen = lastOf(homeScreenInstances);
    const renderer = lastOf(rendererInstances);

    homeScreen.onSelectMode(GRAVITY_MODE);
    frame(0);

    document.querySelector<HTMLButtonElement>('[data-control="tilt-clockwise"]')!.click();
    frame(16);

    const { state } = lastDraw(renderer);
    expect(state.phase).toBe(GamePhase.Aiming);
    expect(state.gravity!.angle).toBe(5);
  });
});

// ─── Normal drop flow ───────────────────────────────────────────────────────

describe('normal drop flow', () => {
  test('autosaves the stable post-turn state before animation completion', () => {
    createGame();
    const homeScreen = lastOf(homeScreenInstances);
    const saveStore = lastOf(saveStoreInstances);
    homeScreen.onSelectMode(CLASSIC_MODE);
    saveStore.write.mockClear();

    lastOf(inputHandlerInstances).onIntent({ kind: 'drop', col: 3 });

    expect(saveStore.write).toHaveBeenCalledTimes(1);
    const save = saveStore.write.mock.calls[0]![0];
    expect(save.state.phase).toBe('waiting');
    expect(save.state.dropCount).toBe(1);
    frame(0);
    expect(lastDraw(lastOf(rendererInstances)).state.phase).toBe(GamePhase.Animating);
  });

  test('an accepted drop enters Animating, plays the drop sound, records the turn, then returns to WaitingForDrop', () => {
    createGame();
    const homeScreen = lastOf(homeScreenInstances);
    homeScreen.onSelectMode(CLASSIC_MODE);
    frame(0);

    const input = lastOf(inputHandlerInstances);
    const audio = lastOf(audioInstances);
    const debugPanel = lastOf(debugPanelInstances);
    const renderer = lastOf(rendererInstances);

    input.onIntent({ kind: 'drop', col: 3 });

    frame(0);
    const [stateAfterDrop] = lastOf(renderer.draw.mock.calls);
    expect(stateAfterDrop.phase).toBe(GamePhase.Animating);
    expect(audio.playDrop).toHaveBeenCalledTimes(1);
    expect(debugPanel.recordTurn).toHaveBeenCalledTimes(1);

    drainAnimations();
    const [stateAfterAnimation] = lastOf(renderer.draw.mock.calls);
    expect(stateAfterAnimation.phase).toBe(GamePhase.WaitingForDrop);
  });

  test('Stack shows each counted disc its share of the final stack award', () => {
    const { game } = createGame();
    const homeScreen = lastOf(homeScreenInstances);
    homeScreen.onSelectMode(STACK_MODE);

    const controller = game as unknown as {
      handleStepStart: (step: unknown, now: number) => void;
      stackCascadeActive: boolean;
      scorePopups: Array<{ value: number; row: number; col: number }>;
    };
    controller.stackCascadeActive = true;
    controller.handleStepStart({
      kind: StepKind.Clear,
      cleared: [{ row: 6, col: 1 }, { row: 5, col: 1 }, { row: 6, col: 2 }],
      discs: [],
      chainLevel: 0,
      pointsAwarded: 0,
    }, 100);

    expect(controller.scorePopups).toEqual([
      expect.objectContaining({ value: 30, row: 6, col: 1 }),
      expect.objectContaining({ value: 30, row: 5, col: 1 }),
      expect.objectContaining({ value: 30, row: 6, col: 2 }),
    ]);

    controller.handleStepStart({ kind: StepKind.Bonus, bonusKind: 'stack', pointsAwarded: 90 }, 700);
    expect(controller.scorePopups).toHaveLength(3);
  });
});

// ─── Game over during the final turn's animation ───────────────────────────
// Regression: AnimationQueue's onComplete callback can call setGameOver()
// SYNCHRONOUSLY from inside tick() — whenever the turn that just finished
// animating also ended the game — and setGameOver() nulls this.animQueue.
// loop() used to call this.animQueue.isDone() unconditionally right after
// tick() returned, assuming animQueue was still the same non-null queue;
// when tick() had already nulled it via onComplete, that threw "Cannot read
// properties of null (reading 'isDone')" — which broke the rAF loop
// permanently, since a throwing frame callback never reschedules itself.
// Found live while testing the Gravity mode push-direction feature (a push
// overflow is one path to this), but the bug itself is unrelated to that
// feature — any accepted, game-ending turn with at least one animation step
// hits it.
describe('game over during the final turn\'s animation', () => {
  test('a drop that fills the last empty cell ends the game without the render loop throwing', () => {
    const { game } = createGame();
    const homeScreen = lastOf(homeScreenInstances);
    homeScreen.onSelectMode(CLASSIC_MODE);
    frame(0);

    const engine = (game as unknown as {
      engine: { state: { board: Board; currentDisc: ReturnType<typeof makeDisc> } };
    }).engine;
    // Fill every cell except (row 0, col 0) with discs that never auto-clear,
    // so a single drop into column 0 (landing at row 0, since rows 1-6 are
    // already full) is the one thing that completes the board.
    for (let r = 0; r < 7; r++) {
      for (let c = 0; c < 7; c++) {
        if (r === 0 && c === 0) continue;
        engine.state.board[r]![c] = makeDisc(1, DiscKind.DoubleCracked);
      }
    }
    engine.state.currentDisc = makeDisc(1, DiscKind.DoubleCracked);

    const input = lastOf(inputHandlerInstances);
    input.onIntent({ kind: 'drop', col: 0 });
    frame(0);

    expect(() => drainAnimations()).not.toThrow();

    const renderer = lastOf(rendererInstances);
    const [state] = lastOf(renderer.draw.mock.calls);
    expect(state.phase).toBe(GamePhase.GameOver);
    expect(lastOf(saveStoreInstances).remove).toHaveBeenCalled();
  });
});

// ─── Tutorial start ─────────────────────────────────────────────────────────

describe('tutorial start', () => {
  test('requesting the Classic tutorial shows step 0 with the scripted board and allowed column', () => {
    createGame();
    const homeScreen = lastOf(homeScreenInstances);
    const renderer = lastOf(rendererInstances);

    homeScreen.onRequestTutorial?.(CLASSIC_MODE);
    frame(0);

    const { state, tutorial } = lastDraw(renderer);
    const firstStep = CLASSIC_TUTORIAL.steps[0]!;
    expect(state.cursorCol).toBe(firstStep.allowedCols[0]);
    expect(state.currentDisc.value).toBe(firstStep.currentDisc.value);
    expect(tutorial).toEqual({ allowedCols: firstStep.allowedCols });
  });
});

// ─── Wrong tutorial column ──────────────────────────────────────────────────

describe('wrong tutorial column', () => {
  test('dropping in a non-allowed column does not start a turn or advance the step', () => {
    createGame();
    const homeScreen = lastOf(homeScreenInstances);
    homeScreen.onRequestTutorial?.(CLASSIC_MODE);
    frame(0);

    const input = lastOf(inputHandlerInstances);
    const renderer = lastOf(rendererInstances);
    const firstStep = CLASSIC_TUTORIAL.steps[0]!;
    const disallowedCol = [0, 1, 2, 3, 4, 5, 6].find(c => !firstStep.allowedCols.includes(c))!;

    input.onIntent({ kind: 'drop', col: disallowedCol });
    frame(0);

    const [state] = lastOf(renderer.draw.mock.calls);
    // No turn started (still WaitingForDrop, not Animating) and the cursor
    // snapped back to an allowed column instead of sitting on the rejected one.
    expect(state.phase).toBe(GamePhase.WaitingForDrop);
    expect(state.cursorCol).toBe(firstStep.allowedCols[0]);
  });
});

// ─── Tutorial progression ───────────────────────────────────────────────────

describe('tutorial progression', () => {
  test('completing step 0 loads step 1 with its own board and allowed column', () => {
    createGame();
    const homeScreen = lastOf(homeScreenInstances);
    homeScreen.onRequestTutorial?.(CLASSIC_MODE);
    frame(0);

    const input = lastOf(inputHandlerInstances);
    const renderer = lastOf(rendererInstances);
    const firstStep = CLASSIC_TUTORIAL.steps[0]!;

    input.onIntent({ kind: 'drop', col: firstStep.allowedCols[0] });
    drainAnimations();

    const secondStep = CLASSIC_TUTORIAL.steps[1]!;
    const [state] = lastOf(renderer.draw.mock.calls);
    expect(state.cursorCol).toBe(secondStep.allowedCols[0]);
    expect(state.currentDisc.value).toBe(secondStep.currentDisc.value);
  });
});

// ─── Tutorial completion handoff ────────────────────────────────────────────

describe('tutorial completion handoff', () => {
  test('completing every step resets score, exits the tutorial, and hands off to regular seeded play', () => {
    createGame();
    const homeScreen = lastOf(homeScreenInstances);
    homeScreen.onRequestTutorial?.(CLASSIC_MODE);
    frame(0);

    const input = lastOf(inputHandlerInstances);
    const renderer = lastOf(rendererInstances);

    for (const step of CLASSIC_TUTORIAL.steps) {
      input.onIntent({ kind: 'drop', col: step.allowedCols[0] });
      drainAnimations();
    }

    const { state, tutorial } = lastDraw(renderer);
    expect(state.phase).toBe(GamePhase.WaitingForDrop);
    expect(state.score).toBe(0);
    // No longer scripted: this protects the past bug where post-tutorial play
    // kept dealing the tutorial's fixed disc sequence forever. The scripted
    // sequence always deals more 3s past its own last step; seeded Classic
    // generation from a resumed real random stream should not.
    expect(state.generationSource).toBe('seeded');
    // Tutorial visual state (the "allowedCols" highlight) is gone now that
    // play has handed off — draw() receives null for it.
    expect(tutorial).toBeNull();
  });
});

// ─── Restart behavior ───────────────────────────────────────────────────────

describe('restart', () => {
  test('during a tutorial, restart reloads the current step rather than starting a normal game', () => {
    createGame();
    const homeScreen = lastOf(homeScreenInstances);
    homeScreen.onRequestTutorial?.(CLASSIC_MODE);
    frame(0);

    const input = lastOf(inputHandlerInstances);
    const renderer = lastOf(rendererInstances);
    const firstStep = CLASSIC_TUTORIAL.steps[0]!;

    // Move away from the tutorial's starting cursor, then restart.
    input.onIntent({ kind: 'move', col: 6 });
    input.onIntent({ kind: 'restart' });
    frame(0);

    const [state] = lastOf(renderer.draw.mock.calls);
    expect(state.cursorCol).toBe(firstStep.allowedCols[0]);
    expect(state.dropCount).toBe(0);
  });

  test('during normal play, restart starts a fresh game with an empty board and zeroed score', () => {
    createGame();
    const homeScreen = lastOf(homeScreenInstances);
    homeScreen.onSelectMode(CLASSIC_MODE);
    frame(0);

    const input = lastOf(inputHandlerInstances);
    const renderer = lastOf(rendererInstances);

    input.onIntent({ kind: 'drop', col: 3 });
    drainAnimations();
    input.onIntent({ kind: 'restart' });
    frame(0);

    const [state, board] = lastOf(renderer.draw.mock.calls);
    expect(state.score).toBe(0);
    expect(state.dropCount).toBe(0);
    expect(isEmptyBoard(board)).toBe(true);
    expect(lastOf(saveStoreInstances).remove).toHaveBeenCalled();
  });
});

describe('saved game resume', () => {
  test('advertises a valid save and restores its mode, engine state, streak, and clean presentation', () => {
    const source = new GameEngine({ mode: STACK_MODE, seed: 91 });
    source.drop(2);
    const save = source.exportSave({ longestStreak: 7, savedAt: 123 });
    saveStoreState.current = save;

    const { game } = createGame();
    const homeScreen = lastOf(homeScreenInstances);
    expect(homeScreen.setSavedGame).toHaveBeenCalledWith({ modeName: STACK_MODE.name, score: save.state.score });

    homeScreen.onRequestResumeSavedGame?.();
    frame(0);

    const renderer = lastOf(rendererInstances);
    const call = lastOf(renderer.draw.mock.calls);
    expect(call[0]).toMatchObject({
      phase: GamePhase.WaitingForDrop,
      score: save.state.score,
      dropCount: save.state.dropCount,
      level: save.state.level,
    });
    expect(call[1]).toEqual(call[0].board);
    expect(call[2]).toEqual([]);
    expect(call[4]).toEqual([]);
    expect(call[5]).toEqual([]);
    expect(call[8]).toBe(true);
    expect((game as unknown as { longestStreakThisGame: number }).longestStreakThisGame).toBe(7);
    expect(homeScreen.close).toHaveBeenCalled();
  });

  test('missing save hides the action and safely leaves the home screen open', () => {
    createGame();
    const homeScreen = lastOf(homeScreenInstances);
    homeScreen.setSavedGame.mockClear();

    homeScreen.onRequestResumeSavedGame?.();

    expect(homeScreen.setSavedGame).toHaveBeenCalledWith(null);
    expect(homeScreen.close).not.toHaveBeenCalled();
  });
});

// ─── Gravity tutorial ───────────────────────────────────────────────────────
// Mirrors the Classic tutorial coverage above end-to-end through the same
// public Game API (home screen -> input intents -> renderer draws), but for
// GRAVITY_TUTORIAL specifically — its two tilt-only steps (empty allowedCols)
// are driven with 'tilt' + 'drop' (confirm) intents instead of a plain drop,
// and its pre-tilted step (gravityAngleDeg) needs state.gravity to actually
// reflect that tilt on load, which is the loadScriptedState gap this whole
// feature fixed.

describe('gravity tutorial', () => {
  test('requesting the Gravity tutorial (not Classic) loads GRAVITY_TUTORIAL, not CLASSIC_TUTORIAL', () => {
    createGame();
    const homeScreen = lastOf(homeScreenInstances);
    const renderer = lastOf(rendererInstances);

    homeScreen.onRequestTutorial?.(GRAVITY_MODE);
    frame(0);

    const { state, tutorial } = lastDraw(renderer);
    const firstStep = GRAVITY_TUTORIAL.steps[0]!;
    expect(state.cursorCol).toBe(firstStep.allowedCols[0]);
    expect(state.currentDisc.value).toBe(firstStep.currentDisc.value);
    expect(tutorial).toEqual({ allowedCols: firstStep.allowedCols });
    // Gravity state must actually exist for a Gravity-mode tutorial step —
    // this used to silently stay undefined (loadScriptedState never
    // re-derived it), which would break every tilt-only step below.
    expect(state.gravity).toBeDefined();
    expect(state.gravity!.angle).toBe(0);
  });

  test('a pre-tilted step (gravityAngleDeg) actually reflects that angle in state.gravity on load', () => {
    createGame();
    const homeScreen = lastOf(homeScreenInstances);
    const renderer = lastOf(rendererInstances);
    const input = lastOf(inputHandlerInstances);

    homeScreen.onRequestTutorial?.(GRAVITY_MODE);
    frame(0);

    // Step 0 and 1 are drop/tilt (see below); advance to step 2 (tilt-only,
    // 45deg reveal), then step 3, which is the pre-tilted one.
    input.onIntent({ kind: 'drop', col: GRAVITY_TUTORIAL.steps[0]!.allowedCols[0] });
    drainAnimations();
    input.onIntent({ kind: 'tilt', delta: 45 });
    input.onIntent({ kind: 'drop', col: 0 }); // confirm — same physical action as drop while Aiming
    drainAnimations();
    input.onIntent({ kind: 'tilt', delta: 45 });
    input.onIntent({ kind: 'drop', col: 0 });
    drainAnimations();

    const { state } = lastDraw(renderer);
    expect(state.gravity!.angle).toBe(GRAVITY_TUTORIAL.steps[3]!.gravityAngleDeg);
  });

  test('completing all four steps (two drops, two tilt-confirms) hands off to Gravity mode, not Classic', () => {
    createGame();
    const homeScreen = lastOf(homeScreenInstances);
    const renderer = lastOf(rendererInstances);
    const input = lastOf(inputHandlerInstances);

    homeScreen.onRequestTutorial?.(GRAVITY_MODE);
    frame(0);

    for (const step of GRAVITY_TUTORIAL.steps) {
      if (step.allowedCols.length > 0) {
        input.onIntent({ kind: 'drop', col: step.allowedCols[0] });
      } else {
        input.onIntent({ kind: 'tilt', delta: 45 });
        input.onIntent({ kind: 'drop', col: 0 }); // confirm
      }
      drainAnimations();
    }

    const { state, tutorial } = lastDraw(renderer);
    expect(state.phase).toBe(GamePhase.WaitingForDrop);
    expect(state.score).toBe(0);
    expect(state.generationSource).toBe('seeded');
    expect(state.gravity).toBeDefined(); // still a gravity mode after handoff, not reset to Classic
    expect(tutorial).toBeNull();
  });
});
