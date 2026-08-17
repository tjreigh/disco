import type { ChatMessage } from '../shared/multiplayer-contracts.js';

/** Cap on retained chat history; oldest entries fall off first. */
export const MAX_CHAT_HISTORY = 100;

export type ChatLogEntry =
  | { readonly kind: 'message'; readonly playerId: string; readonly text: string }
  | { readonly kind: 'notice'; readonly text: string };

/**
 * Room-scoped chat history shared by both multiplayer session controllers.
 * Bounds the log and validates sender identity: a chat-message is accepted
 * only when its sender is the local player or the first non-local sender seen
 * (a later third identity is dropped — that would indicate a malformed or
 * compromised room). A throttle event appends a system notice instead of a
 * message, so the sender is always told their text was not relayed.
 */
export class MultiplayerChatLog {
  private readonly localPlayerId: string;
  private opponentPlayerId: string | null = null;
  private readonly entries: ChatLogEntry[] = [];

  constructor(localPlayerId: string) {
    this.localPlayerId = localPlayerId;
  }

  get view(): readonly ChatLogEntry[] {
    return this.entries;
  }

  receive(message: ChatMessage): void {
    if (message.playerId === this.localPlayerId) {
      this.push({ kind: 'message', playerId: message.playerId, text: message.text });
      return;
    }
    if (this.opponentPlayerId === null) {
      this.opponentPlayerId = message.playerId;
      this.push({ kind: 'message', playerId: message.playerId, text: message.text });
      return;
    }
    if (message.playerId !== this.opponentPlayerId) {
      return;
    }
    this.push({ kind: 'message', playerId: message.playerId, text: message.text });
  }

  noteThrottled(): void {
    this.push({ kind: 'notice', text: 'Message not sent — you\'re sending too quickly.' });
  }

  private push(entry: ChatLogEntry): void {
    this.entries.push(entry);
    if (this.entries.length > MAX_CHAT_HISTORY) {
      this.entries.splice(0, this.entries.length - MAX_CHAT_HISTORY);
    }
  }
}
