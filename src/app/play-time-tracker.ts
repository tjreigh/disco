/** Reason-counted active-time accumulator for a single run. */
export class PlayTimeTracker {
  private elapsedMs = 0;
  private segmentStartedAt: number | null = null;
  private active = false;
  private readonly pauseReasons = new Set<string>();

  start(now = performance.now()): void {
    this.begin(0, now);
  }

  startFrom(elapsedMs: number, now = performance.now()): void {
    this.begin(Math.max(0, Math.floor(elapsedMs)), now);
  }

  pause(reason: string, now = performance.now()): void {
    if (!this.active || this.pauseReasons.has(reason)) return;
    if (this.pauseReasons.size === 0) this.flush(now);
    this.pauseReasons.add(reason);
  }

  resume(reason: string, now = performance.now()): void {
    if (!this.active || !this.pauseReasons.delete(reason)) return;
    if (this.pauseReasons.size === 0) this.segmentStartedAt = now;
  }

  peek(now = performance.now()): number {
    if (!this.active || this.segmentStartedAt === null) return this.elapsedMs;
    return this.elapsedMs + Math.max(0, now - this.segmentStartedAt);
  }

  stop(now = performance.now()): number {
    if (this.active && this.pauseReasons.size === 0) this.flush(now);
    this.active = false;
    this.segmentStartedAt = null;
    this.pauseReasons.clear();
    return this.elapsedMs;
  }

  private begin(elapsedMs: number, now: number): void {
    this.elapsedMs = elapsedMs;
    this.pauseReasons.clear();
    this.active = true;
    this.segmentStartedAt = now;
  }

  private flush(now: number): void {
    if (this.segmentStartedAt === null) return;
    this.elapsedMs += Math.max(0, now - this.segmentStartedAt);
    this.segmentStartedAt = null;
  }
}
