import type { ChatLogEntry } from '../app/multiplayer-chat-log.js';
import { MAX_CHAT_MESSAGE_LENGTH } from '../shared/multiplayer-contracts.js';
import { cloneTemplate, isTouchDevice, mustQuery } from './dom-utils.js';

/**
 * Toggleable room chat shared by both multiplayer modes. Mounted in the
 * overlay layer, it stays above the lobby/result surface while leaving the
 * board interactive when collapsed. All dynamic text is written via
 * `textContent` (never `innerHTML`) so a hostile chat message can't inject
 * markup.
 */
export class MultiplayerChat {
  readonly root: HTMLElement;
  private readonly toggle: HTMLButtonElement;
  private readonly panel: HTMLElement;
  private readonly log: HTMLElement;
  private readonly form: HTMLFormElement;
  private readonly input: HTMLInputElement;
  private readonly sendButton: HTMLButtonElement;
  private readonly unreadBadge: HTMLElement;
  private onSend: ((text: string) => boolean) | null = null;
  private renderedCount = 0;
  private lastRenderedEntry: ChatLogEntry | null = null;
  private unreadCount = 0;
  private disabled = false;
  private open = false;

  constructor(mount: HTMLElement) {
    const fragment = cloneTemplate('tpl-multiplayer-chat');
    this.root = mustQuery(fragment, '.multiplayer-chat');
    this.toggle = mustQuery(fragment, '.multiplayer-chat__toggle');
    this.panel = mustQuery(fragment, '.multiplayer-chat__panel');
    this.log = mustQuery(fragment, '.multiplayer-chat__log');
    this.form = mustQuery(fragment, '.multiplayer-chat__form');
    this.input = mustQuery(fragment, '.multiplayer-chat__input');
    this.sendButton = mustQuery(fragment, '.multiplayer-chat__send');
    this.unreadBadge = mustQuery(fragment, '.multiplayer-chat__unread');
    this.input.maxLength = MAX_CHAT_MESSAGE_LENGTH;

    this.toggle.addEventListener('click', () => this.setOpen(!this.open));
    this.form.addEventListener('submit', event => {
      event.preventDefault();
      const text = this.input.value.trim();
      // Keep the text when the send is rejected locally (disconnected, empty,
      // or over the length/format limit) so the user doesn't lose it.
      if (!text || !this.onSend || !this.onSend(text)) return;
      this.input.value = '';
      this.sendButton.blur();
    });
    this.input.addEventListener('keydown', event => {
      if (event.key === 'Escape') this.setOpen(false);
    });

    mount.append(fragment);
  }

  setOnSend(listener: (text: string) => boolean): void {
    this.onSend = listener;
  }

  render(messages: readonly ChatLogEntry[], localPlayerId: string, disabled: boolean): void {
    const needsFullRender = messages.length < this.renderedCount
      || (messages.length === this.renderedCount
        && messages.length > 0
        && messages.at(-1) !== this.lastRenderedEntry);
    if (needsFullRender) {
      const newEntries = this.entriesSinceLastRender(messages);
      this.log.replaceChildren();
      this.appendEntries(messages, localPlayerId);
      this.noteUnread(newEntries, localPlayerId);
      this.renderedCount = messages.length;
      this.lastRenderedEntry = messages.at(-1) ?? null;
      this.log.scrollTop = this.log.scrollHeight;
    } else if (messages.length !== this.renderedCount) {
      const addedEntries = messages.slice(this.renderedCount);
      this.appendEntries(addedEntries, localPlayerId);
      this.noteUnread(addedEntries, localPlayerId);
      this.renderedCount = messages.length;
      this.lastRenderedEntry = messages.at(-1) ?? null;
      this.log.scrollTop = this.log.scrollHeight;
    }
    if (disabled !== this.disabled) {
      this.disabled = disabled;
      this.input.disabled = disabled;
      this.sendButton.disabled = disabled;
      if (disabled && this.open) this.setOpen(false);
    }
  }

  destroy(): void {
    this.root.remove();
  }

  private setOpen(open: boolean): void {
    this.open = open;
    this.panel.hidden = !open;
    this.toggle.setAttribute('aria-expanded', String(open));
    if (open) {
      this.unreadCount = 0;
      this.renderUnreadState();
      if (!isTouchDevice()) this.input.focus();
    } else {
      this.toggle.blur();
    }
  }

  private noteUnread(entries: readonly ChatLogEntry[], localPlayerId: string): void {
    if (this.open) return;
    this.unreadCount += entries.filter(entry => entry.kind === 'message' && entry.playerId !== localPlayerId).length;
    this.renderUnreadState();
  }

  /**
   * The chat entries appended since the last render.
   *
   * @remarks
   * History is bounded, so a new entry can replace the oldest without changing
   * the array length. The previous final entry remains in a normal rollover;
   * everything after it is genuinely new and can affect unread state.
   */
  private entriesSinceLastRender(messages: readonly ChatLogEntry[]): readonly ChatLogEntry[] {
    if (!this.lastRenderedEntry) return messages;
    const previousTailIndex = messages.lastIndexOf(this.lastRenderedEntry);
    return previousTailIndex === -1 ? messages : messages.slice(previousTailIndex + 1);
  }

  private renderUnreadState(): void {
    const hasUnread = this.unreadCount > 0;
    this.unreadBadge.hidden = !hasUnread;
    this.unreadBadge.textContent = this.unreadCount > 99 ? '99+' : String(this.unreadCount);
    this.toggle.setAttribute('aria-label', hasUnread
      ? `Open chat (${this.unreadCount} unread message${this.unreadCount === 1 ? '' : 's'})`
      : 'Open chat');
  }

  private appendEntries(entries: readonly ChatLogEntry[], localPlayerId: string): void {
    for (const entry of entries) {
      const row = document.createElement('div');
      if (entry.kind === 'notice') {
        row.className = 'multiplayer-chat__entry multiplayer-chat__entry--notice';
        row.textContent = entry.text;
      } else {
        row.className = 'multiplayer-chat__entry';
        row.dataset.owner = entry.playerId === localPlayerId ? 'you' : 'opponent';
        const author = document.createElement('span');
        author.className = 'multiplayer-chat__author';
        author.textContent = entry.playerId === localPlayerId ? 'YOU' : 'OPPONENT';
        const text = document.createElement('span');
        text.className = 'multiplayer-chat__text';
        text.textContent = entry.text;
        row.append(author, text);
      }
      this.log.append(row);
    }
  }
}
