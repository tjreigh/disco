import { StepKind } from '../game/events.js';
import type { BonusKind, PhysicsStep } from '../game/events.js';
import { SHARED_DUEL_MODE } from '../game/modes/index.js';
import { DiscKind } from '../game/model.js';
import type { Board, Disc, EntryEdge, GridPos } from '../game/model.js';
import type { GameState } from '../game/state.js';
import { GamePhase } from '../game/state.js';
import { emptyStats } from '../game/stats.js';
import { AudioManager } from '../platform/audio-manager.js';
import { InputHandler } from '../platform/input-handler.js';
import type { InputIntent } from '../platform/input-handler.js';
import { MultiplayerApiClient } from '../platform/multiplayer-api-client.js';
import type { MultiplayerAdmission } from '../platform/multiplayer-api-client.js';
import { UserSettingsStore } from '../platform/user-settings-store.js';
import { WebSocketMultiplayerTransport } from '../platform/websocket-multiplayer-transport.js';
import type { MultiplayerTransportError } from '../platform/websocket-multiplayer-transport.js';
import type { WireBoard, WireDisc, WireGridPos, WireStep } from '../shared/multiplayer-contracts.js';
import { GameControls } from '../ui/game-controls.js';
import { GameHud } from '../ui/game-hud.js';
import { MultiplayerPauseMenu } from '../ui/multiplayer-pause-menu.js';
import { MultiplayerRoomOverlay } from '../ui/multiplayer-room-overlay.js';
import { SharedBoardHud } from '../ui/shared-board-hud.js';
import { setGridSize } from '../ui/rendering/layout.js';
import { AnimationQueue, spawnScoreIndicator, tickScoreIndicators, tickScorePopups } from '../ui/rendering/animation-queue.js';
import type { ScoreIndicator, ScorePopup } from '../ui/rendering/animation-types.js';
import { Renderer } from '../ui/rendering/renderer.js';
import type { UiMounts } from '../ui/ui-root.js';
import { applyStepToVisualBoard } from './visual-board.js';
import { SharedBoardSessionController } from './shared-board-session-controller.js';
import type { SharedBoardSessionView, SharedBoardPhase } from './shared-board-session-controller.js';

const ADMISSION_STORAGE_PREFIX = 'disco_multiplayer_admission:';
// Generous relative to any real animation (drop+clear+fall tops out around
// 1-1.5s) — this only fires for a genuine throttled/backgrounded-tab gap.
const STALE_FRAME_GAP_MS = 2_000;

export class SharedBoardGame {
  readonly #canvas: HTMLCanvasElement;
  readonly #mounts: UiMounts;
  readonly #roomOverlay: MultiplayerRoomOverlay;
  readonly #pauseMenu: MultiplayerPauseMenu;
  // Dead controls per product decision: multiplayer has no sound cues or
  // advanced-HUD tracking today, so these back the pause menu's toggles for
  // visual consistency with single-player without doing anything visible
  // here. Advanced HUD still persists globally (single-player will see it
  // next time); sound is a throwaway per-session instance, genuinely inert.
  readonly #audio = new AudioManager();
  readonly #userSettings = new UserSettingsStore();
  #transport: WebSocketMultiplayerTransport | null = null;
  #session: SharedBoardSessionController | null = null;
  #renderer: Renderer | null = null;
  #controls: GameControls | null = null;
  #gameHud: GameHud | null = null;
  #sharedBoardHud: SharedBoardHud | null = null;
  #input: InputHandler | null = null;
  #unsubTransportError: (() => void) | null = null;
  #transportError: MultiplayerTransportError | null = null;
  #animQueue: AnimationQueue | null = null;
  #visualBoard: Board | null = null;
  #lastFrameTime: DOMHighResTimeStamp | null = null;
  #turnIndicators: ScoreIndicator[] = [];
  #scorePopups: ScorePopup[] = [];
  #wasMyTurn = false;

  constructor(canvas: HTMLCanvasElement, mounts: UiMounts) {
    this.#canvas = canvas;
    this.#mounts = mounts;
    this.#roomOverlay = new MultiplayerRoomOverlay('DISCO DUEL', mounts.overlays);
    this.#pauseMenu = new MultiplayerPauseMenu(mounts.overlays, mounts.modalBackground);
    this.#pauseMenu.onRequestOpen = () => this.#session?.requestPause(true);
    this.#pauseMenu.onRequestResume = () => this.#session?.requestPause(false);
    this.#pauseMenu.onRequestForfeit = () => this.#session?.forfeit();
    this.#pauseMenu.onRequestToggleSound = () => {
      this.#pauseMenu.setSoundEnabled(this.#audio.toggleEnabled());
    };
    this.#pauseMenu.onRequestToggleAdvancedHud = () => {
      const enabled = !this.#userSettings.get().advancedHud;
      this.#userSettings.setAdvancedHud(enabled);
      this.#pauseMenu.setAdvancedHudEnabled(enabled);
    };
    this.#pauseMenu.setSoundEnabled(this.#audio.isEnabled());
    this.#pauseMenu.setAdvancedHudEnabled(this.#userSettings.get().advancedHud);
    void this.#initialize();
  }

  static async create(canvas: HTMLCanvasElement, mounts: UiMounts): Promise<SharedBoardGame> {
    return new SharedBoardGame(canvas, mounts);
  }

  async #initialize(): Promise<void> {
    const api = new MultiplayerApiClient();
    try {
      const admission = await this.#resolveAdmission(api);
      this.#retainAdmission(admission);
      const inviteUrl = privateRoomUrl(admission.roomId);
      history.replaceState(null, '', inviteUrl);

      const mode = SHARED_DUEL_MODE;
      const roomId = admission.roomId;
      const playerId = admission.playerId;

      this.#transport = new WebSocketMultiplayerTransport(api.baseUrl, admission);
      this.#unsubTransportError = this.#transport.subscribeError((error: MultiplayerTransportError) => {
        this.#transportError = error;
        if (error === 'invalid-credential') this.#forgetAdmission(roomId);
      });

      this.#session = new SharedBoardSessionController({
        roomId,
        playerId,
        mode,
        clock: { now: () => Date.now() },
        transport: this.#transport,
      });

      this.#roomOverlay.setRoom(roomId, inviteUrl, ready => {
        this.#session?.setReady(ready);
        releaseGameplayFocus();
      });

      setGridSize(mode.rules.board.cols, mode.rules.board.rows);
      this.#renderer = new Renderer(this.#canvas);
      this.#controls = new GameControls(
        intent => this.#handleIntent(intent),
        this.#mounts.controls,
      );
      this.#gameHud = new GameHud(this.#mounts.stage);
      this.#gameHud.root.dataset.multiplayer = 'true';
      this.#sharedBoardHud = new SharedBoardHud('DISCO DUEL', this.#mounts.stage);

      this.#input = new InputHandler(
        this.#canvas,
        (intent: InputIntent) => this.#handleIntent(intent),
        () => this.#session?.view.columnCursor ?? 3,
        () => 'col' as const,
      );

      requestAnimationFrame(this.#loop);
    } catch (error) {
      this.#roomOverlay.renderError(admissionErrorText(error));
    }
  }

  handleResize(): void {
    this.#renderer?.resize();
  }

  destroy(): void {
    this.#unsubTransportError?.();
    this.#input?.destroy();
    this.#controls?.destroy();
    this.#gameHud?.destroy();
    this.#sharedBoardHud?.destroy();
    this.#session?.destroy();
    this.#transport?.destroy();
    this.#roomOverlay.destroy();
    this.#pauseMenu.destroy();
  }

  #loop = (now: DOMHighResTimeStamp): void => {
    const session = this.#session;
    if (!session) return;

    session.tick();
    const view = session.view;

    // Pop up "YOUR TURN" exactly on the edge into it becoming your turn
    // (including the match's opening turn), not on every frame it's true.
    if (view.phase === 'playing' && view.isMyTurn && !this.#wasMyTurn) {
      this.#turnIndicators.push(spawnScoreIndicator('YOUR TURN', '', now));
    }
    this.#wasMyTurn = view.isMyTurn;
    this.#turnIndicators = tickScoreIndicators(this.#turnIndicators, now);

    // The server keeps the match moving regardless of whether this tab is
    // in the foreground, and a backgrounded tab's requestAnimationFrame
    // callbacks can be throttled to a near-stop by the browser — sometimes
    // skipping several turns' worth of wall-clock time between two ticks.
    // An in-flight animation left that stale is abandoned rather than
    // played out: correctness (showing the real board) always wins over
    // finishing a smooth replay of a turn that's long since resolved.
    const sinceLastFrame = this.#lastFrameTime === null ? 0 : now - this.#lastFrameTime;
    this.#lastFrameTime = now;
    if (this.#animQueue && sinceLastFrame > STALE_FRAME_GAP_MS) {
      this.#animQueue = null;
      this.#visualBoard = null;
    }

    const pending = session.consumePendingTurnResult();
    if (pending) {
      const attribution = pending.triggerPlayerId === view.playerId ? 'YOU' : 'OPPONENT';
      this.#visualBoard = wireBoardToBoard(pending.boardBefore);
      this.#animQueue = new AnimationQueue(
        pending.steps.map(wireStepToPhysicsStep),
        (step, stepNow) => {
          if (step.kind !== StepKind.Clear) return;
          const chainLength = step.chainLevel + 1;
          const perDisc = Math.floor(step.pointsAwarded / step.discs.length);
          for (let i = 0; i < step.cleared.length; i++) {
            const pos = step.cleared[i]!;
            const disc = step.discs[i];
            const owner = disc?.ownerId
              ? disc.ownerId === view.playerId ? 'local' as const : 'opponent' as const
              : undefined;
            this.#scorePopups.push({
              value: perDisc, col: pos.col, row: pos.row,
              startTime: stepNow, duration: 800, progress: 0, alpha: 1, yOffset: 0,
              ...(owner !== undefined ? { owner } : {}),
            });
          }
          if (chainLength < 2) return;
          const scoring = SHARED_DUEL_MODE.rules.scoring;
          const multiplier = scoring.kind === 'chain-score@1'
            ? Math.pow(chainLength, scoring.chainExponent)
            : 1;
          this.#turnIndicators.push(spawnScoreIndicator(
            `CHAIN ${chainLength}`,
            `${attribution} · ×${formatMultiplier(multiplier)} +${step.pointsAwarded}`,
            stepNow,
          ));
        },
        step => applyStepToVisualBoard(this.#visualBoard!, step),
        () => { this.#animQueue = null; },
      );
    }
    this.#animQueue?.tick(now);

    this.#scorePopups = tickScorePopups(this.#scorePopups, now);

    this.#renderControls(view);
    this.#renderHud(view);
    this.#sharedBoardHud?.render({
      phase: view.phase,
      remainingMs: view.remainingMs,
      localScore: view.localScore,
      opponentScore: view.opponentScore,
      isMyTurn: view.isMyTurn,
      result: view.result,
      compatibilityError: view.compatibilityError,
    });
    this.#roomOverlay.render(
      { ...view, pausedByLocal: view.pausedBy === view.playerId },
      this.#transportError,
    );

    const canPause = view.phase === 'playing';
    this.#pauseMenu.setCanOpen(canPause);
    if (!canPause && this.#pauseMenu.isOpen()) this.#pauseMenu.forceClose();

    if (this.#renderer) {
      const board = this.#animQueue && this.#visualBoard
        ? this.#visualBoard
        : wireBoardToBoard(view.board);
      // The renderer only shows the local ghost/lane-hover for
      // GamePhase.WaitingForDrop — during the opponent's turn (or while a
      // cascade from either player's last drop is still animating), fall
      // back to Animating so the local ghost doesn't linger at a stale
      // column with nothing to act on.
      const showLocalGhost = view.phase === 'playing' && view.isMyTurn && !this.#animQueue;
      const rendererPhase = view.phase === 'playing' && !showLocalGhost
        ? GamePhase.Animating
        : viewPhaseToGamePhase(view.phase);
      const state: GameState = {
        generationSeed: 1,
        generationSource: 'seeded',
        phase: rendererPhase,
        board,
        currentDisc: wireDiscToDisc(view.currentDisc),
        nextDisc: wireDiscToDisc(view.nextDisc),
        cursorCol: view.columnCursor,
        score: view.localScore,
        dropCount: 0,
        level: view.level,
        turnsPerLevel: view.turnsPerLevel,
        turnsRemaining: view.turnsRemaining,
        gravity: undefined,
        paradox: undefined,
      };
      const opponentCursor = !view.isMyTurn && view.opponentColumnCursor !== null
        ? { col: view.opponentColumnCursor, disc: state.currentDisc }
        : null;
      this.#renderer.draw(
        state, board, this.#animQueue?.getActiveAnimations() ?? [], emptyStats(), this.#scorePopups, this.#turnIndicators,
        null, null, false, null, null, opponentCursor, view.playerId,
      );
    }

    if (!this.#destroyed) this.#frameId = requestAnimationFrame(this.#loop);
  };

  #renderControls(view: SharedBoardSessionView): void {
    this.#controls?.render({
      phase: viewPhaseToGamePhase(view.phase),
      hasGravity: false,
      cursorLane: view.columnCursor,
      laneCount: 7,
      axis: 'col',
      disabled: !view.isMyTurn,
    });
  }

  #renderHud(view: SharedBoardSessionView): void {
    if (!this.#gameHud) return;
    const currentDisc = wireDiscToDisc(view.currentDisc);
    const nextDisc = wireDiscToDisc(view.nextDisc);

    this.#gameHud.render({
      phase: viewPhaseToGamePhase(view.phase),
      score: view.localScore,
      currentDisc,
      nextDisc,
      level: view.level,
      initialTurnsPerLevel: SHARED_DUEL_MODE.rules.progression.initialTurnsPerLevel,
      turnsPerLevel: view.turnsPerLevel,
      turnsRemaining: view.turnsRemaining,
      hasGravity: false,
      hasRestart: false,
    });
  }

  #handleIntent(intent: InputIntent): void {
    const session = this.#session;
    if (!session) return;

    switch (intent.kind) {
      case 'move':
        if (session.view.isMyTurn) {
          session.moveCursor(intent.col);
        }
        break;
      case 'drop':
        if (session.view.isMyTurn) {
          session.playTurn(intent.col);
        }
        break;
    }
  }

  async #resolveAdmission(api: MultiplayerApiClient): Promise<MultiplayerAdmission> {
    const params = new URLSearchParams(location.search);
    if (params.get('multiplayer') === 'create') {
      return api.createRoom(SHARED_DUEL_MODE);
    }
    const roomId = params.get('room')?.trim().toUpperCase();
    if (!roomId) throw new Error('missing-room');
    const retained = this.#readAdmission(roomId);
    if (retained) return retained;
    return api.joinRoom(roomId, SHARED_DUEL_MODE);
  }

  #retainAdmission(admission: MultiplayerAdmission): void {
    try {
      sessionStorage.setItem(
        `${ADMISSION_STORAGE_PREFIX}${admission.roomId}`,
        JSON.stringify(admission),
      );
    } catch { /* quota exceeded */ }
  }

  #readAdmission(roomId: string): MultiplayerAdmission | null {
    try {
      const raw = sessionStorage.getItem(`${ADMISSION_STORAGE_PREFIX}${roomId}`);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as unknown;
      if (!isAdmissionRecord(parsed) || parsed.roomId !== roomId) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  #forgetAdmission(roomId: string): void {
    try {
      sessionStorage.removeItem(`${ADMISSION_STORAGE_PREFIX}${roomId}`);
    } catch { /* */ }
  }
}

function isAdmissionRecord(value: unknown): value is MultiplayerAdmission {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.roomId === 'string'
    && typeof v.playerId === 'string'
    && typeof v.reconnectCredential === 'string'
    && v.mode !== undefined;
}

function privateRoomUrl(roomId: string): string {
  const url = new URL(location.href);
  url.search = '';
  url.searchParams.set('room', roomId);
  url.searchParams.set('mode', SHARED_DUEL_MODE.id);
  url.hash = '';
  return url.toString();
}

function admissionErrorText(error: unknown): string {
  if (error instanceof Error && error.message === 'missing-room') {
    return 'The private room link is missing a room code.';
  }
  if (typeof error === 'object' && error !== null && 'status' in error) {
    const status = (error as { status?: unknown }).status;
    if (status === 404) return 'This private room no longer exists.';
    if (status === 409) return 'This private room is full or uses a different game version.';
    if (status === 429) return 'Too many room attempts. Wait a moment and try again.';
  }
  return 'Could not reach the multiplayer service. Return home and try again.';
}

function releaseGameplayFocus(): void {
  if (document.activeElement instanceof HTMLElement && document.activeElement.tabIndex >= 0) {
    document.activeElement.blur();
  }
}

function wireBoardToBoard(wire: WireBoard): Board {
  return wire.map(row =>
    row.map(cell => cell ? wireDiscToDisc(cell) : null),
  ) as Board;
}

const KIND_MAP: Record<string, DiscKind> = {
  numbered: DiscKind.Numbered,
  'single-cracked': DiscKind.SingleCracked,
  'double-cracked': DiscKind.DoubleCracked,
};

function wireDiscToDisc(wire: WireDisc): Disc {
  const base: Pick<Disc, 'id' | 'value' | 'kind'> = {
    id: wire.id,
    value: wire.value,
    kind: KIND_MAP[wire.kind] ?? DiscKind.Numbered,
  };
  if (wire.ownerId !== undefined) {
    return { ...base, ownerId: wire.ownerId };
  }
  return base;
}

function wireGridPosToGridPos(wire: WireGridPos): GridPos {
  return { row: wire.row, col: wire.col };
}

function formatMultiplier(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function wireStepToPhysicsStep(wire: WireStep): PhysicsStep {
  switch (wire.kind) {
    case 'drop':
      return {
        kind: StepKind.Drop,
        disc: wireDiscToDisc(wire.disc),
        entryPos: wireGridPosToGridPos(wire.entryPos),
        landPos: wireGridPosToGridPos(wire.landPos),
      };
    case 'clear':
      return {
        kind: StepKind.Clear,
        cleared: wire.cleared.map(wireGridPosToGridPos),
        discs: wire.discs.map(wireDiscToDisc),
        chainLevel: wire.chainLevel,
        pointsAwarded: wire.pointsAwarded,
      };
    case 'fall':
      return {
        kind: StepKind.Fall,
        moves: wire.moves.map(move => ({
          from: wireGridPosToGridPos(move.from),
          to: wireGridPosToGridPos(move.to),
          disc: wireDiscToDisc(move.disc),
        })),
      };
    case 'reveal':
      return {
        kind: StepKind.Reveal,
        positions: wire.positions.map(wireGridPosToGridPos),
        discs: wire.discs.map(wireDiscToDisc),
      };
    case 'push':
      return {
        kind: StepKind.Push,
        edge: wire.edge as EntryEdge,
        newDiscs: wire.newDiscs.map(wireDiscToDisc),
      };
    case 'bonus':
      return {
        kind: StepKind.Bonus,
        bonusKind: wire.bonusKind as BonusKind,
        pointsAwarded: wire.pointsAwarded,
      };
  }
}

const GAME_PHASE_MAP: Record<SharedBoardPhase, GamePhase> = {
  playing: GamePhase.WaitingForDrop,
  countdown: GamePhase.Menu,
  finished: GamePhase.GameOver,
  disconnected: GamePhase.Menu,
  reconnecting: GamePhase.Menu,
  lobby: GamePhase.Menu,
  ready: GamePhase.Menu,
};

function viewPhaseToGamePhase(phase: SharedBoardPhase): GamePhase {
  return GAME_PHASE_MAP[phase] ?? GamePhase.Menu;
}
