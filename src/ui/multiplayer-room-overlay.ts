import type {
  MultiplayerConnectionState,
  MultiplayerLocalResult,
} from '../shared/multiplayer-contracts.js';
import type {
  MultiplayerTransportError,
} from '../platform/websocket-multiplayer-transport.js';
import type { MultiplayerCompatibilityError, MultiplayerPhase } from '../app/multiplayer-view-types.js';
import { assertNever, blurOnClick, cloneTemplate, mustQuery } from './dom-utils.js';

// Score Race and Disco Duel sessions both project this exact phase/error
// shape (see MultiplayerLocalPhase / MultiplayerCompatibilityError in
// multiplayer-session-controller.ts and SharedBoardPhase /
// SharedBoardCompatibilityError in shared-board-session-controller.ts).
// This overlay imports the same canonical types from
// app/multiplayer-view-types.ts (under overlay-specific names, since this
// stays a shared, mode-agnostic UI component) rather than importing from
// either mode-specific controller.
export type RoomOverlayPhase = MultiplayerPhase;
export type RoomOverlayCompatibilityError = MultiplayerCompatibilityError;

export interface RoomOverlayView {
  readonly phase: RoomOverlayPhase;
  readonly connection: MultiplayerConnectionState;
  readonly roomId: string;
  readonly localReady: boolean;
  readonly opponentReady: boolean;
  readonly result: MultiplayerLocalResult | null;
  readonly compatibilityError: RoomOverlayCompatibilityError | null;
  readonly paused: boolean;
  readonly pausedByLocal: boolean;
}

/** Lobby, invite, terminal-result, and transport-error presentation. */
export class MultiplayerRoomOverlay {
  private readonly root: HTMLElement;
  private readonly eyebrow: HTMLElement;
  private readonly title: HTMLElement;
  private readonly badge: HTMLElement;
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
    this.badge = mustQuery(fragment, '.multiplayer-room__badge');
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
    // Only the result state ever shows a badge — clear it up front so no
    // other branch has to remember to do so.
    this.badge.hidden = true;
    this.homeLink.hidden = false;

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
      if (view.result.forfeitedBy) {
        this.badge.hidden = false;
        this.badge.textContent = view.result.forfeitedBy === 'local'
          ? 'YOU FORFEITED'
          : 'OPPONENT FORFEITED';
      }
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
      this.renderError(compatibilityErrorText(view.compatibilityError));
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
    // The pausing player sees their own pause-menu dialog instead of this
    // overlay — this branch is only for the other player, who has no
    // controls to offer here beyond waiting. The match is still live and
    // resumable, unlike every other state this overlay renders, so — unlike
    // those — leaving via the home link isn't a real option here: there's no
    // way back into an in-progress match, only the room code from before
    // the match started. Hide it rather than offer a dead end.
    if (view.paused && !view.pausedByLocal && view.phase === 'playing') {
      this.root.hidden = false;
      this.root.dataset.state = 'paused';
      this.eyebrow.textContent = this.modeLabel;
      this.title.textContent = 'PAUSED';
      this.message.textContent = 'Your opponent paused the match.';
      this.roomCode.textContent = '';
      this.readyButton.hidden = true;
      this.copyButton.hidden = true;
      this.homeLink.hidden = true;
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

// Each case here is a genuinely different failure with a different likely
// fix — collapsing them into one "incompatible version" string in the past
// hid a real wire-protocol parser bug behind text that pointed at version
// skew that didn't exist. The full detail (raw offending payload, expected
// vs. received identity, etc.) is logged to the console at the single
// choke point both session controllers funnel through — see
// failCompatibility in multiplayer-session-controller.ts and
// #failCompatibility in shared-board-session-controller.ts.
function compatibilityErrorText(error: RoomOverlayCompatibilityError): string {
  switch (error) {
    case 'protocol-mismatch':
      return 'Your Disco client is out of date. Refresh the page to get the latest version.';
    case 'rules-mismatch':
      return 'This match uses a different ruleset than this client expects. Refresh and try again.';
    case 'session-mismatch':
      return 'This match’s session settings don’t match what this client expects. Refresh and try again.';
    case 'invalid-message':
      return 'The server sent a message this client couldn’t understand. This is likely a bug — check the browser console for details.';
    default:
      return assertNever(error, 'multiplayer-room-overlay: compatibilityErrorText');
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
