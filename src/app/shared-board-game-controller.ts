import { SHARED_DUEL_MODE } from '../game/modes/index.js';
import { DiscKind } from '../game/model.js';
import type { Board, Disc } from '../game/model.js';
import type { GameState } from '../game/state.js';
import { GamePhase } from '../game/state.js';
import { emptyStats } from '../game/stats.js';
import { InputHandler } from '../platform/input-handler.js';
import type { InputIntent } from '../platform/input-handler.js';
import { MultiplayerApiClient } from '../platform/multiplayer-api-client.js';
import type { MultiplayerAdmission } from '../platform/multiplayer-api-client.js';
import { WebSocketMultiplayerTransport } from '../platform/websocket-multiplayer-transport.js';
import type { MultiplayerTransportError } from '../platform/websocket-multiplayer-transport.js';
import type { WireBoard, WireDisc } from '../shared/multiplayer-contracts.js';
import { GameControls } from '../ui/game-controls.js';
import { GameHud } from '../ui/game-hud.js';
import { MultiplayerRoomOverlay } from '../ui/multiplayer-room-overlay.js';
import { setGridSize } from '../ui/rendering/layout.js';
import { Renderer } from '../ui/rendering/renderer.js';
import type { UiMounts } from '../ui/ui-root.js';
import { SharedBoardSessionController } from './shared-board-session-controller.js';
import type { SharedBoardSessionView, SharedBoardPhase } from './shared-board-session-controller.js';

const ADMISSION_STORAGE_PREFIX = 'disco_multiplayer_admission:';

export class SharedBoardGame {
  readonly #canvas: HTMLCanvasElement;
  readonly #mounts: UiMounts;
  readonly #roomOverlay: MultiplayerRoomOverlay;
  #transport: WebSocketMultiplayerTransport | null = null;
  #session: SharedBoardSessionController | null = null;
  #renderer: Renderer | null = null;
  #controls: GameControls | null = null;
  #gameHud: GameHud | null = null;
  #input: InputHandler | null = null;
  #unsubTransportError: (() => void) | null = null;
  #transportError: MultiplayerTransportError | null = null;

  constructor(canvas: HTMLCanvasElement, mounts: UiMounts) {
    this.#canvas = canvas;
    this.#mounts = mounts;
    this.#roomOverlay = new MultiplayerRoomOverlay('DISCO DUEL', mounts.overlays);
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
    this.#session?.destroy();
    this.#transport?.destroy();
    this.#roomOverlay.destroy();
  }

  #loop = (): void => {
    const session = this.#session;
    if (!session) return;

    session.tick();
    const view = session.view;

    this.#renderControls(view);
    this.#renderHud(view);
    this.#roomOverlay.render(view, this.#transportError);

    if (this.#renderer) {
      const board = wireBoardToBoard(view.board);
      const state: GameState = {
        generationSeed: 1,
        generationSource: 'seeded',
        phase: viewPhaseToGamePhase(view.phase),
        board,
        currentDisc: wireDiscToDisc({ value: 0, kind: 'numbered' }),
        nextDisc: wireDiscToDisc({ value: 0, kind: 'numbered' }),
        cursorCol: view.columnCursor,
        score: view.localScore,
        dropCount: 0,
        level: 1,
        turnsPerLevel: 7,
        turnsRemaining: 7,
        gravity: undefined,
        paradox: undefined,
      };
      this.#renderer.draw(state, board, [], emptyStats(), [], []);
    }

    requestAnimationFrame(this.#loop);
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
    const currentDisc = wireDiscToDisc({ value: 0, kind: 'numbered' });
    const nextDisc = wireDiscToDisc({ value: 0, kind: 'numbered' });

    this.#gameHud.render({
      phase: viewPhaseToGamePhase(view.phase),
      score: view.localScore,
      bestRecord: view.opponentScore,
      currentDisc,
      nextDisc,
      level: 1,
      initialTurnsPerLevel: 7,
      turnsPerLevel: 7,
      turnsRemaining: 7,
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
};

let discIdCounter = 0;

function wireDiscToDisc(wire: WireDisc): Disc {
  const base: Pick<Disc, 'id' | 'value' | 'kind'> = {
    id: ++discIdCounter,
    value: wire.value,
    kind: KIND_MAP[wire.kind] ?? DiscKind.Numbered,
  };
  if (wire.ownerId !== undefined) {
    return { ...base, ownerId: wire.ownerId };
  }
  return base;
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
