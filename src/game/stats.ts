/**
 * Live record fields (`highScore`, `longestStreak`) include the in-progress game.
 * Completed-game fields only change when a game is actually recorded at game
 * over; abandoned games are not counted. Advanced totals follow that same
 * completed-run definition.
 */
export interface GameStats {
  highScore: number;
  longestStreak: number;
  averageScore: number;
  gamesPlayed: number;
  totalScore: number;
  totalPlayTimeMs: number;
  totalDiscsDropped: number;
  totalDiscsBroken: number;
}

export function emptyStats(): GameStats {
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

export function updateRecords(stats: GameStats, score: number, streak: number): boolean {
  const beforeHighScore = stats.highScore;
  const beforeLongestStreak = stats.longestStreak;
  stats.highScore = Math.max(stats.highScore, score);
  stats.longestStreak = Math.max(stats.longestStreak, streak);
  return stats.highScore !== beforeHighScore || stats.longestStreak !== beforeLongestStreak;
}

export function recordCompletedGame(
  stats: GameStats,
  score: number,
  playTimeMs = 0,
  discsDropped = 0,
  discsBroken = 0,
): void {
  stats.totalScore += score;
  stats.totalPlayTimeMs += Math.max(0, Math.floor(playTimeMs));
  stats.totalDiscsDropped += Math.max(0, Math.floor(discsDropped));
  stats.totalDiscsBroken += Math.max(0, Math.floor(discsBroken));
  stats.gamesPlayed++;
  stats.averageScore = Math.round(stats.totalScore / stats.gamesPlayed);
  stats.highScore = Math.max(stats.highScore, score);
}

export function perMinuteRate(total: number, totalPlayTimeMs: number): number | null {
  if (totalPlayTimeMs <= 0) return null;
  return total / (totalPlayTimeMs / 60_000);
}
