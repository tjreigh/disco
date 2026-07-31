import type {
  MultiplayerSessionView,
} from '../app/multiplayer-session-controller.js';
import type {
  MultiplayerTransportError,
} from '../platform/websocket-multiplayer-transport.js';
import { blurOnClick } from './dom-utils.js';

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

  constructor(mount: HTMLElement = document.body) {
    this.root = document.createElement('section');
    this.root.className = 'multiplayer-room';
    this.root.setAttribute('aria-label', 'Private multiplayer room');

    const panel = document.createElement('div');
    panel.className = 'multiplayer-room__panel';
    this.eyebrow = document.createElement('span');
    this.eyebrow.className = 'multiplayer-room__eyebrow';
    this.title = document.createElement('h1');
    this.message = document.createElement('p');
    this.message.className = 'multiplayer-room__message';
    this.message.setAttribute('aria-live', 'polite');
    this.roomCode = document.createElement('strong');
    this.roomCode.className = 'multiplayer-room__code';

    this.actions = document.createElement('div');
    this.actions.className = 'multiplayer-room__actions';
    this.readyButton = this.button('READY', () => {
      const ready = this.readyButton.dataset.ready !== 'true';
      this.onReady?.(ready);
    });
    this.readyButton.classList.add('multiplayer-room__button--primary');
    this.copyButton = this.button('COPY INVITE LINK', () => void this.copyInvite());
    this.homeLink = document.createElement('a');
    this.homeLink.className = 'multiplayer-room__button multiplayer-room__button--quiet';
    this.homeLink.href = location.pathname;
    this.homeLink.textContent = 'BACK TO SOLO';
    this.actions.append(this.readyButton, this.copyButton, this.homeLink);

    panel.append(
      this.eyebrow,
      this.title,
      this.message,
      this.roomCode,
      this.actions,
    );
    this.root.append(panel);
    mount.append(this.root);
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
    this.eyebrow.textContent = 'MULTIPLAYER · SCORE RACE';
    this.title.textContent = 'CONNECTING';
    this.message.textContent = message;
    this.roomCode.textContent = '';
    this.readyButton.hidden = true;
    this.copyButton.hidden = true;
  }

  render(view: MultiplayerSessionView, error: MultiplayerTransportError | null): void {
    if (error) {
      this.renderError(transportErrorText(error));
      return;
    }
    if (view.compatibilityError) {
      this.renderError('This match uses an incompatible Disco multiplayer version.');
      return;
    }
    if (view.result) {
      this.root.hidden = false;
      this.root.dataset.state = 'result';
      this.eyebrow.textContent = 'MATCH COMPLETE';
      this.title.textContent = view.result.outcome === 'win'
        ? 'YOU WIN'
        : view.result.outcome === 'loss' ? 'YOU LOSE' : 'TIE';
      this.message.textContent =
        `${view.result.localScore.toLocaleString('en-US')} – ${view.result.opponentScore.toLocaleString('en-US')}`;
      this.roomCode.textContent = '';
      this.readyButton.hidden = true;
      this.copyButton.hidden = true;
      return;
    }
    if (view.phase === 'finished') {
      this.root.hidden = false;
      this.root.dataset.state = 'finishing';
      this.eyebrow.textContent = 'SCORE RACE';
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
    this.eyebrow.textContent = 'PRIVATE SCORE RACE';
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

  private button(label: string, onClick: () => void): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'multiplayer-room__button';
    button.textContent = label;
    button.addEventListener('click', onClick);
    blurOnClick(button);
    return button;
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
