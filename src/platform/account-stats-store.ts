import type { SoloModeDefinition } from '../game/modes/index.js';
import { emptyStats } from '../game/stats.js';
import type { GameStats } from '../game/stats.js';
import { loadStats as loadCookieStats, saveStats as saveCookieStats } from './cookie-stats-store.js';
import { ApiRequestError, ApiUnauthorizedError, DiscoApiClient } from './api-client.js';
import type { AuthState } from './api-client.js';
import { browserStorage } from './browser-storage.js';

export interface AccountStatsState extends AuthState {
  loading: boolean;
  apiAvailable: boolean;
}

type Listener = () => void;
type StatsModeDefinition = Pick<SoloModeDefinition, 'id' | 'stats'>;

interface StatsStoreApi {
  login(provider?: string): void;
  logout(): Promise<void>;
  me(): Promise<AuthState>;
  getStats(): Promise<Array<{ modeId: string } & GameStats>>;
  putStats(modeId: string, stats: GameStats): Promise<{ modeId: string } & GameStats>;
  submitScore(modeId: string, score: number, longestStreak: number, stats: GameStats): Promise<{ modeId: string } & GameStats>;
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface AccountStatsStoreOptions {
  api?: StatsStoreApi;
  loadCookieStats?: (modeId: string) => GameStats;
  saveCookieStats?: (modeId: string, stats: GameStats) => void;
  storage?: StorageLike;
}

function cloneStats(stats: GameStats): GameStats {
  return {
    highScore: stats.highScore,
    longestStreak: stats.longestStreak,
    averageScore: stats.averageScore,
    gamesPlayed: stats.gamesPlayed,
    totalScore: stats.totalScore,
    // Tolerate responses from an older API during a backend-first rollout.
    totalPlayTimeMs: stats.totalPlayTimeMs ?? 0,
    totalDiscsDropped: stats.totalDiscsDropped ?? 0,
    totalDiscsBroken: stats.totalDiscsBroken ?? 0,
  };
}

export function mergeLocalAndRemoteStats(local: GameStats, remote: GameStats): GameStats {
  const gamesPlayed = local.gamesPlayed + remote.gamesPlayed;
  const totalScore = local.totalScore + remote.totalScore;
  return {
    highScore: Math.max(local.highScore, remote.highScore),
    longestStreak: Math.max(local.longestStreak, remote.longestStreak),
    gamesPlayed,
    totalScore,
    totalPlayTimeMs: local.totalPlayTimeMs + remote.totalPlayTimeMs,
    totalDiscsDropped: local.totalDiscsDropped + remote.totalDiscsDropped,
    totalDiscsBroken: local.totalDiscsBroken + remote.totalDiscsBroken,
    averageScore: gamesPlayed > 0 ? Math.round(totalScore / gamesPlayed) : 0,
  };
}

function mergeLocalRecordsIntoRemoteStats(local: GameStats, remote: GameStats): GameStats {
  const gamesPlayed = Math.max(local.gamesPlayed, remote.gamesPlayed);
  const totalScore = Math.max(local.totalScore, remote.totalScore);
  return {
    highScore: Math.max(local.highScore, remote.highScore),
    longestStreak: Math.max(local.longestStreak, remote.longestStreak),
    gamesPlayed,
    totalScore,
    totalPlayTimeMs: Math.max(local.totalPlayTimeMs, remote.totalPlayTimeMs),
    totalDiscsDropped: Math.max(local.totalDiscsDropped, remote.totalDiscsDropped),
    totalDiscsBroken: Math.max(local.totalDiscsBroken, remote.totalDiscsBroken),
    averageScore: gamesPlayed > 0 ? Math.round(totalScore / gamesPlayed) : 0,
  };
}

function hasBetterLocalRecords(local: GameStats, remote: GameStats): boolean {
  return local.highScore > remote.highScore
    || local.longestStreak > remote.longestStreak
    || local.totalPlayTimeMs > remote.totalPlayTimeMs
    || local.totalScore > remote.totalScore
    || local.gamesPlayed > remote.gamesPlayed
    || local.totalDiscsDropped > remote.totalDiscsDropped
    || local.totalDiscsBroken > remote.totalDiscsBroken;
}

function hasStats(stats: GameStats): boolean {
  return stats.highScore > 0 || stats.longestStreak > 0 || stats.gamesPlayed > 0 || stats.totalScore > 0;
}

export class AccountStatsStore {
  readonly ready: Promise<void>;
  private readonly apiClient: StatsStoreApi;
  private readonly statsByMode = new Map<string, GameStats>();
  private readonly listeners = new Set<Listener>();
  private readonly importedAccounts = new Set<string>();
  private state: AccountStatsState = {
    account: null,
    identities: [],
    loading: true,
    apiAvailable: true,
  };

  constructor(
    private readonly modes: readonly StatsModeDefinition[],
    private readonly options: AccountStatsStoreOptions = {},
  ) {
    this.apiClient = options.api ?? new DiscoApiClient();
    for (const mode of modes.filter(candidate => candidate.stats.enabled)) {
      this.statsByMode.set(mode.id, this.loadCookieStats(mode.id));
    }
    this.ready = this.refresh();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getState(): AccountStatsState {
    return {
      account: this.state.account,
      identities: [...this.state.identities],
      loading: this.state.loading,
      apiAvailable: this.state.apiAvailable,
    };
  }

  login(provider = 'google'): void {
    this.api.login(provider);
  }

  async logout(): Promise<void> {
    try {
      await this.api.logout();
    } catch {
      // Treat failed logout as local logout so the UI does not stay stuck.
    }
    this.state = { account: null, identities: [], loading: false, apiAvailable: true };
    for (const mode of this.modes.filter(candidate => candidate.stats.enabled)) {
      this.statsByMode.set(mode.id, this.loadCookieStats(mode.id));
    }
    this.emit();
  }

  loadStats(modeId: string): GameStats {
    return cloneStats(this.statsByMode.get(modeId) ?? emptyStats());
  }

  saveStats(modeId: string, stats: GameStats): void {
    const copy = cloneStats(stats);
    this.statsByMode.set(modeId, copy);
    this.saveCookieStats(modeId, copy);
    if (this.state.account) {
      void this.api.putStats(modeId, copy).catch(error => this.handleApiError(error));
    }
  }

  recordCompletedGame(modeId: string, stats: GameStats, score: number, longestStreak: number): void {
    const copy = cloneStats(stats);
    this.statsByMode.set(modeId, copy);
    this.saveCookieStats(modeId, copy);
    if (this.state.account) {
      void this.api.submitScore(modeId, score, longestStreak, copy)
        .then(saved => {
          const persisted = cloneStats(saved);
          this.statsByMode.set(modeId, persisted);
          this.saveCookieStats(modeId, persisted);
          this.emit();
        })
        .catch(error => this.handleApiError(error));
    }
  }

  private async refresh(): Promise<void> {
    try {
      const auth = await this.api.me();
      this.state = { ...auth, loading: false, apiAvailable: true };
      if (auth.account) {
        await this.loadAccountStats(auth.account.id);
      }
    } catch (error) {
      if (error instanceof ApiUnauthorizedError) {
        this.state = { account: null, identities: [], loading: false, apiAvailable: true };
      } else {
        this.state = { account: null, identities: [], loading: false, apiAvailable: false };
      }
    }
    this.emit();
  }

  private async loadAccountStats(accountId: string): Promise<void> {
    const remoteStats = new Map((await this.api.getStats()).map(stats => [stats.modeId, cloneStats(stats)]));
    const importedKey = `disco_imported_account_${accountId}`;
    const shouldImport = !this.hasImportedLocalStats(importedKey);

    for (const mode of this.modes.filter(candidate => candidate.stats.enabled)) {
      const local = this.loadCookieStats(mode.id);
      const remote = remoteStats.get(mode.id) ?? emptyStats();
      const shouldImportLocalStats = shouldImport && hasStats(local);
      const next = shouldImportLocalStats
        ? mergeLocalAndRemoteStats(local, remote)
        : mergeLocalRecordsIntoRemoteStats(local, remote);
      this.statsByMode.set(mode.id, next);
      this.saveCookieStats(mode.id, next);
      if (shouldImportLocalStats || hasBetterLocalRecords(local, remote)) {
        await this.api.putStats(mode.id, next);
      }
    }

    this.markImportedLocalStats(importedKey);
  }

  private hasImportedLocalStats(key: string): boolean {
    try {
      if (!this.storage) return this.importedAccounts.has(key);
      return this.storage.getItem(key) === '1';
    } catch {
      return this.importedAccounts.has(key);
    }
  }

  private markImportedLocalStats(key: string): void {
    try {
      if (!this.storage) {
        this.importedAccounts.add(key);
        return;
      }
      this.storage.setItem(key, '1');
    } catch {
      this.importedAccounts.add(key);
    }
  }

  private handleApiError(error: unknown): void {
    if (error instanceof ApiUnauthorizedError) {
      this.state = { account: null, identities: [], loading: false, apiAvailable: true };
    } else if (error instanceof ApiRequestError) {
      // The server is reachable; it rejected this one request. Don't flip the
      // whole UI to "Playing offline" (audit-2 finding #1) — keep the session
      // and surface nothing. Cookie stats were already saved by the caller.
      console.warn('disco: stats sync rejected by API', error.status);
    } else {
      this.state = { ...this.state, loading: false, apiAvailable: false };
    }
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  private get api(): StatsStoreApi {
    return this.apiClient;
  }

  private get storage(): StorageLike | null {
    return this.options.storage ?? browserStorage();
  }

  private loadCookieStats(modeId: string): GameStats {
    return (this.options.loadCookieStats ?? loadCookieStats)(modeId);
  }

  private saveCookieStats(modeId: string, stats: GameStats): void {
    (this.options.saveCookieStats ?? saveCookieStats)(modeId, stats);
  }
}
