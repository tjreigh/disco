export interface GameStats {
  highScore: number;
  longestStreak: number;
  averageScore: number;
  gamesPlayed: number;
  totalScore: number;
}

const COOKIE_PREFIX = 'disco_';
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365 * 5;

function nonNegativeInteger(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0;
}

export function parseStatsCookies(cookieHeader: string): GameStats {
  const cookies = new Map<string, string>();
  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    cookies.set(name, value);
  }

  const gamesPlayed = nonNegativeInteger(cookies.get(`${COOKIE_PREFIX}games_played`));
  const averageScore = nonNegativeInteger(cookies.get(`${COOKIE_PREFIX}average_score`));
  return {
    highScore: nonNegativeInteger(cookies.get(`${COOKIE_PREFIX}high_score`)),
    longestStreak: nonNegativeInteger(cookies.get(`${COOKIE_PREFIX}longest_streak`)),
    averageScore,
    gamesPlayed,
    // The fallback preserves stats written before total_score was introduced.
    totalScore: nonNegativeInteger(cookies.get(`${COOKIE_PREFIX}total_score`)) || averageScore * gamesPlayed,
  };
}

function writeCookie(name: string, value: number): void {
  document.cookie = `${COOKIE_PREFIX}${name}=${Math.floor(value)}; Max-Age=${COOKIE_MAX_AGE}; Path=/; SameSite=Lax`;
}

export function loadStats(): GameStats {
  try {
    return parseStatsCookies(document.cookie);
  } catch {
    return { highScore: 0, longestStreak: 0, averageScore: 0, gamesPlayed: 0, totalScore: 0 };
  }
}

export function saveStats(stats: GameStats): void {
  try {
    writeCookie('high_score', stats.highScore);
    writeCookie('longest_streak', stats.longestStreak);
    writeCookie('average_score', stats.averageScore);
    writeCookie('games_played', stats.gamesPlayed);
    writeCookie('total_score', stats.totalScore);
  } catch {
    // Cookies may be disabled. Stats remain available for this page session.
  }
}

export function updateRecords(stats: GameStats, score: number, streak: number): void {
  stats.highScore = Math.max(stats.highScore, score);
  stats.longestStreak = Math.max(stats.longestStreak, streak);
}

export function recordCompletedGame(stats: GameStats, score: number): void {
  stats.totalScore += score;
  stats.gamesPlayed++;
  stats.averageScore = Math.round(stats.totalScore / stats.gamesPlayed);
  stats.highScore = Math.max(stats.highScore, score);
}
