import type { SoloModeDefinition } from '../game/modes/mode.js';
import { rewindModifier, turnCostForInstability } from '../game/modes/mode.js';
import type { GameState } from '../game/state.js';
import { GamePhase } from '../game/state.js';
import type { PhysicsStep } from '../game/events.js';
import { StepKind } from '../game/events.js';
import type { GameOverReason, TurnResult } from '../game/engine.js';
import { CLASSIC_MODE, SOLO_MODES } from '../game/modes/index.js';
import { DebugPanel } from '../ui/debug/debug-panel.js';
import { releaseGameplayFocus } from '../ui/dom-utils.js';
import { Renderer } from '../ui/rendering/renderer.js';
import { InputHandler } from '../platform/input-handler.js';
import type { InputIntent } from '../platform/input-handler.js';
import { AudioManager } from '../platform/audio-manager.js';
import { HomeScreen } from '../ui/home-screen.js';
import { GameOverScreen } from '../ui/game-over-screen.js';
import type { GameStats } from '../game/stats.js';
import { recordCompletedGame, updateRecords } from '../game/stats.js';
import { AccountStatsStore } from '../platform/account-stats-store.js';
import { setGridSize, setHudBands } from '../ui/rendering/layout.js';
import { HUD_BOTTOM_HEIGHT, HUD_TOP_HEIGHT } from '../ui/rendering/theme.js';
import { TUTORIALS } from './tutorial.js';
import type { TutorialDefinition, TutorialStep } from './tutorial.js';
import { isTutorialStepSuccessful } from './tutorial.js';
import { TutorialOverlay } from '../ui/tutorial-overlay.js';
import { GameControls } from '../ui/game-controls.js';
import { GameHud } from '../ui/game-hud.js';
import { SyncedSaveStore } from '../platform/synced-save-store.js';
import { SavedGameDialog } from '../ui/saved-game-dialog.js';
import { RewindDialog } from '../ui/rewind-dialog.js';
import { AdvancedStatsDialog } from '../ui/advanced-stats-dialog.js';
import type { SaveGameV1 } from '../game/save.js';
import type { UiMounts } from '../ui/ui-root.js';
import { LocalBoardSession } from './local-board-session.js';
import { PlayTimeTracker } from './play-time-tracker.js';
import { UserSettingsStore } from '../platform/user-settings-store.js';
import type { ZoomControls } from '../ui/zoom-controls.js';

const TURN_PIP_CAPACITY = Math.max(
  ...SOLO_MODES.map(mode => mode.rules.progression.initialTurnsPerLevel),
);
const SAVE_EXIT_SYNC_WAIT_MS = 5_000;

export class SoloSessionController {
  private readonly state: GameState;
  private readonly session: LocalBoardSession;
  private mode: SoloModeDefinition;
  private renderer: Renderer;
  private input: InputHandler;
  private audio: AudioManager;
  private debug: DebugPanel;
  private homeScreen: HomeScreen;
  private gameOverScreen: GameOverScreen;
  private tutorialOverlay: TutorialOverlay;
  private gameControls: GameControls;
  private gameHud: GameHud;
  private readonly saveStore: SyncedSaveStore;
  private readonly savedGameDialog: SavedGameDialog;
  private readonly rewindDialog: RewindDialog;
  private readonly advancedStatsDialog: AdvancedStatsDialog;
  private saveDialogMode: SoloModeDefinition | null = null;
  private rafId = 0;
  private stats: GameStats;
  private statsStore: AccountStatsStore;
  private unsubscribeStatsStore: (() => void) | null = null;
  private unsubscribeSaveStore: (() => void) | null = null;
  private pendingRewind = false;
  private highScoreAtGameStart = 0;
  private bestRecordAtGameStart = 0;
  private gameRecorded = false;
  private activeTutorial: TutorialDefinition | null = null;
  private tutorialStepIndex = 0;
  private saveExitPending = false;
  private readonly playTime = new PlayTimeTracker();
  private readonly userSettings = new UserSettingsStore();
  private advancedHudEnabled = this.userSettings.get().advancedHud;
  private discsBrokenThisGame = 0;
  private displayedDropsThisGame = 0;
  private displayedDiscsBrokenThisGame = 0;
  private readonly refreshSavesOnFocus = (): void => {
    this.refreshSavesForMenu();
  };
  private readonly handleVisibilityChange = (): void => {
    if (document.visibilityState === 'visible') {
      this.playTime.resume('backgrounded');
      this.refreshSavesForMenu();
    } else {
      this.playTime.pause('backgrounded');
      this.updateSavedRunMetrics();
    }
  };

  constructor(canvas: HTMLCanvasElement, mounts?: UiMounts, zoomControls?: ZoomControls) {
    const stageMount = mounts?.stage ?? canvas.parentElement ?? document.body;
    const controlsMount = mounts?.controls
      ?? document.querySelector<HTMLElement>('.shell-region--bottom')
      ?? document.body;
    const overlayMount = mounts?.overlays ?? document.body;
    const modalBackground = mounts?.modalBackground ?? [];
    this.renderer = new Renderer(canvas);
    this.audio    = new AudioManager();
    this.mode     = CLASSIC_MODE; // placeholder until a mode is chosen on the home screen
    this.session = new LocalBoardSession({
      rules: this.mode.rules,
      events: {
        onStableTurn: result => this.handleStableSessionTurn(result),
        onTurn: result => this.handleSessionTurn(result),
        onStepStart: step => this.handleSessionStepStart(step),
        onStepComplete: step => this.handleSessionStepComplete(step),
        onPlaybackComplete: result => this.handleSessionPlaybackComplete(result),
      },
    });
    this.state = this.session.state;
    this.session.enterMenu(); // suppress gameplay until a mode is selected
    this.debug    = new DebugPanel(this.state, undefined, overlayMount);
    this.debug.canForceGameOver = () => !this.activeTutorial
      && this.state.phase !== GamePhase.Menu
      && this.state.phase !== GamePhase.GameOver;
    this.debug.onForceGameOver = () => this.forceGameOver();
    this.tutorialOverlay = new TutorialOverlay(overlayMount);
    this.gameControls = new GameControls(intent => this.handleIntent(intent), controlsMount);
    this.gameHud = new GameHud(stageMount);
    this.savedGameDialog = new SavedGameDialog(overlayMount, modalBackground);
    this.rewindDialog = new RewindDialog(overlayMount, modalBackground, stageMount.parentElement);
    this.advancedStatsDialog = new AdvancedStatsDialog(overlayMount, modalBackground);
    this.statsStore = new AccountStatsStore(SOLO_MODES);
    this.saveStore = new SyncedSaveStore(SOLO_MODES);
    this.stats = this.statsStore.loadStats(this.mode.id);
    this.captureGameStartRecords();

    this.homeScreen = new HomeScreen(
      SOLO_MODES,
      mode => this.selectMode(mode),
      modeId => this.statsStore.loadStats(modeId),
      () => this.statsStore.getState(),
      () => this.statsStore.login(),
      () => void this.logout(),
      overlayMount,
      modalBackground,
    );
    this.gameOverScreen = new GameOverScreen(overlayMount, modalBackground);
    this.homeScreen.onRequestGameMenu = () => this.openGameMenu();
    this.homeScreen.onRequestResume = () => this.resumeGame();
    this.homeScreen.onRequestRestart = () => this.restart();
    this.homeScreen.onRequestHome = () => void this.saveAndReturnToMenu();
    this.homeScreen.onRequestToggleSound = () => this.toggleSound();
    this.homeScreen.onRequestToggleAdvancedHud = () => this.toggleAdvancedHud();
    if (zoomControls) {
      this.homeScreen.onRequestZoomIn = () => zoomControls.zoomIn();
      this.homeScreen.onRequestZoomOut = () => zoomControls.zoomOut();
      this.homeScreen.onRequestZoomReset = () => zoomControls.resetZoom();
      zoomControls.onScaleChange = scale => this.homeScreen.updateZoomState(scale);
      this.homeScreen.updateZoomState(zoomControls.getScale());
    }
    this.homeScreen.onRequestDebug = () => this.openDebugPanel();
    this.homeScreen.onRequestAdvancedStats = modeId => this.advancedStatsDialog.open({
      modes: SOLO_MODES.map(mode => ({ mode, stats: this.statsStore.loadStats(mode.id) })),
      ...(modeId ? { modeId } : {}),
    });
    this.homeScreen.onRequestTutorial = mode => this.startTutorial(mode);
    this.homeScreen.onRequestCreateMultiplayer = modeId => {
      location.search = `?multiplayer=create&mode=${encodeURIComponent(modeId)}`;
    };
    this.homeScreen.onRequestJoinMultiplayer = (roomId, modeId) => {
      location.search = `?room=${encodeURIComponent(roomId)}&mode=${encodeURIComponent(modeId)}`;
    };
    this.gameOverScreen.onRequestRewind = () => this.requestRewind();
    this.gameOverScreen.onRequestNewGame = () => this.restart();
    this.gameOverScreen.onRequestHome = () => this.returnToMenu();
    this.rewindDialog.onConfirm = () => this.confirmRewind();
    this.rewindDialog.onCancel = () => this.cancelRewind();
    this.rewindDialog.onSelectTurns = turns => this.selectRewindDepth(turns);
    this.rewindDialog.onLayoutChange = () => {
      // The dialog preview also hides both HUD bands (game-hud.css
      // [data-rewind-preview] .game-hud__top/__bottom — the dialog itself
      // repeats their info) — reclaim the canvas space reserved for them so
      // the board can grow into it instead of that space sitting blank on
      // top of the dialog's own clearance.
      const isOpen = this.rewindDialog.isOpen();
      setHudBands(isOpen ? 0 : HUD_TOP_HEIGHT, isOpen ? 0 : HUD_BOTTOM_HEIGHT);
      this.renderer.resize();
    };
    this.tutorialOverlay.onRetry = () => this.retryTutorialStep();
    this.tutorialOverlay.onExit = () => this.returnToMenu();
    this.tutorialOverlay.onContinue = () => this.tutorialOverlay.hide();
    this.savedGameDialog.onResume = save => this.resumeSavedGame(save);
    this.savedGameDialog.onStartNew = () => this.startNewGameFromDialog();
    this.savedGameDialog.onChooseLocal = save => this.resolveSaveConflict('local', save);
    this.savedGameDialog.onChooseCloud = save => this.resolveSaveConflict('cloud', save);
    this.savedGameDialog.onCancel = () => {
      this.saveDialogMode = null;
      this.homeScreen.open();
    };
    this.homeScreen.setSoundEnabled(this.audio.isEnabled());
    this.homeScreen.setAdvancedHudEnabled(this.advancedHudEnabled);
    this.unsubscribeStatsStore = this.statsStore.subscribe(() => this.handleStatsStoreUpdate());
    this.unsubscribeSaveStore = this.saveStore.subscribe(() => this.handleSaveStoreUpdate());
    this.handleSaveStoreUpdate();
    this.homeScreen.open();
    window.addEventListener('focus', this.refreshSavesOnFocus);
    document.addEventListener('visibilitychange', this.handleVisibilityChange);

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
    this.rewindDialog.refreshLayout();
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

  private selectMode(mode: SoloModeDefinition): void {
    if (this.saveStore.getState().loading) return;
    if (this.saveStore.getState().scope === 'account') {
      void this.refreshAndSelectMode(mode);
      return;
    }
    this.presentMode(mode);
  }

  private async refreshAndSelectMode(mode: SoloModeDefinition): Promise<void> {
    await this.saveStore.refreshSaves();
    this.presentMode(mode);
  }

  private presentMode(mode: SoloModeDefinition): void {
    this.saveDialogMode = mode;
    if (this.showSavedGameChoice(mode)) return;
    this.startGame(mode);
  }

  private showSavedGameChoice(mode: SoloModeDefinition): boolean {
    const conflict = this.saveStore.getConflict(mode.id);
    if (conflict?.kind === 'invalid-cloud') {
      this.homeScreen.close();
      this.savedGameDialog.showUnavailable(mode, conflict.local);
      return true;
    }
    if (conflict) {
      this.homeScreen.close();
      this.savedGameDialog.showConflict(mode, conflict.local, conflict.cloud);
      return true;
    }

    const save = this.saveStore.read(mode.id);
    if (save) {
      this.homeScreen.close();
      this.savedGameDialog.showSave(mode, save);
      return true;
    }
    return false;
  }

  private startNewGameFromDialog(): void {
    const mode = this.saveDialogMode;
    if (!mode) return;
    if (this.saveStore.getConflict(mode.id)) {
      this.saveStore.resolveConflict(mode.id, 'new');
    } else {
      this.saveStore.remove(mode.id);
    }
    this.startGame(mode);
  }

  private resolveSaveConflict(resolution: 'local' | 'cloud', save: SaveGameV1 | null): void {
    const mode = this.saveDialogMode;
    if (!mode || !save) return;
    this.saveStore.resolveConflict(mode.id, resolution);
    this.resumeSavedGame(save);
  }

  private startGame(mode: SoloModeDefinition): void {
    this.gameOverScreen.close();
    this.rewindDialog.hide();
    this.saveDialogMode = null;
    this.activeTutorial = null;
    this.tutorialOverlay.hide();
    this.mode = mode;
    this.session.configure(mode.rules, this.debugSeedOverride());
    this.stats = this.statsStore.loadStats(mode.id);
    this.captureGameStartRecords();
    setGridSize(mode.rules.board.cols, mode.rules.board.rows);
    this.renderer.resize();
    this.pendingRewind = false;
    this.gameRecorded = false;
    this.startRunTracking();
    this.debug.reset();
    this.homeScreen.close();
    releaseGameplayFocus();
  }

  private startTutorial(mode: SoloModeDefinition): void {
    this.gameOverScreen.close();
    this.rewindDialog.hide();
    const tutorial = TUTORIALS[mode.id];
    if (!tutorial) return;
    this.mode = mode;
    this.stats = this.statsStore.loadStats(mode.id);
    this.captureGameStartRecords();
    setGridSize(mode.rules.board.cols, mode.rules.board.rows);
    this.renderer.resize();
    this.activeTutorial = tutorial;
    this.tutorialStepIndex = 0;
    this.gameRecorded = true; // tutorials never count as completed games
    this.playTime.stop();
    this.discsBrokenThisGame = 0;
    this.debug.reset();
    this.loadTutorialStep();
    this.homeScreen.close();
    releaseGameplayFocus();
  }

  private returnToMenu(): void {
    this.finalizeCurrentGame();
    this.gameOverScreen.close();
    this.rewindDialog.hide();
    this.homeScreen.closeGameMenu();
    this.activeTutorial = null;
    this.tutorialOverlay.hide();
    this.session.enterMenu();
    this.playTime.stop();
    this.discsBrokenThisGame = 0;
    this.pendingRewind = false;
    this.homeScreen.open();
  }

  private async saveAndReturnToMenu(): Promise<void> {
    if (this.saveExitPending) return;
    if (this.activeTutorial || this.state.phase === GamePhase.GameOver) {
      this.returnToMenu();
      return;
    }

    this.saveExitPending = true;
    this.homeScreen.setSaveExitPending(true);
    this.updateSavedRunMetrics();
    let timeoutId: number | undefined;
    try {
      await Promise.race([
        this.saveStore.sync(this.mode.id),
        new Promise<void>(resolve => {
          timeoutId = window.setTimeout(resolve, SAVE_EXIT_SYNC_WAIT_MS);
        }),
      ]);
    } finally {
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
      this.saveExitPending = false;
      this.homeScreen.setSaveExitPending(false);
      this.returnToMenu();
    }
  }

  private refreshSavesForMenu(): void {
    if (this.state.phase !== GamePhase.Menu || this.saveStore.getState().loading) return;
    void this.refreshMenuSaves();
  }

  private async refreshMenuSaves(): Promise<void> {
    await this.saveStore.refreshSaves();
    const mode = this.saveDialogMode;
    if (!mode || !this.savedGameDialog.isOpen()) return;
    if (this.showSavedGameChoice(mode)) return;

    this.savedGameDialog.hide();
    this.saveDialogMode = null;
    this.homeScreen.open();
  }

  // Column count for top/bottom entry, row count for left/right entry — this
  // already generalizes to a Gravity-mode tutorial step too (e.g. one loaded
  // pre-tilted via TutorialStep.gravityAngleDeg), since it only reads
  // state.gravity, which loadScriptedState now always keeps in sync with the
  // active mode/step.
  private currentLaneCount(): number {
    return this.session.view.laneCount;
  }

  private currentAxis(): 'col' | 'row' {
    return this.session.view.axis;
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

    if (intent.kind === 'rewind') {
      this.requestRewind();
      return;
    }

    // A Gravity turn stages a lane first. Q/E then rotates that staged drop;
    // there is no standalone tilt action outside Aiming.
    if (intent.kind === 'tilt') {
      if (this.state.phase === GamePhase.Aiming) {
        this.session.tilt(intent.delta);
        this.debug.refresh();
      }
      return;
    }

    // Backs out of a staged gravity drop for free — nothing was committed yet.
    if (intent.kind === 'cancel') {
      if (this.state.phase === GamePhase.Aiming) {
        this.session.cancelTilt();
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
      this.session.moveCursor(col);
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
        this.session.moveCursor(tutorialStep.allowedCols[0] ?? col);
        return;
      }
      this.session.moveCursor(col);
      if (this.mode.rules.placement.kind === 'stage-and-tilt@1') {
        const rejected = this.session.stageDrop(col);
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
    this.session.drop(col);
  }

  private handleCommitTilt(): void {
    this.session.commitTilt();
  }

  private handleSessionTurn(result: TurnResult): void {
    if (!result.accepted) {
      this.debug.recordTurn(result);
      if (result.gameOver) {
        this.setGameOver(result.gameOverReason);
      }
      return;
    }
    this.debug.recordTurn(result);
  }

  private handleStableSessionTurn(result: TurnResult): void {
    if (!this.activeTutorial) {
      this.discsBrokenThisGame += result.stackSize;
      if (!rewindModifier(this.mode.rules)) {
        const recordsImproved = updateRecords(
          this.stats,
          this.state.score,
          this.session.view.longestStreak,
        );
        if (recordsImproved && !result.gameOver) this.statsStore.saveStats(this.mode.id, this.stats);
      }
      if (result.gameOver && !rewindModifier(this.mode.rules)) this.saveStore.remove(this.mode.id);
      else this.writeCurrentSave();
    }
  }

  private handleSessionPlaybackComplete(result: TurnResult): void {
    if (result.gameOver) {
      this.setGameOver(result.gameOverReason, false);
    } else if (this.activeTutorial) {
      this.completeTutorialTurn(result);
    } else {
      this.debug.refresh();
    }
    if (this.pendingRewind) {
      this.pendingRewind = false;
      this.requestRewind();
    }
  }

  private handleSessionStepStart(step: PhysicsStep): void {
    if (step.kind === StepKind.Drop) {
      this.audio.playDrop();
    } else if (step.kind === StepKind.Push) {
      this.audio.playPush();
    } else if (step.kind === StepKind.Clear) {
      this.audio.playClear(step.chainLevel);
    } else if (step.kind === StepKind.Reveal) {
      this.audio.playReveal();
    }
  }

  private handleSessionStepComplete(step: PhysicsStep): void {
    if (step.kind === StepKind.Drop && !step.temporalEcho) {
      this.displayedDropsThisGame++;
    } else if (step.kind === StepKind.Clear) {
      this.displayedDiscsBrokenThisGame += step.cleared.length;
    }
    if (step.kind !== StepKind.Bonus) this.debug.advancePlayback();
  }

  private setGameOver(reason?: GameOverReason, clearSave = true): void {
    this.session.setGameOver(reason);
    this.playTime.pause('gameover');
    const canRewind = this.session.canRewind();
    if (canRewind) {
      this.writeCurrentSave();
    } else if (clearSave) {
      this.saveStore.remove(this.mode.id);
    }
    if (!canRewind) this.recordGameEnd();
    this.debug.refresh();
    this.audio.playGameOver();
    this.openGameOverSummary(canRewind);
  }

  private openGameOverSummary(canRewind = this.session.canRewind()): void {
    const view = this.session.view;
    const displayedStats = canRewind ? this.projectedFinalStats() : this.stats;
    this.gameOverScreen.open({
      score: this.state.score,
      stats: displayedStats,
      isStackMode: this.isStackMode(),
      bestRunRecord: view.longestStreak,
      previousHighScore: this.highScoreAtGameStart,
      previousBestRecord: this.bestRecordAtGameStart,
      playTimeMs: this.playTime.peek(),
      discsDropped: this.state.dropCount,
      discsBroken: this.discsBrokenThisGame,
      canRewind,
      ...(view.lastGameOverReason ? { reason: view.lastGameOverReason } : {}),
    });
  }

  private projectedFinalStats(): GameStats {
    const projected = { ...this.stats };
    updateRecords(projected, this.state.score, this.session.view.longestStreak);
    recordCompletedGame(
      projected,
      this.state.score,
      this.playTime.peek(),
      this.state.dropCount,
      this.discsBrokenThisGame,
    );
    return projected;
  }

  private recordGameEnd(): void {
    if (this.activeTutorial) return;
    if (!this.gameRecorded) {
      const playTimeMs = this.playTime.stop();
      updateRecords(this.stats, this.state.score, this.session.view.longestStreak);
      recordCompletedGame(
        this.stats,
        this.state.score,
        playTimeMs,
        this.state.dropCount,
        this.discsBrokenThisGame,
      );
      this.statsStore.recordCompletedGame(
        this.mode.id,
        this.stats,
        this.state.score,
        this.session.view.longestStreak,
      );
      this.gameRecorded = true;
    }
  }

  private finalizeCurrentGame(): void {
    if (this.state.phase !== GamePhase.GameOver || this.gameRecorded) return;
    this.recordGameEnd();
    this.saveStore.remove(this.mode.id);
  }

  private writeCurrentSave(): void {
    this.saveStore.write(this.mode.id, this.session.exportSave({
      playTimeMs: Math.floor(this.playTime.peek()),
      discsBroken: this.discsBrokenThisGame,
    }));
  }

  private updateSavedRunMetrics(): void {
    if (this.activeTutorial || this.state.phase === GamePhase.Menu) return;
    const save = this.saveStore.read(this.mode.id);
    if (!save) return;
    save.savedAt = Date.now();
    save.session.playTimeMs = Math.floor(this.playTime.peek());
    save.session.discsBroken = this.discsBrokenThisGame;
    this.saveStore.write(this.mode.id, save);
  }

  private handleStatsStoreUpdate(): void {
    this.homeScreen.refreshStats();
    this.homeScreen.refreshAuth();
    if (this.state.phase === GamePhase.Menu || this.state.phase === GamePhase.GameOver) {
      this.stats = this.statsStore.loadStats(this.mode.id);
    }
  }

  private handleSaveStoreUpdate(): void {
    this.homeScreen.setSaveLoading(this.saveStore.getState().loading);
  }

  private requestRewind(): void {
    if (this.rewindDialog.isOpen()) return;
    if (rewindModifier(this.mode.rules) && this.state.phase === GamePhase.Animating) {
      this.pendingRewind = true;
      return;
    }
    const preview = this.session.previewRewind();
    if (!preview) return;
    this.pausePlayback();
    this.playTime.pause('rewind');
    this.gameOverScreen.close();
    this.rewindDialog.show(preview);
  }

  private selectRewindDepth(turns: number): void {
    if (!this.rewindDialog.isOpen()) return;
    const preview = this.session.previewRewind(turns);
    if (!preview) return;
    this.rewindDialog.update(preview);
  }

  private cancelRewind(): void {
    if (!this.rewindDialog.isOpen()) return;
    this.rewindDialog.hide();
    this.session.clearRewindPreview();
    this.pendingRewind = false;
    if (this.state.phase === GamePhase.GameOver) this.openGameOverSummary(true);
    else {
      this.resumePlayback();
      this.playTime.resume('rewind');
    }
  }

  private confirmRewind(): void {
    if (!this.session.commitRewind()) {
      this.cancelRewind();
      return;
    }
    this.rewindDialog.hide();
    this.gameOverScreen.close();
    this.pendingRewind = false;
    this.playTime.resume('rewind');
    this.playTime.resume('gameover');
    this.displayedDropsThisGame = this.state.dropCount;
    this.writeCurrentSave();
    this.debug.refresh();
    releaseGameplayFocus();
  }

  private async logout(): Promise<void> {
    await this.statsStore.logout();
    await this.saveStore.setAuthState(null);
  }

  private restart(): void {
    this.finalizeCurrentGame();
    this.gameOverScreen.close();
    this.rewindDialog.hide();
    this.homeScreen.closeGameMenu();
    if (this.activeTutorial) {
      this.retryTutorialStep();
      return;
    }
    this.saveStore.remove(this.mode.id);
    this.session.restart();
    this.debug.reset();
    this.captureGameStartRecords();
    this.gameRecorded = false;
    this.startRunTracking();
  }

  private currentTutorialStep(): TutorialStep | null {
    return this.activeTutorial?.steps[this.tutorialStepIndex] ?? null;
  }

  private retryTutorialStep(): void {
    if (!this.activeTutorial) return;
    this.homeScreen.closeGameMenu();
    this.loadTutorialStep();
  }

  private loadTutorialStep(): void {
    const tutorial = this.activeTutorial;
    const step = this.currentTutorialStep();
    if (!tutorial || !step) return;

    this.session.loadScriptedState({
      rules: this.mode.rules,
      board: step.board,
      currentDisc: step.currentDisc,
      nextDisc: step.nextDisc,
      ...(step.gravityAngleDeg !== undefined ? { gravityAngleDeg: step.gravityAngleDeg } : {}),
    });
    this.session.moveCursor(step.allowedCols[0] ?? this.state.cursorCol);
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
      this.session.continueFromTutorial();
      this.activeTutorial = null;
      this.gameRecorded = false;
      this.startRunTracking();
      this.stats = this.statsStore.loadStats(this.mode.id);
      this.captureGameStartRecords();
      this.tutorialOverlay.showComplete(completedTutorial, this.mode.name);
      this.debug.refresh();
      return;
    }

    this.loadTutorialStep();
  }

  private openGameMenu(): void {
    if (this.state.phase === GamePhase.Menu) return;
    this.pausePlayback();
    this.playTime.pause('menu');
    this.updateSavedRunMetrics();
    this.homeScreen.setSoundEnabled(this.audio.isEnabled());
    this.homeScreen.openGameMenu();
  }

  private resumeGame(): void {
    this.resumePlayback();
    this.playTime.resume('menu');
    this.homeScreen.closeGameMenu();
  }

  private resumeSavedGame(save: SaveGameV1): void {
    const mode = SOLO_MODES.find(candidate => candidate.id === save.modeId);
    if (!mode) {
      return;
    }

    try {
      this.gameOverScreen.close();
      this.session.loadSave(save, mode.rules);
      this.mode = mode;
      this.stats = this.statsStore.loadStats(mode.id);
      this.captureGameStartRecords();
      setGridSize(mode.rules.board.cols, mode.rules.board.rows);
      this.renderer.resize();
      this.activeTutorial = null;
      this.tutorialOverlay.hide();
      this.gameRecorded = false;
      this.startRunTracking(save.session.playTimeMs ?? 0, save.session.discsBroken ?? 0);
      this.debug.reset();
      this.saveDialogMode = null;
      this.homeScreen.closeGameMenu();
      this.homeScreen.close();
      releaseGameplayFocus();
      if (this.state.phase === GamePhase.GameOver) this.setGameOver(undefined, false);
    } catch {
      this.saveStore.remove(mode.id);
    }
  }

  private captureGameStartRecords(): void {
    this.highScoreAtGameStart = this.stats.highScore;
    this.bestRecordAtGameStart = this.stats.longestStreak;
  }

  private startRunTracking(playTimeMs = 0, discsBroken = 0): void {
    this.playTime.startFrom(playTimeMs);
    this.discsBrokenThisGame = discsBroken;
    this.displayedDropsThisGame = this.state.dropCount;
    this.displayedDiscsBrokenThisGame = discsBroken;
    if (document.visibilityState !== 'visible') this.playTime.pause('backgrounded');
  }

  private toggleSound(): void {
    this.homeScreen.setSoundEnabled(this.audio.toggleEnabled());
  }

  private toggleAdvancedHud(): void {
    this.advancedHudEnabled = !this.advancedHudEnabled;
    this.userSettings.setAdvancedHud(this.advancedHudEnabled);
    this.homeScreen.setAdvancedHudEnabled(this.advancedHudEnabled);
  }

  private openDebugPanel(): void {
    if (this.homeScreen.isGameMenuOpen()) this.resumeGame();
    this.debug.open();
  }

  private forceGameOver(): void {
    if (this.activeTutorial
      || this.state.phase === GamePhase.Menu
      || this.state.phase === GamePhase.GameOver) return;
    this.setGameOver();
  }

  private pausePlayback(): void {
    this.session.pause();
  }

  private resumePlayback(): void {
    this.session.resume();
  }

  destroy(): void {
    cancelAnimationFrame(this.rafId);
    window.removeEventListener('focus', this.refreshSavesOnFocus);
    document.removeEventListener('visibilitychange', this.handleVisibilityChange);
    this.unsubscribeStatsStore?.();
    this.unsubscribeSaveStore?.();
    this.savedGameDialog.hide();
    this.rewindDialog.hide();
    this.advancedStatsDialog.close();
    this.input.destroy();
    this.gameControls.destroy();
    this.gameHud.destroy();
  }

  private loop(now: DOMHighResTimeStamp): void {
    this.rafId = requestAnimationFrame(this.loop);
    this.session.tick(now);
    const view = this.session.view;
    const rewindPreview = view.rewindPreview;
    this.gameControls.render({
      phase: this.state.phase,
      hasGravity: this.mode.rules.placement.kind === 'stage-and-tilt@1',
      hasRewind: rewindModifier(this.mode.rules) !== undefined,
      canRewind: this.session.canRewind(),
      cursorLane: this.state.cursorCol,
      laneCount: view.laneCount,
      axis: view.axis,
      canConfirmTilt: view.canConfirmTilt,
      needsTilt: view.needsTilt,
      disabled: this.homeScreen.isGameMenuOpen() || view.paused,
      isRewindPreview: Boolean(rewindPreview),
    });
    this.gameHud.render({
      phase: this.state.phase,
      score: rewindPreview?.score ?? view.displayedScore,
      highScore: Math.max(this.stats.highScore, rewindPreview?.score ?? this.state.score),
      bestRecord: Math.max(
        this.stats.longestStreak,
        rewindPreview
          ? (view.rewindLongestStreaks[
            view.rewindLongestStreaks.length - rewindPreview.turnsRewound
          ] ?? view.longestStreak)
          : view.longestStreak,
      ),
      currentDisc: rewindPreview
        ? { ...this.state.currentDisc, ...rewindPreview.currentDisc }
        : this.state.currentDisc,
      nextDisc: rewindPreview
        ? { ...this.state.nextDisc, ...rewindPreview.nextDisc }
        : this.state.nextDisc,
      level: rewindPreview?.level ?? view.displayedLevelProgress.level,
      initialTurnsPerLevel: this.mode.rules.progression.initialTurnsPerLevel,
      turnsPerLevel: rewindPreview?.turnsPerLevel ?? view.displayedLevelProgress.turnsPerLevel,
      turnsRemaining: rewindPreview?.turnsRemaining ?? view.displayedLevelProgress.turnsRemaining,
      turnPipCapacity: TURN_PIP_CAPACITY,
      ...(this.advancedHudEnabled && !this.activeTutorial
        ? {
            advancedStats: {
              playTimeMs: this.playTime.peek(),
              discsDropped: this.displayedDropsThisGame,
              discsBroken: this.displayedDiscsBrokenThisGame,
            },
          }
        : {}),
      hasGravity: this.mode.rules.placement.kind === 'stage-and-tilt@1',
      hasRewind: rewindModifier(this.mode.rules) !== undefined,
      isRewindPreview: Boolean(rewindPreview),
      instability: rewindPreview?.instabilityAfter ?? this.state.paradox?.instability,
      criticalInstability: rewindModifier(this.mode.rules)?.criticalInstability,
      turnCost: turnCostForInstability(
        this.mode.rules,
        rewindPreview?.instabilityAfter ?? this.state.paradox?.instability ?? 0,
      ),
      gravityAngle: this.state.gravity?.angle,
      gravityTurnStartAngle: this.state.gravity?.turnStartAngle,
      gravityMaxTiltDelta: this.state.gravity?.maxTiltDelta,
      needsTilt: view.needsTilt,
      canConfirmTilt: view.canConfirmTilt,
      isStackMode: this.isStackMode(),
      currentStack: view.activeStack,
      stackCascadeActive: view.stackCascadeActive,
      lastStackScore: view.lastStackScore,
    });
    const tutorialStep = this.currentTutorialStep();
    // While a tilt is in progress, show how the board WOULD land at the
    // current angle rather than its actual (untouched) committed state —
    // this is a pure preview, recomputed every frame, nothing is mutated
    // until the tilt is confirmed.
    const boardToDraw = rewindPreview?.board
      ?? (this.state.phase === GamePhase.Aiming
        ? this.session.previewSettledBoard()
        : view.visualBoard);
    // Gravity mode's ghost preview shows the TRUE predicted landing cell
    // (not just the entry edge) so a drop's outcome is never a surprise —
    // only meaningful while a lane is actually selectable.
    const previewLanding = this.state.phase === GamePhase.WaitingForDrop
      && this.mode.rules.placement.kind === 'stage-and-tilt@1'
      ? this.session.previewDropLanding(this.state.cursorCol)
      : null;
    const renderState = rewindPreview
      ? { ...this.state, phase: GamePhase.Animating }
      : this.state;
    this.renderer.draw(
      renderState,
      boardToDraw,
      view.animations,
      this.stats,
      view.scorePopups,
      view.scoreIndicators,
      tutorialStep
        ? {
            allowedCols: tutorialStep.allowedCols,
            staged: this.state.phase === GamePhase.Aiming,
            needsTilt: view.needsTilt,
          }
        : null,
      previewLanding,
      this.isStackMode(),
      view.gravityShiftCue,
      rewindPreview ? { targets: rewindPreview.fractures } : null,
    );
  }

  private isStackMode(): boolean {
    return this.mode.rules.scoring.kind === 'stack-score@1';
  }
}

/** Application shell for the currently shipped solo product. */
export class Game {
  private readonly solo: SoloSessionController;

  constructor(canvas: HTMLCanvasElement, mounts?: UiMounts, zoomControls?: ZoomControls) {
    this.solo = new SoloSessionController(canvas, mounts, zoomControls);
  }

  handleResize(): void {
    this.solo.handleResize();
  }

  destroy(): void {
    this.solo.destroy();
  }
}
