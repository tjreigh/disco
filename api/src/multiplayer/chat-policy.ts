import type { RoomClock } from './room-types.js';

/** Chat flood policy shared by every per-mode room service. */
export const MAX_CHAT_MESSAGES_PER_WINDOW = 8;
export const CHAT_RATE_WINDOW_MS = 10_000;

export interface ChatRateLimit {
  readonly maxMessages: number;
  readonly windowMs: number;
}

export function defaultChatRateLimit(): ChatRateLimit {
  return {
    maxMessages: MAX_CHAT_MESSAGES_PER_WINDOW,
    windowMs: CHAT_RATE_WINDOW_MS,
  };
}

/**
 * Sliding-window per-player chat limiter. When `allow` returns false, the
 * caller surfaces a `chat-rate-limited` event back to that player instead of
 * broadcasting — the message is never silently dropped on the sender's side.
 *
 * Timestamps are retained per player so a burst can never leak across the
 * window boundary; `sweep` drops players whose entire history has aged out.
 */
export class ChatRateLimiter {
  private readonly clock: RoomClock;
  private readonly limit: ChatRateLimit;
  private readonly recent = new Map<string, number[]>();

  constructor(clock: RoomClock, limit: ChatRateLimit = defaultChatRateLimit()) {
    this.clock = clock;
    this.limit = limit;
  }

  allow(playerId: string): boolean {
    const now = this.clock.now();
    const window = (this.recent.get(playerId) ?? [])
      .filter(timestamp => now - timestamp < this.limit.windowMs);
    if (window.length >= this.limit.maxMessages) {
      this.recent.set(playerId, window);
      return false;
    }
    window.push(now);
    this.recent.set(playerId, window);
    return true;
  }

  sweep(now: number): void {
    for (const [playerId, timestamps] of this.recent) {
      if (timestamps.every(timestamp => now - timestamp >= this.limit.windowMs)) {
        this.recent.delete(playerId);
      }
    }
  }
}
