import { emptyStats } from '../game/stats.js';
import type { GameStats } from '../game/stats.js';

const COOKIE_PREFIX = 'disco_';
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365 * 5;
// Cookies written before per-mode stats existed have no mode prefix. Only
// Classic mode falls back to reading them, so a pre-existing player's history
// becomes their Classic stats instead of silently resetting to zero.
const LEGACY_MODE_ID = 'classic';

function nonNegativeInteger(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0;
}

function readField(cookies: ReadonlyMap<string, string>, modeId: string, field: string): number {
  const scoped = cookies.get(`${COOKIE_PREFIX}${modeId}_${field}`);
  if (scoped !== undefined) return nonNegativeInteger(scoped);
  if (modeId === LEGACY_MODE_ID) {
    const legacy = cookies.get(`${COOKIE_PREFIX}${field}`);
    if (legacy !== undefined) return nonNegativeInteger(legacy);
  }
  return 0;
}

export function parseStatsCookies(cookieHeader: string, modeId: string): GameStats {
  const cookies = new Map<string, string>();
  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    cookies.set(name, value);
  }

  const gamesPlayed = readField(cookies, modeId, 'games_played');
  const averageScore = readField(cookies, modeId, 'average_score');
  return {
    highScore: readField(cookies, modeId, 'high_score'),
    longestStreak: readField(cookies, modeId, 'longest_streak'),
    averageScore,
    gamesPlayed,
    // The fallback preserves stats written before total_score was introduced.
    totalScore: readField(cookies, modeId, 'total_score') || averageScore * gamesPlayed,
    totalPlayTimeMs: readField(cookies, modeId, 'total_play_time_ms'),
    totalDiscsDropped: readField(cookies, modeId, 'total_discs_dropped'),
    totalDiscsBroken: readField(cookies, modeId, 'total_discs_broken'),
  };
}

function writeCookie(name: string, value: number): void {
  document.cookie = `${COOKIE_PREFIX}${name}=${Math.floor(value)}; Max-Age=${COOKIE_MAX_AGE}; Path=/; SameSite=Lax`;
}

export function loadStats(modeId: string): GameStats {
  try {
    return parseStatsCookies(document.cookie, modeId);
  } catch {
    return emptyStats();
  }
}

export function saveStats(modeId: string, stats: GameStats): void {
  try {
    writeCookie(`${modeId}_high_score`, stats.highScore);
    writeCookie(`${modeId}_longest_streak`, stats.longestStreak);
    writeCookie(`${modeId}_average_score`, stats.averageScore);
    writeCookie(`${modeId}_games_played`, stats.gamesPlayed);
    writeCookie(`${modeId}_total_score`, stats.totalScore);
    writeCookie(`${modeId}_total_play_time_ms`, stats.totalPlayTimeMs);
    writeCookie(`${modeId}_total_discs_dropped`, stats.totalDiscsDropped);
    writeCookie(`${modeId}_total_discs_broken`, stats.totalDiscsBroken);
  } catch {
    // Cookies may be disabled. Stats remain available for this page session.
  }
}
