/**
 * Live record fields (`highScore`, `longestStreak`) include the in-progress game.
 * Completed-game fields (`gamesPlayed`, `totalScore`, `averageScore`) only change
 * when a game is actually recorded at game over; abandoned games are not counted.
 */
export interface GameStats {
  highScore: number;
  longestStreak: number;
  averageScore: number;
  gamesPlayed: number;
  totalScore: number;
}

export function emptyStats(): GameStats {
  return { highScore: 0, longestStreak: 0, averageScore: 0, gamesPlayed: 0, totalScore: 0 };
}

export function updateRecords(stats: GameStats, score: number, streak: number): boolean {
  const beforeHighScore = stats.highScore;
  const beforeLongestStreak = stats.longestStreak;
  stats.highScore = Math.max(stats.highScore, score);
  stats.longestStreak = Math.max(stats.longestStreak, streak);
  return stats.highScore !== beforeHighScore || stats.longestStreak !== beforeLongestStreak;
}

export function recordCompletedGame(stats: GameStats, score: number): void {
  stats.totalScore += score;
  stats.gamesPlayed++;
  stats.averageScore = Math.round(stats.totalScore / stats.gamesPlayed);
  stats.highScore = Math.max(stats.highScore, score);
}
