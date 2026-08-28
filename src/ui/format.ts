import { perMinuteRate } from '../game/stats.js';

/** "\<1m" / "37m" / "2h" / "2h 14m" — shared by AdvancedStatsDialog and GameOverScreen's run-stats panels. */
export function formatDuration(milliseconds: number): string {
  const totalMinutes = Math.floor(milliseconds / 60_000);
  if (totalMinutes < 1) return '<1m';
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

/** A per-minute rate, or "—" when too little play time has elapsed to estimate one (see perMinuteRate). */
export function formatRate(total: number, timeMs: number): string {
  const rate = perMinuteRate(total, timeMs);
  return rate === null
    ? '—'
    : rate.toLocaleString('en-US', { maximumFractionDigits: 1 });
}
