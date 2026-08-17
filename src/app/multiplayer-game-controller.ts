import { SCORE_RACE_MODE } from '../game/modes/score-race.js';
import { emptyStats } from '../game/stats.js';
import type { GameStats } from '../game/stats.js';
import { AudioManager } from '../platform/audio-manager.js';
import { InputHandler } from '../platform/input-handler.js';
import type { InputIntent } from '../platform/input-handler.js';
import {
  MultiplayerApiClient,
} from '../platform/multiplayer-api-client.js';
import type {
  MultiplayerAdmission,
} from '../platform/multiplayer-api-client.js';
import { UserSettingsStore } from '../platform/user-settings-store.js';
import {
  WebSocketMultiplayerTransport,
} from '../platform/websocket-multiplayer-transport.js';
import type {
  MultiplayerTransportError,
} from '../platform/websocket-multiplayer-transport.js';
import { releaseGameplayFocus } from '../ui/dom-utils.js';
import { GameControls } from '../ui/game-controls.js';
import { GameHud } from '../ui/game-hud.js';
import { MultiplayerChat } from '../ui/multiplayer-chat.js';
import { MultiplayerHud } from '../ui/multiplayer-hud.js';
import { MultiplayerPauseMenu } from '../ui/multiplayer-pause-menu.js';
import { MultiplayerRoomOverlay } from '../ui/multiplayer-room-overlay.js';
import { setGridSize } from '../ui/rendering/layout.js';
import { Renderer } from '../ui/rendering/renderer.js';
import type { UiMounts } from '../ui/ui-root.js';
import type { ZoomControls } from '../ui/zoom-controls.js';
import {
  admissionErrorText,
  forgetAdmission,
  privateRoomUrl,
  readAdmission,
  retainAdmission,
} from './multiplayer-admission-store.js';
import {
  MultiplayerSessionController,
} from './multiplayer-session-controller.js';

/**
 * Browser composition for the first playable private Score Race.
 *
 * Solo and multiplayer deliberately have separate presentation controllers;
 * they share the board session, renderer, HUD, controls, and input primitives.
 */
export class MultiplayerGame {
  private readonly canvas: HTMLCanvasElement;
  private readonly mounts: UiMounts;
  private readonly roomOverlay: MultiplayerRoomOverlay;
  private readonly pauseMenu: MultiplayerPauseMenu;
  // Dead controls per product decision: multiplayer has no sound cues or
  // advanced-HUD tracking today, so these back the pause menu's toggles for
  // visual consistency with single-player without doing anything visible
  // here. Advanced HUD still persists globally (single-player will see it
  // next time); sound is a throwaway per-session instance, genuinely inert.
  private readonly audio = new AudioManager();
  private readonly userSettings = new UserSettingsStore();
  private readonly stats: GameStats = emptyStats();
  private renderer: Renderer | null = null;
  private session: MultiplayerSessionController | null = null;
  private transport: WebSocketMultiplayerTransport | null = null;
  private input: InputHandler | null = null;
  private controls: GameControls | null = null;
  private gameHud: GameHud | null = null;
  private multiplayerHud: MultiplayerHud | null = null;
  private chat: MultiplayerChat | null = null;
  private unsubscribeTransportError: (() => void) | null = null;
  private transportError: MultiplayerTransportError | null = null;
  private rafId = 0;

  static async create(canvas: HTMLCanvasElement, mounts: UiMounts, zoomControls?: ZoomControls): Promise<MultiplayerGame> {
    const game = new MultiplayerGame(canvas, mounts, zoomControls);
    await game.initialize();
    return game;
  }

  private constructor(canvas: HTMLCanvasElement, mounts: UiMounts, zoomControls?: ZoomControls) {
    this.canvas = canvas;
    this.mounts = mounts;
    this.roomOverlay = new MultiplayerRoomOverlay('SCORE RACE', mounts.overlays);
    this.pauseMenu = new MultiplayerPauseMenu(mounts.overlays, mounts.modalBackground);
    this.pauseMenu.onRequestOpen = () => this.session?.requestPause(true);
    this.pauseMenu.onRequestResume = () => this.session?.requestPause(false);
    this.pauseMenu.onRequestForfeit = () => this.session?.forfeit();
    this.pauseMenu.onRequestToggleSound = () => {
      this.pauseMenu.setSoundEnabled(this.audio.toggleEnabled());
    };
    this.pauseMenu.onRequestToggleAdvancedHud = () => {
      const enabled = !this.userSettings.get().advancedHud;
      this.userSettings.setAdvancedHud(enabled);
      this.pauseMenu.setAdvancedHudEnabled(enabled);
    };
    if (zoomControls) {
      this.pauseMenu.onRequestZoomIn = () => zoomControls.zoomIn();
      this.pauseMenu.onRequestZoomOut = () => zoomControls.zoomOut();
      this.pauseMenu.onRequestZoomReset = () => zoomControls.resetZoom();
      zoomControls.onScaleChange = scale => this.pauseMenu.updateZoomState(scale);
      this.pauseMenu.updateZoomState(zoomControls.getScale());
    }
    this.pauseMenu.setSoundEnabled(this.audio.isEnabled());
    this.pauseMenu.setAdvancedHudEnabled(this.userSettings.get().advancedHud);
    document.title = 'Disco — Score Race';
  }

  handleResize(): void {
    this.renderer?.resize();
  }

  destroy(): void {
    cancelAnimationFrame(this.rafId);
    this.unsubscribeTransportError?.();
    this.input?.destroy();
    this.controls?.destroy();
    this.gameHud?.destroy();
    this.multiplayerHud?.destroy();
    this.chat?.destroy();
    this.session?.destroy();
    this.transport?.destroy();
    this.roomOverlay.destroy();
    this.pauseMenu.destroy();
  }

  private async initialize(): Promise<void> {
    const api = new MultiplayerApiClient();
    try {
      const admission = await this.resolveAdmission(api);
      if (!retainAdmission(SCORE_RACE_MODE, admission)) throw new Error('invalid-admission');
      const inviteUrl = privateRoomUrl(admission.roomId, SCORE_RACE_MODE.id);
      history.replaceState(null, '', inviteUrl);

      this.transport = new WebSocketMultiplayerTransport(api.baseUrl, admission);
      this.unsubscribeTransportError = this.transport.subscribeError(error => {
        this.transportError = error;
        if (error === 'invalid-credential') forgetAdmission(SCORE_RACE_MODE, admission.roomId);
      });
      this.session = new MultiplayerSessionController({
        roomId: admission.roomId,
        playerId: admission.playerId,
        mode: SCORE_RACE_MODE,
        clock: { now: () => Date.now() },
        transport: this.transport,
      });
      this.roomOverlay.setRoom(
        admission.roomId,
        inviteUrl,
        ready => {
          this.session?.setReady(ready);
          releaseGameplayFocus();
        },
      );

      setGridSize(SCORE_RACE_MODE.rules.board.cols, SCORE_RACE_MODE.rules.board.rows);
      this.renderer = new Renderer(this.canvas);
      this.controls = new GameControls(
        intent => this.handleIntent(intent),
        this.mounts.controls,
      );
      this.gameHud = new GameHud(this.mounts.stage);
      this.gameHud.root.dataset.multiplayer = 'true';
      this.multiplayerHud = new MultiplayerHud(this.mounts.stage);
      this.chat = new MultiplayerChat(this.mounts.overlays);
      this.chat.setOnSend(text => this.session?.sendChat(text) ?? false);
      this.input = new InputHandler(
        this.canvas,
        intent => this.handleIntent(intent),
        () => this.session?.view.board.state.cursorCol ?? 0,
        () => this.session?.view.board.axis ?? 'col',
      );
      this.loop();
    } catch (error) {
      this.roomOverlay.renderError(admissionErrorText(error));
    }
  }

  private async resolveAdmission(api: MultiplayerApiClient): Promise<MultiplayerAdmission> {
    const params = new URLSearchParams(location.search);
    if (params.get('multiplayer') === 'create') {
      return await api.createRoom(SCORE_RACE_MODE);
    }

    const roomId = params.get('room')?.trim().toUpperCase();
    if (!roomId) throw new Error('missing-room');
    const retained = readAdmission(SCORE_RACE_MODE, roomId);
    if (retained) return retained;
    return await api.joinRoom(roomId, SCORE_RACE_MODE);
  }

  private handleIntent(intent: InputIntent): void {
    const session = this.session;
    if (!session) return;
    switch (intent.kind) {
      case 'move':
        session.move(intent.col);
        break;
      case 'drop':
        session.drop(intent.col);
        break;
      case 'tilt':
      case 'cancel':
      case 'rewind':
      case 'restart':
        break;
    }
    releaseGameplayFocus();
  }

  private readonly loop = (): void => {
    const session = this.session;
    const renderer = this.renderer;
    const controls = this.controls;
    const gameHud = this.gameHud;
    const multiplayerHud = this.multiplayerHud;
    const chat = this.chat;
    if (!session || !renderer || !controls || !gameHud || !multiplayerHud || !chat) return;

    this.rafId = requestAnimationFrame(this.loop);
    session.tick();
    const view = session.view;
    const board = view.board;
    const state = board.state;
    this.stats.highScore = Math.max(this.stats.highScore, state.score);
    this.stats.longestStreak = Math.max(this.stats.longestStreak, board.longestStreak);

    controls.render({
      phase: state.phase,
      hasGravity: false,
      cursorLane: state.cursorCol,
      laneCount: board.laneCount,
      axis: board.axis,
      disabled: view.phase !== 'playing' || view.connection !== 'connected' || view.paused,
    });
    gameHud.render({
      phase: state.phase,
      score: board.displayedScore,
      highScore: this.stats.highScore,
      bestRecord: this.stats.longestStreak,
      currentDisc: state.currentDisc,
      nextDisc: state.nextDisc,
      level: board.displayedLevelProgress.level,
      initialTurnsPerLevel: SCORE_RACE_MODE.rules.progression.initialTurnsPerLevel,
      turnsPerLevel: board.displayedLevelProgress.turnsPerLevel,
      turnsRemaining: board.displayedLevelProgress.turnsRemaining,
      hasGravity: false,
      hasRestart: false,
    });
    multiplayerHud.render({
      phase: view.phase,
      remainingMs: view.remainingMs,
      localScore: board.displayedScore,
      opponent: view.opponent,
      result: view.result,
      compatibilityError: view.compatibilityError,
    });
    this.roomOverlay.render(
      { ...view, pausedByLocal: view.pausedBy === view.playerId },
      this.transportError,
    );
    chat.render(view.messages, view.playerId, view.connection !== 'connected');

    const canPause = view.phase === 'playing';
    this.pauseMenu.setCanOpen(canPause);
    if (!canPause && this.pauseMenu.isOpen()) this.pauseMenu.forceClose();

    renderer.draw(
      state,
      board.visualBoard,
      board.animations,
      this.stats,
      board.scorePopups,
      board.scoreIndicators,
    );
  };
}
