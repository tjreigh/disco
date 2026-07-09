import { describe, expect, test } from 'vitest';
import { recordCompletedGame, updateRecords, type GameStats } from '../../game/stats.js';

function emptyStats(): GameStats {
  return {
    highScore: 0,
    longestStreak: 0,
    averageScore: 0,
    gamesPlayed: 0,
    totalScore: 0,
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
    });
  });
});
