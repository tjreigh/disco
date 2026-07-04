import { describe, expect, test } from 'vitest';
import { parseStatsCookies } from '../../platform/cookie-stats-store.js';
import type { GameStats } from '../../game/stats.js';
import { recordCompletedGame, updateRecords } from '../../game/stats.js';

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
  test('reads mode-scoped Disco cookies and ignores unrelated or invalid values', () => {
    expect(parseStatsCookies(
      'theme=dark; disco_classic_high_score=1200; disco_classic_longest_streak=6; ' +
      'disco_classic_average_score=425; disco_classic_games_played=4; disco_classic_total_score=1700',
      'classic',
    )).toEqual({
      highScore: 1200,
      longestStreak: 6,
      averageScore: 425,
      gamesPlayed: 4,
      totalScore: 1700,
    });
  });

  test('classic mode falls back to pre-mode-scoping legacy cookies', () => {
    expect(parseStatsCookies(
      'disco_high_score=900; disco_longest_streak=3; ' +
      'disco_average_score=300; disco_games_played=3; disco_total_score=900',
      'classic',
    )).toEqual({
      highScore: 900,
      longestStreak: 3,
      averageScore: 300,
      gamesPlayed: 3,
      totalScore: 900,
    });
  });

  test('legacy cookies do not leak into a non-classic mode', () => {
    expect(parseStatsCookies(
      'disco_high_score=900; disco_longest_streak=3; ' +
      'disco_average_score=300; disco_games_played=3; disco_total_score=900',
      'some-other-mode',
    )).toEqual({
      highScore: 0,
      longestStreak: 0,
      averageScore: 0,
      gamesPlayed: 0,
      totalScore: 0,
    });
  });

  test('a scoped cookie takes precedence over a legacy cookie for classic mode', () => {
    expect(parseStatsCookies(
      'disco_high_score=900; disco_classic_high_score=1200',
      'classic',
    ).highScore).toBe(1200);
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
