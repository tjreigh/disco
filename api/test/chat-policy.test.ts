import { describe, expect, test } from 'vitest';
import {
  ChatRateLimiter,
  defaultChatRateLimit,
} from '../src/multiplayer/chat-policy.js';
import type { RoomClock } from '../src/multiplayer/room-types.js';

class ManualClock implements RoomClock {
  constructor(public time = 0) {}

  now(): number {
    return this.time;
  }
}

describe('ChatRateLimiter', () => {
  test('allows up to the per-window maximum, then rejects the next message', () => {
    const clock = new ManualClock();
    const limiter = new ChatRateLimiter(clock);
    const { maxMessages } = defaultChatRateLimit();

    for (let index = 0; index < maxMessages; index++) {
      expect(limiter.allow('player-1')).toBe(true);
    }
    expect(limiter.allow('player-1')).toBe(false);
  });

  test('scopes the limit per player', () => {
    const clock = new ManualClock();
    const limiter = new ChatRateLimiter(clock);
    const { maxMessages } = defaultChatRateLimit();

    for (let index = 0; index < maxMessages; index++) {
      limiter.allow('player-1');
    }
    expect(limiter.allow('player-1')).toBe(false);
    expect(limiter.allow('player-2')).toBe(true);
  });

  test('replenishes once the window has elapsed', () => {
    const clock = new ManualClock();
    const limiter = new ChatRateLimiter(clock);
    const { maxMessages, windowMs } = defaultChatRateLimit();

    for (let index = 0; index < maxMessages; index++) {
      expect(limiter.allow('player-1')).toBe(true);
    }
    expect(limiter.allow('player-1')).toBe(false);

    clock.time += windowMs;
    expect(limiter.allow('player-1')).toBe(true);
  });

  test('sweep drops players whose history has fully aged out', () => {
    const clock = new ManualClock();
    const limiter = new ChatRateLimiter(clock);
    const { windowMs } = defaultChatRateLimit();

    limiter.allow('player-1');
    clock.time += windowMs;
    limiter.sweep(clock.time);

    // A full window of silence reset the player, so the burst starts fresh.
    const { maxMessages } = defaultChatRateLimit();
    for (let index = 0; index < maxMessages; index++) {
      expect(limiter.allow('player-1')).toBe(true);
    }
    expect(limiter.allow('player-1')).toBe(false);
  });
});
