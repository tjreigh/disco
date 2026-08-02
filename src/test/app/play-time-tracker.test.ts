import { describe, expect, test } from 'vitest';
import { PlayTimeTracker } from '../../app/play-time-tracker.js';

describe('PlayTimeTracker', () => {
  test('accumulates running segments and freezes on stop', () => {
    const tracker = new PlayTimeTracker();
    tracker.start(100);
    expect(tracker.peek(350)).toBe(250);
    expect(tracker.stop(600)).toBe(500);
    expect(tracker.peek(900)).toBe(500);
  });

  test('waits for every pause reason to clear before resuming', () => {
    const tracker = new PlayTimeTracker();
    tracker.start(0);
    tracker.pause('menu', 100);
    tracker.pause('backgrounded', 200);
    tracker.resume('backgrounded', 500);
    expect(tracker.peek(800)).toBe(100);
    tracker.resume('menu', 900);
    expect(tracker.peek(1_100)).toBe(300);
  });

  test('restores persisted elapsed time and ignores absent reasons', () => {
    const tracker = new PlayTimeTracker();
    tracker.startFrom(4_000, 100);
    tracker.resume('menu', 200);
    expect(tracker.peek(600)).toBe(4_500);
  });

  test('a new run clears stale pause reasons', () => {
    const tracker = new PlayTimeTracker();
    tracker.start(0);
    tracker.pause('menu', 10);
    tracker.start(100);
    expect(tracker.peek(150)).toBe(50);
  });
});
