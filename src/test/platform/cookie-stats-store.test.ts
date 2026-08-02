// @vitest-environment happy-dom

import {
  afterEach, beforeEach, describe, expect, test,
} from 'vitest';
import { loadStats, parseStatsCookies, saveStats } from '../../platform/cookie-stats-store.js';
import type { GameStats } from '../../game/stats.js';
import { recordCompletedGame, updateRecords } from '../../game/stats.js';

function clearCookies(): void {
  for (const part of document.cookie.split(';')) {
    const name = part.slice(0, part.indexOf('=')).trim();
    if (!name) continue;
    // An already-past Expires date guarantees the cookie reads as expired
    // immediately; Max-Age=0 raced the clock in happy-dom and was flaky.
    document.cookie = `${name}=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/`;
  }
}

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

describe('persistent game stats', () => {
  beforeEach(clearCookies);
  afterEach(clearCookies);

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
      totalPlayTimeMs: 0,
      totalDiscsDropped: 0,
      totalDiscsBroken: 0,
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
      totalPlayTimeMs: 0,
      totalDiscsDropped: 0,
      totalDiscsBroken: 0,
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
      totalPlayTimeMs: 0,
      totalDiscsDropped: 0,
      totalDiscsBroken: 0,
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

  describe('saveStats/loadStats round trip', () => {
    test('persists stats for a mode through real document.cookie', () => {
      const stats: GameStats = {
        highScore: 750, longestStreak: 9, averageScore: 250, gamesPlayed: 3, totalScore: 750,
        totalPlayTimeMs: 180_000, totalDiscsDropped: 30, totalDiscsBroken: 12,
      };

      saveStats('classic', stats);

      expect(loadStats('classic')).toEqual(stats);
    });

    test('keeps distinct modes from cross-contaminating each other', () => {
      const classicStats: GameStats = {
        highScore: 750, longestStreak: 9, averageScore: 250, gamesPlayed: 3, totalScore: 750,
        totalPlayTimeMs: 180_000, totalDiscsDropped: 30, totalDiscsBroken: 12,
      };
      const gravityStats: GameStats = {
        highScore: 120, longestStreak: 2, averageScore: 40, gamesPlayed: 3, totalScore: 120,
        totalPlayTimeMs: 90_000, totalDiscsDropped: 15, totalDiscsBroken: 4,
      };

      saveStats('classic', classicStats);
      saveStats('gravity', gravityStats);

      expect(loadStats('classic')).toEqual(classicStats);
      expect(loadStats('gravity')).toEqual(gravityStats);
    });

    test('classic mode falls back to the legacy total_score cookie when no scoped cookie exists', () => {
      document.cookie = 'disco_total_score=900; Path=/';

      expect(loadStats('classic').totalScore).toBe(900);
    });
  });

  describe('cookie access failures', () => {
    test('loadStats returns emptyStats and saveStats does not throw when document.cookie throws', () => {
      Object.defineProperty(document, 'cookie', {
        configurable: true,
        get() {
          throw new Error('cookies disabled');
        },
        set() {
          throw new Error('cookies disabled');
        },
      });

      try {
        expect(loadStats('classic')).toEqual(emptyStats());
        expect(() => saveStats('classic', {
          highScore: 1, longestStreak: 1, averageScore: 1, gamesPlayed: 1, totalScore: 1,
          totalPlayTimeMs: 1, totalDiscsDropped: 1, totalDiscsBroken: 1,
        })).not.toThrow();
      } finally {
        // Remove the instance-level override so cookie access falls back to
        // the environment's normal prototype-level implementation.
        delete (document as unknown as Record<string, unknown>).cookie;
      }
    });
  });
});
