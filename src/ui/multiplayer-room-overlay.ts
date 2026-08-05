import type {
  MultiplayerConnectionState,
  MultiplayerLocalResult,
} from '../shared/multiplayer-contracts.js';
import type {
  MultiplayerTransportError,
} from '../platform/websocket-multiplayer-transport.js';
import { blurOnClick, cloneTemplate, mustQuery } from './dom-utils.js';

// Score Race and Disco Duel sessions both project this exact phase/error
// shape (see MultiplayerLocalPhase / MultiplayerCompatibilityError in
// multiplayer-session-controller.ts and SharedBoardPhase /
// SharedBoardCompatibilityError in shared-board-session-controller.ts).
// Defined independently here, rather than imported from either controller,
// so this overlay stays a shared, mode-agnostic UI component.
export type RoomOverlayPhase =
  | 'lobby'
  | 'ready'
  | 'countdown'
  | 'playing'
  | 'finished'
  | 'disconnected'
  | 'reconnecting';

export type RoomOverlayCompatibilityError =
  | 'invalid-message'
  | 'protocol-mismatch'
  | 'rules-mismatch'
  | 'session-mismatch';

export interface RoomOverlayView {
  readonly phase: RoomOverlayPhase;
  readonly connection: MultiplayerConnectionState;
  readonly roomId: string;
  readonly localReady: boolean;
  readonly opponentReady: boolean;
  readonly result: MultiplayerLocalResult | null;
  readonly compatibilityError: RoomOverlayCompatibilityError | null;
}

/** Lobby, invite, terminal-result, and transport-error presentation. */
export class MultiplayerRoomOverlay {
  private readonly root: HTMLElement;
  private readonly eyebrow: HTMLElement;
  private readonly title: HTMLElement;
  private readonly message: HTMLElement;
  private readonly roomCode: HTMLElement;
  private readonly actions: HTMLElement;
  private readonly readyButton: HTMLButtonElement;
  private readonly copyButton: HTMLButtonElement;
  private readonly homeLink: HTMLAnchorElement;
  private inviteUrl = '';
  private onReady: ((ready: boolean) => void) | null = null;
  private copied = false;

  constructor(
    private readonly modeLabel: string = 'SCORE RACE',
    mount: HTMLElement = document.body,
  ) {
    const fragment = cloneTemplate('tpl-multiplayer-room-overlay');
    this.root = mustQuery(fragment, '.multiplayer-room');
    this.eyebrow = mustQuery(fragment, '.multiplayer-room__eyebrow');
    this.title = mustQuery(fragment, '.multiplayer-room__panel > h1');
    this.message = mustQuery(fragment, '.multiplayer-room__message');
    this.roomCode = mustQuery(fragment, '.multiplayer-room__code');
    this.actions = mustQuery(fragment, '.multiplayer-room__actions');
    this.readyButton = mustQuery(fragment, '.multiplayer-room__button--primary');
    this.copyButton = mustQuery(fragment, '[data-multiplayer-action="copy"]');
    this.homeLink = mustQuery(fragment, '.multiplayer-room__button--quiet');

    this.readyButton.addEventListener('click', () => {
      const ready = this.readyButton.dataset.ready !== 'true';
      this.onReady?.(ready);
    });
    blurOnClick(this.readyButton);
    this.copyButton.addEventListener('click', () => void this.copyInvite());
    blurOnClick(this.copyButton);
    this.homeLink.href = location.pathname;

    mount.append(fragment);
    this.renderLoading();
  }

  setRoom(roomId: string, inviteUrl: string, onReady: (ready: boolean) => void): void {
    this.inviteUrl = inviteUrl;
    this.onReady = onReady;
    this.roomCode.textContent = roomId;
  }

  renderLoading(message = 'Opening a private room…'): void {
    this.root.hidden = false;
    this.root.dataset.state = 'loading';
    this.eyebrow.textContent = `MULTIPLAYER · ${this.modeLabel}`;
    this.title.textContent = 'CONNECTING';
    this.message.textContent = message;
    this.roomCode.textContent = '';
    this.readyButton.hidden = true;
    this.copyButton.hidden = true;
  }

  render(view: RoomOverlayView, error: MultiplayerTransportError | null): void {
    // A result is authoritative and terminal. A transport error can race in
    // immediately afterward (for example, when both deadline timers fire), but
    // it must never replace the winner presentation the player already earned.
    if (view.result) {
      this.root.hidden = false;
      this.root.dataset.state = 'result';
      this.eyebrow.textContent = 'MATCH COMPLETE';
      this.title.textContent = view.result.outcome === 'win'
        ? 'YOU WIN'
        : view.result.outcome === 'loss' ? 'YOU LOSE' : 'TIE';
      const score =
        `${view.result.localScore.toLocaleString('en-US')} – ${view.result.opponentScore.toLocaleString('en-US')}`;
      this.message.textContent = view.localReady
        ? `${score} · Waiting for your opponent…`
        : view.opponentReady
          ? `${score} · Your opponent wants another round.`
          : score;
      this.roomCode.textContent = '';
      this.readyButton.hidden = false;
      this.readyButton.disabled = view.connection !== 'connected';
      this.readyButton.dataset.ready = String(view.localReady);
      this.readyButton.textContent = view.localReady ? 'CANCEL REMATCH' : 'PLAY AGAIN';
      this.copyButton.hidden = true;
      return;
    }
    if (error) {
      this.renderError(transportErrorText(error));
      return;
    }
    if (view.compatibilityError) {
      this.renderError('This match uses an incompatible Disco multiplayer version.');
      return;
    }
    if (view.phase === 'finished') {
      this.root.hidden = false;
      this.root.dataset.state = 'finishing';
      this.eyebrow.textContent = this.modeLabel;
      this.title.textContent = 'RUN COMPLETE';
      this.message.textContent = 'Waiting for the other player’s final score…';
      this.roomCode.textContent = '';
      this.readyButton.hidden = true;
      this.copyButton.hidden = true;
      return;
    }
    if (view.phase !== 'lobby' && view.phase !== 'ready') {
      this.root.hidden = true;
      return;
    }

    this.root.hidden = false;
    this.root.dataset.state = 'lobby';
    this.eyebrow.textContent = `PRIVATE ${this.modeLabel}`;
    this.title.textContent = 'ROOM CODE';
    this.message.textContent = view.localReady
      ? 'You’re ready. Share the invite and wait for the other player.'
      : 'Share this private link, then ready up when both players have joined.';
    this.roomCode.textContent = view.roomId;
    this.readyButton.hidden = false;
    this.readyButton.disabled = view.connection !== 'connected';
    this.readyButton.dataset.ready = String(view.localReady);
    this.readyButton.textContent = view.localReady ? 'NOT READY' : 'READY';
    this.copyButton.hidden = false;
    this.copyButton.textContent = this.copied ? 'LINK COPIED' : 'COPY INVITE LINK';
  }

  renderError(message: string): void {
    this.root.hidden = false;
    this.root.dataset.state = 'error';
    this.eyebrow.textContent = 'MULTIPLAYER UNAVAILABLE';
    this.title.textContent = 'ROOM ERROR';
    this.message.textContent = message;
    this.roomCode.textContent = '';
    this.readyButton.hidden = true;
    this.copyButton.hidden = true;
  }

  destroy(): void {
    this.root.remove();
  }

  private async copyInvite(): Promise<void> {
    if (!this.inviteUrl) return;
    try {
      await navigator.clipboard.writeText(this.inviteUrl);
      this.copied = true;
      this.copyButton.textContent = 'LINK COPIED';
    } catch {
      this.copyButton.textContent = 'COPY FAILED';
    }
  }
}

function transportErrorText(error: MultiplayerTransportError): string {
  switch (error) {
    case 'room-not-found': return 'This private room no longer exists.';
    case 'room-full': return 'This private room already has two players.';
    case 'invalid-credential': return 'This player link is no longer valid.';
    case 'protocol-mismatch':
    case 'mode-mismatch':
      return 'This match requires a different version of Disco.';
    default:
      return 'The room rejected the connection. Return home and try a new room.';
  }
}
