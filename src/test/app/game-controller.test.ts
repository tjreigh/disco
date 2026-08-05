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
  homeScreenInstances, debugPanelInstances, statsStoreInstances, saveStoreInstances,
  savedGameDialogInstances, saveStoreState,
} = vi.hoisted(() => ({
  rendererInstances: [] as any[],
  audioInstances: [] as any[],
  inputHandlerInstances: [] as any[],
  homeScreenInstances: [] as any[],
  debugPanelInstances: [] as any[],
  statsStoreInstances: [] as any[],
  saveStoreInstances: [] as any[],
  savedGameDialogInstances: [] as any[],
  saveStoreState: {
    byMode: new Map<string, any>(),
    conflicts: new Map<string, any>(),
  },
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
    onRequestToggleAdvancedHud?: () => void;
    onRequestDebug?: () => void;
    onRequestTutorial?: (mode: unknown) => void;
    open = vi.fn();
    close = vi.fn();
    openGameMenu = vi.fn();
    closeGameMenu = vi.fn();
    isGameMenuOpen = vi.fn(() => false);
    refreshStats = vi.fn();
    refreshAuth = vi.fn();
    setSoundEnabled = vi.fn();
    setAdvancedHudEnabled = vi.fn();
    setSaveLoading = vi.fn();
    setSaveExitPending = vi.fn();
    constructor(_modes: unknown, onSelectMode: (mode: unknown) => void) {
      this.onSelectMode = onSelectMode;
      homeScreenInstances.push(this);
    }
  },
}));

vi.mock('../../platform/synced-save-store.js', () => ({
  SyncedSaveStore: class {
    ready = Promise.resolve();
    getState = vi.fn(() => ({ account: null, accountId: null, scope: 'guest', loading: false, apiAvailable: true }));
    read = vi.fn((modeId: string) => saveStoreState.byMode.get(modeId) ?? null);
    write = vi.fn((modeId: string, save: unknown) => { saveStoreState.byMode.set(modeId, save); });
    remove = vi.fn((modeId: string) => { saveStoreState.byMode.delete(modeId); });
    getConflict = vi.fn((modeId: string) => saveStoreState.conflicts.get(modeId) ?? null);
    resolveConflict = vi.fn((modeId: string, resolution: string) => {
      const conflict = saveStoreState.conflicts.get(modeId);
      if (resolution === 'local' && conflict?.local) saveStoreState.byMode.set(modeId, conflict.local);
      else if (resolution === 'cloud' && conflict?.cloud) saveStoreState.byMode.set(modeId, conflict.cloud);
      else if (resolution === 'new') saveStoreState.byMode.delete(modeId);
      saveStoreState.conflicts.delete(modeId);
    });
    subscribe = vi.fn(() => vi.fn());
    setAuthState = vi.fn(async () => undefined);
    sync = vi.fn(async () => true);
    refreshSaves = vi.fn(async () => undefined);
    constructor(_modes: unknown) {
      saveStoreInstances.push(this);
    }
  },
}));

vi.mock('../../ui/saved-game-dialog.js', () => ({
  SavedGameDialog: class {
    onResume?: (save: unknown) => void;
    onStartNew?: () => void;
    onChooseLocal?: (save: unknown) => void;
    onChooseCloud?: (save: unknown) => void;
    onCancel?: () => void;
    showSave = vi.fn();
    showConflict = vi.fn();
    showUnavailable = vi.fn();
    hide = vi.fn();
    isOpen = vi.fn(() => false);
    constructor() {
      savedGameDialogInstances.push(this);
    }
  },
}));

vi.mock('../../ui/debug/debug-panel.js', () => ({
  DebugPanel: class {
    onForceGameOver?: () => void;
    canForceGameOver?: () => boolean;
    open = vi.fn();
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
    loadStats = vi.fn(() => ({
      highScore: 0, longestStreak: 0, averageScore: 0, gamesPlayed: 0, totalScore: 0,
      totalPlayTimeMs: 0, totalDiscsDropped: 0, totalDiscsBroken: 0,
    }));
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
import { CLASSIC_MODE, GRAVITY_MODE, PARADOX_MODE, STACK_MODE } from '../../game/modes/index.js';
import { CLASSIC_TUTORIAL, GRAVITY_TUTORIAL } from '../../app/tutorial.js';
import { StepKind } from '../../game/events.js';
import { GameEngine } from '../../game/engine.js';
import { USER_SETTINGS_STORAGE_KEY } from '../../platform/user-settings-store.js';

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
function lastDraw(renderer: any): {
  state: any;
  board: Board;
  tutorial: { allowedCols: readonly number[]; staged: boolean; needsTilt: boolean } | null;
} {
  const call = lastOf(renderer.draw.mock.calls);
  return { state: call[0], board: call[1], tutorial: call[6] };
}

let rafCallback: FrameRequestCallback | null = null;
const gameInstances: Game[] = [];

beforeEach(() => {
  document.body.replaceChildren();
  rendererInstances.length = 0;
  audioInstances.length = 0;
  inputHandlerInstances.length = 0;
  homeScreenInstances.length = 0;
  debugPanelInstances.length = 0;
  statsStoreInstances.length = 0;
  saveStoreInstances.length = 0;
  savedGameDialogInstances.length = 0;
  saveStoreState.byMode.clear();
  saveStoreState.conflicts.clear();
  window.localStorage.removeItem(USER_SETTINGS_STORAGE_KEY);
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
  for (const game of gameInstances) game.destroy();
  gameInstances.length = 0;
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
  gameInstances.push(game);
  return { game, canvas };
}

function boardSession(game: Game): any {
  return (game as any).solo.session;
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

  test('opens report/debug from home and dismisses the game menu first when needed', () => {
    createGame();
    const homeScreen = lastOf(homeScreenInstances);
    const debugPanel = lastOf(debugPanelInstances);

    homeScreen.onRequestDebug?.();
    expect(debugPanel.open).toHaveBeenCalledOnce();

    homeScreen.isGameMenuOpen.mockReturnValue(true);
    homeScreen.onRequestDebug?.();
    expect(homeScreen.closeGameMenu).toHaveBeenCalledOnce();
    expect(debugPanel.open).toHaveBeenCalledTimes(2);
  });

  test('allows the full debugger to force an active run through normal game over', () => {
    const { game } = createGame();
    const homeScreen = lastOf(homeScreenInstances);
    const debugPanel = lastOf(debugPanelInstances);

    expect(debugPanel.canForceGameOver()).toBe(false);
    homeScreen.onSelectMode(CLASSIC_MODE);
    expect(debugPanel.canForceGameOver()).toBe(true);

    debugPanel.onForceGameOver();

    expect(boardSession(game).state.phase).toBe(GamePhase.GameOver);
    expect(debugPanel.canForceGameOver()).toBe(false);
    expect(lastOf(statsStoreInstances).recordCompletedGame).toHaveBeenCalledOnce();
    expect(document.querySelector('.game-over-screen--open')).not.toBeNull();
  });

  test('destroy cancels the rAF loop and destroys the input handler', () => {
    const { game } = createGame();
    const input = lastOf(inputHandlerInstances);

    game.destroy();

    expect(vi.mocked(cancelAnimationFrame)).toHaveBeenCalledTimes(1);
    expect(input.destroy).toHaveBeenCalledTimes(1);
  });

  test('refreshes account saves when the home screen regains focus', () => {
    createGame();
    const saveStore = lastOf(saveStoreInstances);
    saveStore.getState.mockReturnValue({
      account: { id: 'account-1', displayName: null },
      accountId: 'account-1',
      scope: 'account',
      loading: false,
      apiAvailable: true,
    });

    window.dispatchEvent(new Event('focus'));

    expect(saveStore.refreshSaves).toHaveBeenCalledOnce();
  });

  test('refreshes an already-open resume choice after returning to the app', async () => {
    createGame();
    const saveStore = lastOf(saveStoreInstances);
    const savedGameDialog = lastOf(savedGameDialogInstances);
    const oldSave = new GameEngine({ rules: CLASSIC_MODE.rules, seed: 40 }).exportSave({ savedAt: 40 });
    const newSave = new GameEngine({ rules: CLASSIC_MODE.rules, seed: 41 }).exportSave({ savedAt: 41 });
    saveStoreState.byMode.set(CLASSIC_MODE.id, oldSave);
    lastOf(homeScreenInstances).onSelectMode(CLASSIC_MODE);
    savedGameDialog.showSave.mockClear();
    savedGameDialog.isOpen.mockReturnValue(true);
    saveStore.refreshSaves.mockImplementation(async () => {
      saveStoreState.byMode.set(CLASSIC_MODE.id, newSave);
    });

    window.dispatchEvent(new Event('focus'));

    await vi.waitFor(() => expect(savedGameDialog.showSave).toHaveBeenCalledWith(CLASSIC_MODE, newSave));
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
    expect(lastOf(saveStoreInstances).remove).not.toHaveBeenCalled();
  });

  test('refreshes account saves before presenting the resume choice', async () => {
    createGame();
    const homeScreen = lastOf(homeScreenInstances);
    const saveStore = lastOf(saveStoreInstances);
    const savedGameDialog = lastOf(savedGameDialogInstances);
    let finishRefresh!: () => void;
    saveStore.getState.mockReturnValue({
      account: { id: 'account-1', displayName: null },
      accountId: 'account-1',
      scope: 'account',
      loading: false,
      apiAvailable: true,
    });
    saveStore.refreshSaves.mockImplementation(() => new Promise<void>(resolve => { finishRefresh = resolve; }));

    homeScreen.onSelectMode(CLASSIC_MODE);
    expect(savedGameDialog.showSave).not.toHaveBeenCalled();

    const source = new GameEngine({ rules: CLASSIC_MODE.rules, seed: 44 });
    saveStoreState.byMode.set(CLASSIC_MODE.id, source.exportSave({ savedAt: 44 }));
    finishRefresh();

    await vi.waitFor(() => expect(savedGameDialog.showSave).toHaveBeenCalledOnce());
  });
});

describe('save and exit', () => {
  test('waits for the current mode sync before returning home', async () => {
    createGame();
    const homeScreen = lastOf(homeScreenInstances);
    const saveStore = lastOf(saveStoreInstances);
    let finishSync!: (synced: boolean) => void;
    saveStore.sync.mockImplementation(() => new Promise<boolean>(resolve => { finishSync = resolve; }));
    homeScreen.onSelectMode(CLASSIC_MODE);
    homeScreen.open.mockClear();

    homeScreen.onRequestHome?.();

    expect(saveStore.sync).toHaveBeenCalledWith(CLASSIC_MODE.id);
    expect(homeScreen.setSaveExitPending).toHaveBeenCalledWith(true);
    expect(homeScreen.open).not.toHaveBeenCalled();

    finishSync(true);

    await vi.waitFor(() => expect(homeScreen.open).toHaveBeenCalledOnce());
    expect(homeScreen.setSaveExitPending).toHaveBeenLastCalledWith(false);
  });

  test('returns home after a bounded wait when cloud sync does not settle', async () => {
    vi.useFakeTimers();
    try {
      createGame();
      const homeScreen = lastOf(homeScreenInstances);
      const saveStore = lastOf(saveStoreInstances);
      saveStore.sync.mockImplementation(() => new Promise<boolean>(() => {}));
      homeScreen.onSelectMode(CLASSIC_MODE);
      homeScreen.open.mockClear();

      homeScreen.onRequestHome?.();
      await vi.advanceTimersByTimeAsync(5_000);

      expect(homeScreen.open).toHaveBeenCalledOnce();
      expect(homeScreen.setSaveExitPending).toHaveBeenLastCalledWith(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ─── DOM controls ───────────────────────────────────────────────────────────

describe('DOM controls', () => {
  test('Gravity stages a lane before its tilt buttons adjust the pending drop', () => {
    createGame();
    const homeScreen = lastOf(homeScreenInstances);
    const renderer = lastOf(rendererInstances);

    homeScreen.onSelectMode(GRAVITY_MODE);
    frame(0);

    document.querySelector<HTMLButtonElement>('[data-control="drop"]')!.click();
    frame(16);
    document.querySelector<HTMLButtonElement>('[data-control="tilt-clockwise"]')!.click();
    frame(16);

    const { state } = lastDraw(renderer);
    expect(state.phase).toBe(GamePhase.Aiming);
    expect(state.gravity!.angle).toBe(45);
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
    expect(saveStore.write.mock.calls[0]![0]).toBe(CLASSIC_MODE.id);
    const save = saveStore.write.mock.calls[0]![1];
    expect(save.state.phase).toBe('waiting');
    expect(save.state.dropCount).toBe(1);
    frame(0);
    expect(lastDraw(lastOf(rendererInstances)).state.phase).toBe(GamePhase.Animating);
  });

  test('does not autosave tutorial turns or replace a committed save while Gravity is only Aiming', () => {
    saveStoreState.byMode.set(CLASSIC_MODE.id, { marker: 'previous committed turn' });
    createGame();
    const homeScreen = lastOf(homeScreenInstances);
    const saveStore = lastOf(saveStoreInstances);
    homeScreen.onRequestTutorial?.(CLASSIC_MODE);
    saveStore.write.mockClear();
    lastOf(inputHandlerInstances).onIntent({ kind: 'drop', col: CLASSIC_TUTORIAL.steps[0]!.allowedCols[0] });
    expect(saveStore.write).not.toHaveBeenCalled();

    homeScreen.onSelectMode(GRAVITY_MODE);
    saveStoreState.byMode.set(GRAVITY_MODE.id, { marker: 'gravity committed turn' });
    saveStore.write.mockClear();
    lastOf(inputHandlerInstances).onIntent({ kind: 'drop', col: 3 });
    expect(saveStore.write).not.toHaveBeenCalled();
    expect(saveStoreState.byMode.get(GRAVITY_MODE.id)).toEqual({ marker: 'gravity committed turn' });
  });

  test('an accepted drop enters Animating, plays the drop sound, records the turn, then returns to WaitingForDrop', () => {
    const { game } = createGame();
    const homeScreen = lastOf(homeScreenInstances);
    homeScreen.onRequestToggleAdvancedHud?.();
    homeScreen.onSelectMode(CLASSIC_MODE);
    frame(0);

    const input = lastOf(inputHandlerInstances);
    const audio = lastOf(audioInstances);
    const debugPanel = lastOf(debugPanelInstances);
    const renderer = lastOf(rendererInstances);

    input.onIntent({ kind: 'drop', col: 3 });
    expect(boardSession(game).state.dropCount).toBe(1);
    expect(document.querySelector('[data-advanced-stat="drops"]')?.textContent).toBe('0');

    frame(0);
    const [stateAfterDrop] = lastOf(renderer.draw.mock.calls);
    expect(stateAfterDrop.phase).toBe(GamePhase.Animating);
    expect(document.querySelector('[data-advanced-stat="drops"]')?.textContent).toBe('0');
    expect(audio.playDrop).toHaveBeenCalledTimes(1);
    expect(debugPanel.recordTurn).toHaveBeenCalledTimes(1);

    frame(1_000);
    expect(document.querySelector('[data-advanced-stat="drops"]')?.textContent).toBe('1');
    drainAnimations();
    const [stateAfterAnimation] = lastOf(renderer.draw.mock.calls);
    expect(stateAfterAnimation.phase).toBe(GamePhase.WaitingForDrop);
  });

  test('Advanced HUD counts broken discs once per completed clear animation step', () => {
    const { game } = createGame();
    const homeScreen = lastOf(homeScreenInstances);
    homeScreen.onRequestToggleAdvancedHud?.();
    homeScreen.onSelectMode(CLASSIC_MODE);
    frame(0);

    const controller = (game as any).solo;
    const clear = (count: number, chainLevel: number) => ({
      kind: StepKind.Clear,
      cleared: Array.from({ length: count }, (_, col) => ({ row: 6, col })),
      discs: Array.from({ length: count }, (_, value) => makeDisc(value + 1, DiscKind.Numbered)),
      chainLevel,
      pointsAwarded: 10,
    });

    expect(document.querySelector('[data-advanced-stat="broken"]')?.textContent).toBe('0');
    controller.handleSessionStepComplete(clear(2, 0));
    frame(0);
    expect(document.querySelector('[data-advanced-stat="broken"]')?.textContent).toBe('2');

    controller.handleSessionStepComplete({ kind: StepKind.Fall, moves: [] });
    frame(0);
    expect(document.querySelector('[data-advanced-stat="broken"]')?.textContent).toBe('2');

    controller.handleSessionStepComplete(clear(3, 1));
    frame(0);
    expect(document.querySelector('[data-advanced-stat="broken"]')?.textContent).toBe('5');
  });

  test('shows a Temporal Echo callout when the repeated drop begins', () => {
    const { game } = createGame();
    const session = boardSession(game);

    session.handleStepStart({
      kind: StepKind.Drop,
      disc: makeDisc(4, DiscKind.Numbered),
      entryPos: { row: -1, col: 2 },
      landPos: { row: 6, col: 2 },
      temporalEcho: true,
    }, 500);

    expect(lastOf(audioInstances).playDrop).toHaveBeenCalledOnce();
    expect(session.view.scoreIndicators).toEqual([
      expect.objectContaining({
        title: 'TEMPORAL ECHO',
        detail: 'THE TIMELINE REPEATS',
      }),
    ]);
  });

  test('Stack shows each counted disc its share of the final stack award', () => {
    const { game } = createGame();
    const homeScreen = lastOf(homeScreenInstances);
    homeScreen.onSelectMode(STACK_MODE);

    const session = boardSession(game);
    session.stackCascadeActive = true;
    session.handleStepStart({
      kind: StepKind.Clear,
      cleared: [{ row: 6, col: 1 }, { row: 5, col: 1 }, { row: 6, col: 2 }],
      discs: [],
      chainLevel: 0,
      pointsAwarded: 0,
    }, 100);

    expect(session.view.scorePopups).toEqual([
      expect.objectContaining({ value: 30, row: 6, col: 1 }),
      expect.objectContaining({ value: 30, row: 5, col: 1 }),
      expect.objectContaining({ value: 30, row: 6, col: 2 }),
    ]);

    session.handleStepStart({ kind: StepKind.Bonus, bonusKind: 'stack', pointsAwarded: 90 }, 700);
    expect(session.view.scorePopups).toHaveLength(3);
    expect(session.view.scoreIndicators).toEqual([
      expect.objectContaining({
        title: 'TURN TOTAL 3',
        detail: '10 × 3² · +90',
      }),
    ]);
    expect(session.view.lastStackScore).toEqual({
      initial: 3, chains: [], stack: 3, points: 90,
    });
  });

  test('Stack score indicator separates the initiating height from chain clears', () => {
    const { game } = createGame();
    const homeScreen = lastOf(homeScreenInstances);
    homeScreen.onSelectMode(STACK_MODE);

    const session = boardSession(game);
    session.stackCascadeActive = true;
    session.handleStepStart({
      kind: StepKind.Clear,
      cleared: [{ row: 6, col: 1 }, { row: 5, col: 1 }, { row: 4, col: 1 }],
      discs: [],
      chainLevel: 0,
      pointsAwarded: 0,
    }, 100);
    session.handleStepStart({
      kind: StepKind.Push,
      edge: 'bottom',
      newDiscs: [],
    }, 300);
    session.handleStepStart({
      kind: StepKind.Clear,
      cleared: [{ row: 6, col: 2 }, { row: 6, col: 3 }],
      discs: [],
      chainLevel: 1,
      pointsAwarded: 0,
    }, 500);
    session.handleStepStart({ kind: StepKind.Bonus, bonusKind: 'stack', pointsAwarded: 250 }, 900);

    expect(session.view.scoreIndicators).toEqual([
      expect.objectContaining({
        title: 'TURN TOTAL 5',
        detail: '10 × 5² · +250',
      }),
    ]);
    expect(session.view.lastStackScore).toEqual({
      initial: 3, chains: [{ level: 2, cleared: 2 }], stack: 5, points: 250,
    });
  });

  test('Stack gives non-zero presentation credit when a level push initiates the clear', () => {
    const { game } = createGame();
    const homeScreen = lastOf(homeScreenInstances);
    homeScreen.onSelectMode(STACK_MODE);

    const session = boardSession(game);
    session.stackCascadeActive = true;
    session.handleStepStart({ kind: StepKind.Push, edge: 'bottom', newDiscs: [] }, 100);
    session.handleStepStart({
      kind: StepKind.Clear,
      cleared: [{ row: 5, col: 6 }],
      discs: [],
      chainLevel: 0,
      pointsAwarded: 0,
    }, 300);
    session.handleStepStart({ kind: StepKind.Bonus, bonusKind: 'stack', pointsAwarded: 10 }, 700);

    expect(session.view.scorePopups).toEqual([
      expect.objectContaining({ value: 10 }),
    ]);
    expect(session.view.lastStackScore).toEqual({
      initial: 1, chains: [], stack: 1, points: 10,
    });
  });
});

describe('Paradox playable rewind flow', () => {
  test('queues a rewind pressed during turn animation and opens it at the stable boundary', () => {
    createGame();
    lastOf(homeScreenInstances).onSelectMode(PARADOX_MODE);
    const input = lastOf(inputHandlerInstances);

    input.onIntent({ kind: 'drop', col: 3 });
    input.onIntent({ kind: 'rewind' });
    expect(document.querySelector('.rewind-dialog--open')).toBeNull();

    drainAnimations();
    expect(document.querySelector('.rewind-dialog--open')).not.toBeNull();
    expect(document.querySelector('.rewind-dialog')?.textContent).toContain('Instability 0 → 1');
  });

  test('previews and confirms a turn rewind, then persists consumed instability', () => {
    const { game } = createGame();
    const homeScreen = lastOf(homeScreenInstances);
    const saveStore = lastOf(saveStoreInstances);
    homeScreen.onSelectMode(PARADOX_MODE);
    const input = lastOf(inputHandlerInstances);

    input.onIntent({ kind: 'drop', col: 3 });
    drainAnimations();
    frame(0);
    expect(document.querySelector<HTMLButtonElement>('[data-control="rewind"]')!.disabled).toBe(false);

    input.onIntent({ kind: 'rewind' });
    frame(0);
    const dialog = document.querySelector<HTMLElement>('.rewind-dialog--open')!;
    expect(dialog.textContent).toContain('Instability 0 → 1');
    dialog.querySelector<HTMLButtonElement>('.rewind-panel__button--primary')!.click();
    frame(16);

    const state = boardSession(game).state;
    expect(state.dropCount).toBe(0);
    expect(state.paradox?.instability).toBe(1);
    expect(document.querySelector('.rewind-dialog--open')).toBeNull();
    const saved = saveStore.write.mock.calls.at(-1)![1];
    expect(saved.paradox).toEqual({ instability: 1 });
    expect(lastOf(statsStoreInstances).recordCompletedGame).not.toHaveBeenCalled();
  });

  test('selects and confirms a deeper rewind with distance-scaled damage', () => {
    const { game } = createGame();
    lastOf(homeScreenInstances).onSelectMode(PARADOX_MODE);
    const input = lastOf(inputHandlerInstances);

    for (const col of [0, 1, 2]) {
      input.onIntent({ kind: 'drop', col });
      drainAnimations();
    }

    input.onIntent({ kind: 'rewind' });
    const dialog = document.querySelector<HTMLElement>('.rewind-dialog--open')!;
    dialog.querySelector<HTMLButtonElement>('[aria-label="Rewind 3 turns"]')!.click();
    expect(dialog.textContent).toContain('REWIND 3 TURNS?');
    expect(dialog.textContent).toContain('Instability 0 → 3');
    dialog.querySelector<HTMLButtonElement>('.rewind-panel__button--primary')!.click();

    const state = boardSession(game).state;
    expect(state.dropCount).toBe(0);
    expect(state.paradox?.instability).toBe(3);
    expect(lastOf(saveStoreInstances).write.mock.calls.at(-1)![1].paradox).toEqual({ instability: 3 });
  });

  test('keeps a fatal turn provisional, allows rescue, and records only when the player starts over', () => {
    const { game } = createGame();
    lastOf(homeScreenInstances).onSelectMode(PARADOX_MODE);
    const state = boardSession(game).state;
    const engine = boardSession(game).engine as GameEngine;
    for (let row = 0; row < 7; row++) {
      for (let col = 0; col < 7; col++) {
        if (row !== 0 || col !== 0) engine.state.board[row]![col] = makeDisc(7, DiscKind.DoubleCracked);
      }
    }

    const input = lastOf(inputHandlerInstances);
    input.onIntent({ kind: 'drop', col: 0 });
    drainAnimations();
    const statsStore = lastOf(statsStoreInstances);
    expect(state.phase).toBe(GamePhase.GameOver);
    expect(statsStore.recordCompletedGame).not.toHaveBeenCalled();

    const gameOver = document.querySelector<HTMLElement>('.game-over-screen--open')!;
    const rewind = Array.from(gameOver.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent === 'REWIND')!;
    expect(rewind.hidden).toBe(false);
    rewind.click();
    document.querySelector<HTMLButtonElement>('.rewind-panel__button--primary')!.click();
    expect(state.phase).toBe(GamePhase.WaitingForDrop);
    expect(statsStore.recordCompletedGame).not.toHaveBeenCalled();

    input.onIntent({ kind: 'drop', col: 0 });
    drainAnimations();
    const newGame = Array.from(document.querySelectorAll<HTMLButtonElement>('.game-over-button'))
      .find(button => button.textContent === 'NEW GAME')!;
    newGame.click();
    expect(statsStore.recordCompletedGame).toHaveBeenCalledTimes(1);
    expect(state.phase).toBe(GamePhase.WaitingForDrop);
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
    let clock = 100;
    const now = vi.spyOn(performance, 'now').mockImplementation(() => clock);
    const { game } = createGame();
    const homeScreen = lastOf(homeScreenInstances);
    homeScreen.onSelectMode(CLASSIC_MODE);
    frame(0);

    const engine = boardSession(game).engine as {
      state: { board: Board; currentDisc: ReturnType<typeof makeDisc>; score: number };
    };
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
    engine.state.score = 250;

    const input = lastOf(inputHandlerInstances);
    clock = 1_100;
    input.onIntent({ kind: 'drop', col: 0 });
    frame(0);
    expect(lastOf(statsStoreInstances).recordCompletedGame).not.toHaveBeenCalled();

    clock = 5_100;
    expect(() => drainAnimations()).not.toThrow();

    const renderer = lastOf(rendererInstances);
    const [state] = lastOf(renderer.draw.mock.calls);
    expect(state.phase).toBe(GamePhase.GameOver);
    expect(lastOf(saveStoreInstances).remove).toHaveBeenCalledTimes(1);
    const gameOverScreen = document.querySelector<HTMLElement>('.game-over-screen--open');
    expect(gameOverScreen?.textContent).toContain('NEW GAME');
    expect(gameOverScreen?.textContent).toContain('HOME');
    expect(gameOverScreen?.textContent).toContain('NEW HIGH SCORE');
    expect(gameOverScreen?.textContent).toContain('The board filled with no legal moves left.');
    expect(lastOf(statsStoreInstances).recordCompletedGame.mock.calls[0]![1]).toMatchObject({
      totalPlayTimeMs: 5_000,
      totalDiscsDropped: 1,
    });

    const newGameButton = Array.from(gameOverScreen!.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent === 'NEW GAME')!;
    newGameButton.click();
    expect(state.phase).toBe(GamePhase.WaitingForDrop);
    expect(document.querySelector('.game-over-screen--open')).toBeNull();
    now.mockRestore();
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
    expect(tutorial).toEqual({ allowedCols: firstStep.allowedCols, staged: false, needsTilt: false });
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
  test('opens the mode dialog and restores its save, streak, and clean presentation', () => {
    let clock = 100;
    const now = vi.spyOn(performance, 'now').mockImplementation(() => clock);
    const source = new GameEngine({ rules: STACK_MODE.rules, seed: 91 });
    source.drop(2);
    const save = source.exportSave({
      longestStreak: 7,
      playTimeMs: 120_000,
      discsBroken: 42,
      savedAt: 123,
    });
    saveStoreState.byMode.set(STACK_MODE.id, save);

    const { game } = createGame();
    const homeScreen = lastOf(homeScreenInstances);
    const dialog = lastOf(savedGameDialogInstances);

    homeScreen.onRequestToggleAdvancedHud?.();
    expect(homeScreen.setAdvancedHudEnabled).toHaveBeenLastCalledWith(true);
    homeScreen.onSelectMode(STACK_MODE);
    expect(dialog.showSave).toHaveBeenCalledWith(STACK_MODE, save);
    dialog.onResume?.(save);
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
    expect(call[9]).toBeNull();
    expect(boardSession(game).view.longestStreak).toBe(7);
    expect(homeScreen.close).toHaveBeenCalled();
    expect(document.querySelector('[data-advanced-stat="time"]')?.textContent).toBe('2:00');
    expect(document.querySelector('[data-advanced-stat="drops"]')?.textContent)
      .toBe(String(save.state.dropCount));
    expect(document.querySelector('[data-advanced-stat="broken"]')?.textContent).toBe('42');
    clock = 1_100;
    frame(0);
    expect(document.querySelector('[data-advanced-stat="time"]')?.textContent).toBe('2:01');
    homeScreen.onRequestGameMenu?.();
    expect(lastOf(saveStoreInstances).write.mock.calls.at(-1)![1].session).toMatchObject({
      playTimeMs: 121_000,
      discsBroken: 42,
    });
    clock = 5_100;
    frame(0);
    expect(document.querySelector('[data-advanced-stat="time"]')?.textContent).toBe('2:01');
    now.mockRestore();
  });

  test('a mode without a save starts immediately', () => {
    createGame();
    const homeScreen = lastOf(homeScreenInstances);
    const dialog = lastOf(savedGameDialogInstances);

    homeScreen.onSelectMode(CLASSIC_MODE);

    expect(dialog.showSave).not.toHaveBeenCalled();
    expect(homeScreen.close).toHaveBeenCalled();
  });

  test('starting new replaces only the selected mode save', () => {
    const classic = new GameEngine({ rules: CLASSIC_MODE.rules, seed: 7 });
    classic.drop(1);
    const classicSave = classic.exportSave({ savedAt: 10 });
    const stack = new GameEngine({ rules: STACK_MODE.rules, seed: 8 });
    stack.drop(2);
    const stackSave = stack.exportSave({ savedAt: 11 });
    saveStoreState.byMode.set(CLASSIC_MODE.id, classicSave);
    saveStoreState.byMode.set(STACK_MODE.id, stackSave);

    createGame();
    const homeScreen = lastOf(homeScreenInstances);
    const dialog = lastOf(savedGameDialogInstances);
    homeScreen.onSelectMode(CLASSIC_MODE);
    dialog.onStartNew?.();

    expect(lastOf(saveStoreInstances).remove).toHaveBeenCalledWith(CLASSIC_MODE.id);
    expect(saveStoreState.byMode.has(CLASSIC_MODE.id)).toBe(false);
    expect(saveStoreState.byMode.get(STACK_MODE.id)).toBe(stackSave);
    expect(homeScreen.close).toHaveBeenCalled();
  });

  test('presents a cloud conflict and resumes the chosen version', () => {
    const localEngine = new GameEngine({ rules: CLASSIC_MODE.rules, seed: 12 });
    localEngine.drop(1);
    const local = localEngine.exportSave({ savedAt: 12 });
    const cloudEngine = new GameEngine({ rules: CLASSIC_MODE.rules, seed: 13 });
    cloudEngine.drop(2);
    cloudEngine.drop(2);
    const cloud = cloudEngine.exportSave({ savedAt: 13 });
    saveStoreState.byMode.set(CLASSIC_MODE.id, local);
    saveStoreState.conflicts.set(CLASSIC_MODE.id, {
      kind: 'diverged', modeId: CLASSIC_MODE.id, local, cloud,
      cloudRevision: 2, cloudUpdatedAt: '2026-07-13 18:30:00', localScope: 'account',
    });

    createGame();
    const homeScreen = lastOf(homeScreenInstances);
    const dialog = lastOf(savedGameDialogInstances);
    homeScreen.onSelectMode(CLASSIC_MODE);
    expect(dialog.showConflict).toHaveBeenCalledWith(CLASSIC_MODE, local, cloud);

    dialog.onChooseCloud?.(cloud);
    frame(0);

    expect(lastOf(saveStoreInstances).resolveConflict).toHaveBeenCalledWith(CLASSIC_MODE.id, 'cloud');
    const [state] = lastOf(lastOf(rendererInstances).draw.mock.calls);
    expect(state.dropCount).toBe(cloud.state.dropCount);
    expect(homeScreen.close).toHaveBeenCalled();
  });

  test('offers a valid device save when the cloud record is incompatible', () => {
    const engine = new GameEngine({ rules: CLASSIC_MODE.rules, seed: 14 });
    engine.drop(1);
    const local = engine.exportSave({ savedAt: 14 });
    saveStoreState.conflicts.set(CLASSIC_MODE.id, {
      kind: 'invalid-cloud', modeId: CLASSIC_MODE.id, local, cloud: null,
      cloudRevision: 3, cloudUpdatedAt: '2026-07-13 18:30:00', localScope: 'account',
    });

    createGame();
    const homeScreen = lastOf(homeScreenInstances);
    const dialog = lastOf(savedGameDialogInstances);
    homeScreen.onSelectMode(CLASSIC_MODE);

    expect(dialog.showUnavailable).toHaveBeenCalledWith(CLASSIC_MODE, local);
    dialog.onChooseLocal?.(local);
    expect(lastOf(saveStoreInstances).resolveConflict).toHaveBeenCalledWith(CLASSIC_MODE.id, 'local');
  });
});

// ─── Gravity tutorial ───────────────────────────────────────────────────────
// Mirrors the Classic tutorial coverage above end-to-end through the same
// public Game API (home screen -> input intents -> renderer draws), but for
// GRAVITY_TUTORIAL specifically — every step stages a lane ('drop'), tilts,
// then confirms (a second 'drop'), and its pre-tilted step (gravityAngleDeg)
// needs state.gravity to actually reflect that tilt on load, which is the
// loadScriptedState gap this whole feature fixed.

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
    expect(tutorial).toEqual({ allowedCols: firstStep.allowedCols, staged: false, needsTilt: false });
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

    // Complete the first three staged drop-and-tilt steps to reach the
    // fourth, pre-tilted tutorial board.
    for (const step of GRAVITY_TUTORIAL.steps.slice(0, 3)) {
      input.onIntent({ kind: 'drop', col: step.allowedCols[0]! });
      input.onIntent({ kind: 'tilt', delta: 45 });
      input.onIntent({ kind: 'drop', col: 0 });
      drainAnimations();
    }

    const { state } = lastDraw(renderer);
    expect(state.gravity!.angle).toBe(GRAVITY_TUTORIAL.steps[3]!.gravityAngleDeg);
  });

  test('completing all four staged drops hands off to Gravity mode, not Classic', () => {
    createGame();
    const homeScreen = lastOf(homeScreenInstances);
    const renderer = lastOf(rendererInstances);
    const input = lastOf(inputHandlerInstances);

    homeScreen.onRequestTutorial?.(GRAVITY_MODE);
    frame(0);

    for (const step of GRAVITY_TUTORIAL.steps) {
      input.onIntent({ kind: 'drop', col: step.allowedCols[0]! });
      input.onIntent({ kind: 'tilt', delta: 45 });
      input.onIntent({ kind: 'drop', col: 0 }); // confirm
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

// ─── Gravity tutorial "tilt is owed" cues ───────────────────────────────────
// GameControls, GameHud, and TutorialOverlay all run for real (only the
// canvas renderer & co. are mocked), so these drive the true DOM cues end to
// end: attention classes on the ↺/↻ buttons / hint / compass ring, the
// overlay's Aiming prompt swap, and the staged/needsTilt tutorial visual
// state handed to the renderer — all fed by the controller's single snapped
// needsTilt definition.

describe('gravity tutorial tilt cues', () => {
  function controlButton(control: string): HTMLButtonElement {
    const button = document.querySelector<HTMLButtonElement>(`[data-control="${control}"]`);
    if (!button) throw new Error(`missing [data-control="${control}"]`);
    return button;
  }

  function promptText(): string {
    return document.querySelector('.tutorial-prompt')?.textContent ?? '';
  }

  function startGravityTutorial(): { renderer: any; input: any; firstStep: any } {
    createGame();
    const homeScreen = lastOf(homeScreenInstances);
    homeScreen.onRequestTutorial?.(GRAVITY_MODE);
    frame(0);
    return {
      renderer: lastOf(rendererInstances),
      input: lastOf(inputHandlerInstances),
      firstStep: GRAVITY_TUTORIAL.steps[0]!,
    };
  }

  test('staging flips every cue on: staged/needsTilt visual state, tiltPrompt, button/hint/compass attention', () => {
    const { renderer, input, firstStep } = startGravityTutorial();

    input.onIntent({ kind: 'drop', col: firstStep.allowedCols[0] });
    frame(0);

    const { tutorial } = lastDraw(renderer);
    expect(tutorial).toEqual({ allowedCols: firstStep.allowedCols, staged: true, needsTilt: true });
    expect(promptText()).toBe(firstStep.tiltPrompt);
    expect(controlButton('tilt-clockwise').classList.contains('game-control--attention')).toBe(true);
    expect(controlButton('tilt-counter-clockwise').classList.contains('game-control--attention')).toBe(true);
    expect(controlButton('confirm').disabled).toBe(true);
    expect(document.querySelector('.game-hud__hint')?.classList.contains('game-hud__hint--attention')).toBe(true);
    expect(document.querySelector('.game-hud__gravity')?.classList.contains('game-hud__gravity--attention')).toBe(true);
    expect(document.querySelector('.game-hud__gravity-attention-ring')).not.toBeNull();
  });

  test('one ±45° tilt hides the lane and moves attention to CONFIRM', () => {
    const { renderer, input, firstStep } = startGravityTutorial();

    input.onIntent({ kind: 'drop', col: firstStep.allowedCols[0] });
    input.onIntent({ kind: 'tilt', delta: 45 });
    frame(0);

    const { tutorial } = lastDraw(renderer);
    expect(tutorial).toEqual({ allowedCols: firstStep.allowedCols, staged: true, needsTilt: false });
    expect(controlButton('tilt-clockwise').classList.contains('game-control--attention')).toBe(false);
    expect(controlButton('tilt-counter-clockwise').classList.contains('game-control--attention')).toBe(false);
    expect(controlButton('confirm').disabled).toBe(false);
    expect(controlButton('confirm').classList.contains('game-control--ready')).toBe(true);
    expect(document.querySelector('.game-hud__hint')?.classList.contains('game-hud__hint--attention')).toBe(false);
    expect(document.querySelector('.game-hud__hint')?.classList.contains('game-hud__hint--ready')).toBe(true);
    expect(document.querySelector('.game-hud__hint')?.textContent).toContain('Rotation set');
    expect(document.querySelector('.game-hud__gravity')?.classList.contains('game-hud__gravity--attention')).toBe(false);
  });

  test('tilting +45 then back -45 re-owes the tilt: cues return, CONFIRM disables again', () => {
    const { renderer, input, firstStep } = startGravityTutorial();

    input.onIntent({ kind: 'drop', col: firstStep.allowedCols[0] });
    input.onIntent({ kind: 'tilt', delta: 45 });
    input.onIntent({ kind: 'tilt', delta: -45 });
    frame(0);

    const { tutorial } = lastDraw(renderer);
    expect(tutorial?.needsTilt).toBe(true);
    expect(controlButton('tilt-clockwise').classList.contains('game-control--attention')).toBe(true);
    expect(controlButton('confirm').disabled).toBe(true);
    expect(controlButton('confirm').classList.contains('game-control--ready')).toBe(false);
    expect(document.querySelector('.game-hud__hint')?.classList.contains('game-hud__hint--ready')).toBe(false);
  });

  test('confirming before tilting is rejected: still Aiming, tiltPrompt still up, cues still active', () => {
    const { renderer, input, firstStep } = startGravityTutorial();

    input.onIntent({ kind: 'drop', col: firstStep.allowedCols[0] });
    input.onIntent({ kind: 'drop', col: firstStep.allowedCols[0] }); // confirm attempt, engine rejects 'tilt-required'
    frame(0);

    const { state, tutorial } = lastDraw(renderer);
    expect(state.phase).toBe(GamePhase.Aiming);
    expect(tutorial?.needsTilt).toBe(true);
    expect(promptText()).toBe(firstStep.tiltPrompt);
    expect(controlButton('tilt-clockwise').classList.contains('game-control--attention')).toBe(true);
  });

  test('cancel restores the step prompt and un-stages the lane', () => {
    const { renderer, input, firstStep } = startGravityTutorial();

    input.onIntent({ kind: 'drop', col: firstStep.allowedCols[0] });
    frame(0);
    expect(promptText()).toBe(firstStep.tiltPrompt);

    input.onIntent({ kind: 'cancel' });
    frame(0);

    const { state, tutorial } = lastDraw(renderer);
    expect(state.phase).toBe(GamePhase.WaitingForDrop);
    expect(tutorial).toEqual({ allowedCols: firstStep.allowedCols, staged: false, needsTilt: false });
    expect(promptText()).toBe(firstStep.prompt);
  });
});
