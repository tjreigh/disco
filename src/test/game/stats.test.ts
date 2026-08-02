import { describe, expect, test } from 'vitest';
import { perMinuteRate, recordCompletedGame, updateRecords, type GameStats } from '../../game/stats.js';

function emptyStats(): GameStats {
  return {
    highScore: 0,
    longestStreak: 0,
    averageScore: 0,
    gamesPlayed: 0,
    totalScore: 0,
    totalPlayTimeMs: 0,
    totalDiscsDropped: 0,
    totalDiscsBroken: 0,
  };
}

describe('game stats semantics', () => {
  test('updateRecords reports whether either record improved', () => {
    const stats = emptyStats();

    expect(updateRecords(stats, 100, 3)).toBe(true);
    expect(stats).toMatchObject({ highScore: 100, longestStreak: 3 });

    expect(updateRecords(stats, 80, 2)).toBe(false);
    expect(stats).toMatchObject({ highScore: 100, longestStreak: 3 });

    expect(updateRecords(stats, 120, 2)).toBe(true);
    expect(stats).toMatchObject({ highScore: 120, longestStreak: 3 });
  });

  test('recordCompletedGame maintains rolling completed-game totals and average', () => {
    const stats = emptyStats();

    recordCompletedGame(stats, 10);
    recordCompletedGame(stats, 11);
    recordCompletedGame(stats, 11);

    expect(stats).toEqual({
      highScore: 11,
      longestStreak: 0,
      averageScore: 11,
      gamesPlayed: 3,
      totalScore: 32,
      totalPlayTimeMs: 0,
      totalDiscsDropped: 0,
      totalDiscsBroken: 0,
    });
  });

  test('accumulates completed-run analytics and computes per-minute rates', () => {
    const stats = emptyStats();
    recordCompletedGame(stats, 900, 120_000, 30, 12);
    recordCompletedGame(stats, 600, 60_000, 15, 8);

    expect(stats).toMatchObject({
      totalScore: 1500,
      totalPlayTimeMs: 180_000,
      totalDiscsDropped: 45,
      totalDiscsBroken: 20,
    });
    expect(perMinuteRate(stats.totalScore, stats.totalPlayTimeMs)).toBe(500);
    expect(perMinuteRate(10, 0)).toBeNull();
  });
});
