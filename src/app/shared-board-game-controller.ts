import { StepKind } from '../game/events.js';
import type { PhysicsStep } from '../game/events.js';
import { SHARED_DUEL_MODE } from '../game/modes/index.js';
import { DiscKind } from '../game/model.js';
import { computeOwnerScoreDelta } from '../game/scoring/owner-attribution.js';
import type { Board, Disc, GridPos } from '../game/model.js';
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
import type { WireBoard, WireDisc, WireDiscKind, WireGridPos, WireStep } from '../shared/multiplayer-contracts.js';
import { releaseGameplayFocus } from '../ui/dom-utils.js';
import { GameControls } from '../ui/game-controls.js';
import { GameHud } from '../ui/game-hud.js';
import { MultiplayerChat } from '../ui/multiplayer-chat.js';
import { MultiplayerPauseMenu } from '../ui/multiplayer-pause-menu.js';
import { MultiplayerRoomOverlay } from '../ui/multiplayer-room-overlay.js';
import { SharedBoardHud } from '../ui/shared-board-hud.js';
import { setGridSize } from '../ui/rendering/layout.js';
import { AnimationQueue, spawnScoreIndicator, tickScoreIndicators, tickScorePopups } from '../ui/rendering/animation-queue.js';
import type { ScoreIndicator, ScorePopup } from '../ui/rendering/animation-types.js';
import { Renderer } from '../ui/rendering/renderer.js';
import type { UiMounts } from '../ui/ui-root.js';
import type { ZoomControls } from '../ui/zoom-controls.js';
import { formatMultiplier } from './format.js';
import {
  admissionErrorText,
  forgetAdmission,
  privateRoomUrl,
  readAdmission,
  retainAdmission,
} from './multiplayer-admission-store.js';
import { applyStepToVisualBoard } from './visual-board.js';
import { SharedBoardSessionController } from './shared-board-session-controller.js';
import type { SharedBoardSessionView } from './shared-board-session-controller.js';
import type { MultiplayerPhase } from './multiplayer-view-types.js';

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
  #chat: MultiplayerChat | null = null;
  #input: InputHandler | null = null;
  #unsubTransportError: (() => void) | null = null;
  #transportError: MultiplayerTransportError | null = null;
  #animQueue: AnimationQueue | null = null;
  #visualBoard: Board | null = null;
  #lastFrameTime: DOMHighResTimeStamp | null = null;
  #turnIndicators: ScoreIndicator[] = [];
  #scorePopups: ScorePopup[] = [];
  // Lag behind session.view.localScore/opponentScore during playback so the
  // scoreboard ticks up with the clear animation instead of jumping the
  // instant the turn-played message arrives — same authority/presentation
  // split as solo's LocalBoardSession.displayedScore. Rewound on pickup,
  // ticked per Clear/Bonus step, and snapped to truth whenever nothing is
  // animating (queue completion, forced abandonment, or no turn yet).
  #displayedLocalScore = 0;
  #displayedOpponentScore = 0;
  #wasMyTurn = false;
  #frameId: number | null = null;
  #destroyed = false;

  constructor(canvas: HTMLCanvasElement, mounts: UiMounts, zoomControls?: ZoomControls) {
    this.#canvas = canvas;
    this.#mounts = mounts;
    this.#roomOverlay = new MultiplayerRoomOverlay('DISCO DUEL', mounts.overlays);
    this.#pauseMenu = new MultiplayerPauseMenu(mounts.overlays, mounts.modalBackground);
    this.#pauseMenu.onRequestOpen = () => this.#session?.requestPause(true);
    this.#pauseMenu.onRequestResume = () => this.#session?.requestPause(false);
    this.#pauseMenu.onRequestForfeit = () => this.#session?.forfeit();
    this.#pauseMenu.onRequestExportDiagnostics = () => this.#exportDiagnostics();
    this.#pauseMenu.onRequestToggleSound = () => {
      this.#pauseMenu.setSoundEnabled(this.#audio.toggleEnabled());
    };
    this.#pauseMenu.onRequestToggleAdvancedHud = () => {
      const enabled = !this.#userSettings.get().advancedHud;
      this.#userSettings.setAdvancedHud(enabled);
      this.#pauseMenu.setAdvancedHudEnabled(enabled);
    };
    if (zoomControls) {
      this.#pauseMenu.onRequestZoomIn = () => zoomControls.zoomIn();
      this.#pauseMenu.onRequestZoomOut = () => zoomControls.zoomOut();
      this.#pauseMenu.onRequestZoomReset = () => zoomControls.resetZoom();
      zoomControls.onScaleChange = scale => this.#pauseMenu.updateZoomState(scale);
      this.#pauseMenu.updateZoomState(zoomControls.getScale());
    }
    this.#pauseMenu.setSoundEnabled(this.#audio.isEnabled());
    this.#pauseMenu.setAdvancedHudEnabled(this.#userSettings.get().advancedHud);
    void this.#initialize();
  }

  static async create(canvas: HTMLCanvasElement, mounts: UiMounts, zoomControls?: ZoomControls): Promise<SharedBoardGame> {
    return new SharedBoardGame(canvas, mounts, zoomControls);
  }

  async #initialize(): Promise<void> {
    const api = new MultiplayerApiClient();
    try {
      const admission = await this.#resolveAdmission(api);
      // The only suspension point in this method — everything from here on
      // is synchronous, so one check dominates every write it guards
      // against (retaining admission, history, constructing transport/
      // session, mounting UI, scheduling the loop).
      if (this.#destroyed) return;
      if (!retainAdmission(SHARED_DUEL_MODE, admission)) throw new Error('invalid-admission');
      const inviteUrl = privateRoomUrl(admission.roomId, SHARED_DUEL_MODE.id);
      history.replaceState(null, '', inviteUrl);

      const mode = SHARED_DUEL_MODE;
      const roomId = admission.roomId;
      const playerId = admission.playerId;

      this.#transport = new WebSocketMultiplayerTransport(api.baseUrl, admission);
      this.#unsubTransportError = this.#transport.subscribeError((error: MultiplayerTransportError) => {
        this.#transportError = error;
        if (error === 'invalid-credential') forgetAdmission(SHARED_DUEL_MODE, roomId);
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
      this.#chat = new MultiplayerChat(this.#mounts.overlays);
      this.#chat.setOnSend(text => this.#session?.sendChat(text) ?? false);

      this.#input = new InputHandler(
        this.#canvas,
        (intent: InputIntent) => this.#handleIntent(intent),
        () => this.#session?.view.columnCursor ?? 3,
        () => 'col' as const,
      );

      if (this.#destroyed) return;
      this.#frameId = requestAnimationFrame(this.#loop);
    } catch (error) {
      if (this.#destroyed) return;
      this.#roomOverlay.renderError(admissionErrorText(error));
    }
  }

  handleResize(): void {
    this.#renderer?.resize();
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    if (this.#frameId !== null) {
      cancelAnimationFrame(this.#frameId);
      this.#frameId = null;
    }
    this.#unsubTransportError?.();
    this.#unsubTransportError = null;
    this.#input?.destroy();
    this.#input = null;
    this.#controls?.destroy();
    this.#controls = null;
    this.#gameHud?.destroy();
    this.#gameHud = null;
    this.#sharedBoardHud?.destroy();
    this.#sharedBoardHud = null;
    this.#chat?.destroy();
    this.#chat = null;
    this.#session?.destroy();
    this.#session = null;
    this.#transport?.destroy();
    this.#transport = null;
    this.#roomOverlay.destroy();
    this.#pauseMenu.destroy();
    this.#audio.dispose();
    this.#renderer = null;
    this.#animQueue = null;
    this.#visualBoard = null;
  }

  #loop = (now: DOMHighResTimeStamp): void => {
    if (this.#destroyed) return;
    const session = this.#session;
    if (!session) return;

    session.tick();
    const view = session.view;

    // A status that corrected state past what's currently animating (a
    // missed revision, or the forced resync right after reconnect) must
    // win over finishing that stale animation — discard before picking up
    // any new pending turn result below.
    if (session.consumeAnimationDiscard()) {
      this.#animQueue = null;
      this.#visualBoard = null;
      // A resync has already snapped to the resolved board, so it reaches the
      // same usable visual state as a naturally completed animation.
      session.completeTurnAnimation();
    }

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
      console.warn(
        `[shared-duel] animation abandoned: frame gap ${Math.round(sinceLastFrame)}ms exceeded ${STALE_FRAME_GAP_MS}ms (tab backgrounded/throttled, not a network event)`,
      );
      this.#animQueue = null;
      this.#visualBoard = null;
      // Do not make a refocused player wait for the server fallback once the
      // stale animation has been intentionally replaced by the real board.
      session.completeTurnAnimation();
    }

    const pending = session.consumePendingTurnResult();
    if (pending) {
      const attribution = pending.triggerPlayerId === view.playerId ? 'YOU' : 'OPPONENT';
      // Rewind to how the score stood before this turn's award, mirroring
      // solo's `displayedScore = state.score - result.scoreAwarded` — the
      // session already applied triggerScoreDelta/opponentScoreDelta to
      // view.localScore/opponentScore the instant the message arrived.
      const [localDelta, opponentDelta] = attribution === 'YOU'
        ? [pending.triggerScoreDelta, pending.opponentScoreDelta]
        : [pending.opponentScoreDelta, pending.triggerScoreDelta];
      this.#displayedLocalScore = view.localScore - localDelta;
      this.#displayedOpponentScore = view.opponentScore - opponentDelta;
      this.#visualBoard = wireBoardToBoard(pending.boardBefore);
      this.#animQueue = new AnimationQueue(
        pending.steps.map(wireStepToPhysicsStep),
        (step, stepNow) => {
          if (step.kind !== StepKind.Clear) return;
          // Split this step's award between local/opponent the same way the
          // server did for the turn total (computeOwnerScoreDelta handles
          // owner shares, steals, and the trigger bonus) — reusing the
          // authoritative function per-step keeps the running tick faithful
          // to the eventual total instead of drifting from a hand-rolled sum.
          if (view.opponentPlayerId && SHARED_DUEL_MODE.session.kind === 'shared-board-duel@1') {
            const stepDelta = computeOwnerScoreDelta([step], {
              triggerPlayerId: pending.triggerPlayerId,
              opponentPlayerId: view.opponentPlayerId,
              disruptionThreshold: SHARED_DUEL_MODE.session.disruptionThreshold,
            });
            if (attribution === 'YOU') {
              this.#displayedLocalScore += stepDelta.triggerDelta;
              this.#displayedOpponentScore += stepDelta.opponentDelta;
            } else {
              this.#displayedOpponentScore += stepDelta.triggerDelta;
              this.#displayedLocalScore += stepDelta.opponentDelta;
            }
          }
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
        () => {
          this.#animQueue = null;
          // Only the player selected for the next turn has an activation
          // revision; their acknowledgement opens the authoritative clock.
          session.completeTurnAnimation();
        },
      );
    }
    this.#animQueue?.tick(now);
    // Convergence safety net: whenever nothing is animating — the queue just
    // finished, got discarded/abandoned above, or no turn has been picked up
    // yet (fresh match, or a reconnect that restored a nonzero score with no
    // animation to replay) — the displayed score must exactly match truth.
    if (!this.#animQueue) {
      this.#displayedLocalScore = view.localScore;
      this.#displayedOpponentScore = view.opponentScore;
    }

    this.#scorePopups = tickScorePopups(this.#scorePopups, now);

    this.#renderControls(view);
    this.#renderHud(view);
    const diagnostics = this.#transport?.diagnostics ?? null;
    session.setActivationDiagnosticsRtt(diagnostics?.rttMs ?? null);
    this.#sharedBoardHud?.render({
      phase: view.phase,
      remainingMs: view.remainingMs,
      localScore: this.#displayedLocalScore,
      opponentScore: this.#displayedOpponentScore,
      isMyTurn: view.isMyTurn,
      turnSubmissionPending: view.turnSubmissionPending,
      turnActivationPending: view.turnActivationPending,
      result: view.result,
      compatibilityError: view.compatibilityError,
      pingMs: diagnostics?.rttMs ?? null,
      connectionStale: diagnostics?.stale ?? false,
    });
    this.#chat?.render(view.messages, view.playerId, view.connection !== 'connected');
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
      const showLocalGhost = view.phase === 'playing' && view.isMyTurn
        && !view.turnSubmissionPending && !this.#animQueue;
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
        breaksThisLevel: 0,
        entropy: 0,
        balancedLevels: 0,
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
      disabled: !view.isMyTurn || view.turnSubmissionPending,
    });
  }

  #exportDiagnostics(): void {
    const session = this.#session;
    if (!session) return;
    const view = session.view;
    const report = {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      mode: view.mode,
      roomId: view.roomId,
      matchId: view.matchId,
      activationDiagnostics: session.activationDiagnostics,
      connection: this.#transport?.diagnostics ?? null,
    };
    const blob = new Blob([`${JSON.stringify(report, null, 2)}\n`], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `disco-duel-diagnostics-${report.exportedAt.replace(/[:.]/g, '-')}.json`;
    link.click();
    URL.revokeObjectURL(link.href);
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
    const retained = readAdmission(SHARED_DUEL_MODE, roomId);
    if (retained) return retained;
    return api.joinRoom(roomId, SHARED_DUEL_MODE);
  }
}

function wireBoardToBoard(wire: WireBoard): Board {
  return wire.map(row =>
    row.map(cell => cell ? wireDiscToDisc(cell) : null),
  ) as Board;
}

// wire.kind is validated against WIRE_DISC_KINDS by parseWireDisc before this
// ever runs — a Record (not a fallback default) so a disc kind added to one
// side without the other becomes a type error here, not a silent mapping to
// Numbered.
const WIRE_DISC_KIND_TO_DISC_KIND: Record<WireDiscKind, DiscKind> = {
  numbered: DiscKind.Numbered,
  'single-cracked': DiscKind.SingleCracked,
  'double-cracked': DiscKind.DoubleCracked,
};

function wireDiscToDisc(wire: WireDisc): Disc {
  const base: Pick<Disc, 'id' | 'value' | 'kind'> = {
    id: wire.id,
    value: wire.value,
    kind: WIRE_DISC_KIND_TO_DISC_KIND[wire.kind],
  };
  if (wire.ownerId !== undefined) {
    return { ...base, ownerId: wire.ownerId };
  }
  return base;
}

function wireGridPosToGridPos(wire: WireGridPos): GridPos {
  return { row: wire.row, col: wire.col };
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
        edge: wire.edge,
        newDiscs: wire.newDiscs.map(wireDiscToDisc),
      };
    case 'bonus':
      return {
        kind: StepKind.Bonus,
        bonusKind: wire.bonusKind,
        pointsAwarded: wire.pointsAwarded,
      };
  }
}

const GAME_PHASE_MAP: Record<MultiplayerPhase, GamePhase> = {
  playing: GamePhase.WaitingForDrop,
  countdown: GamePhase.Menu,
  finished: GamePhase.GameOver,
  disconnected: GamePhase.Menu,
  reconnecting: GamePhase.Menu,
  lobby: GamePhase.Menu,
  ready: GamePhase.Menu,
};

function viewPhaseToGamePhase(phase: MultiplayerPhase): GamePhase {
  return GAME_PHASE_MAP[phase] ?? GamePhase.Menu;
}
