import { describe, expect, test } from 'vitest';
import {
  GameStats, parseStatsCookies, recordCompletedGame, updateRecords,
} from './stats.js';

function emptyStats(): GameStats {
  return {
    highScore: 0,
    longestStreak: 0,
    averageScore: 0,
    gamesPlayed: 0,
    totalScore: 0,
  };
}

describe('persistent game stats', () => {
  test('reads Disco cookies and ignores unrelated or invalid values', () => {
    expect(parseStatsCookies(
      'theme=dark; disco_high_score=1200; disco_longest_streak=6; ' +
      'disco_average_score=425; disco_games_played=4; disco_total_score=1700',
    )).toEqual({
      highScore: 1200,
      longestStreak: 6,
      averageScore: 425,
      gamesPlayed: 4,
      totalScore: 1700,
    });
  });

  test('tracks records without lowering them', () => {
    const stats = emptyStats();
    updateRecords(stats, 500, 4);
    updateRecords(stats, 200, 2);
    expect(stats.highScore).toBe(500);
    expect(stats.longestStreak).toBe(4);
  });

  test('calculates an exact rolling completed-game average', () => {
    const stats = emptyStats();
    recordCompletedGame(stats, 10);
    recordCompletedGame(stats, 11);
    recordCompletedGame(stats, 11);
    expect(stats).toMatchObject({
      highScore: 11,
      gamesPlayed: 3,
      totalScore: 32,
      averageScore: 11,
    });
  });
});
