import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { GameModeConfig } from '../../game/modes/index.js';
import type { GameStats } from '../../game/stats.js';
import { AccountStatsStore, mergeLocalAndRemoteStats } from '../../platform/account-stats-store.js';
import { ApiRequestError, ApiUnauthorizedError } from '../../platform/api-client.js';

const MODES = [
  { id: 'classic', name: 'Classic', tagline: 'Default mode' },
  { id: 'speed', name: 'Speed', tagline: 'Faster turns' },
] as const satisfies readonly Pick<GameModeConfig, 'id' | 'name' | 'tagline'>[];

const TEST_MODES = MODES as unknown as readonly GameModeConfig[];

function stats(overrides: Partial<GameStats> = {}): GameStats {
  return {
    highScore: 0,
    longestStreak: 0,
    averageScore: 0,
    gamesPlayed: 0,
    totalScore: 0,
    ...overrides,
  };
}

function cloneStats(value: GameStats): GameStats {
  return { ...value };
}

function makeMemoryStorage(seed: Record<string, string> = {}) {
  const values = new Map(Object.entries(seed));
  return {
    getItem(key: string): string | null {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string): void {
      values.set(key, value);
    },
  };
}

function createApi(options: {
  me?: () => Promise<{ account: { id: string; displayName: string | null } | null; identities: [] }>;
  remoteStats?: Record<string, GameStats>;
}) {
  const remoteStats = new Map<string, GameStats>(
    Object.entries(options.remoteStats ?? {}).map(([modeId, value]) => [modeId, cloneStats(value)]),
  );

  return {
    login: vi.fn(),
    logout: vi.fn(async () => undefined),
    me: vi.fn(options.me ?? (async () => ({
      account: { id: 'account-1', displayName: 'Player One' },
      identities: [],
    }))),
    getStats: vi.fn(async () => Array.from(remoteStats.entries()).map(([modeId, value]) => ({
      ...cloneStats(value),
      accountId: 'account-1',
      modeId,
      updatedAt: '2026-07-09T00:00:00.000Z',
    }))),
    putStats: vi.fn(async (modeId: string, value: GameStats) => {
      remoteStats.set(modeId, cloneStats(value));
      return {
        ...cloneStats(value),
        accountId: 'account-1',
        modeId,
        updatedAt: '2026-07-09T00:00:00.000Z',
      };
    }),
    submitScore: vi.fn(async (modeId: string, _score: number, _longestStreak: number, value: GameStats) => {
      remoteStats.set(modeId, cloneStats(value));
      return {
        ...cloneStats(value),
        accountId: 'account-1',
        modeId,
        updatedAt: '2026-07-09T00:00:00.000Z',
      };
    }),
  };
}

describe('AccountStatsStore', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  test('merges local and remote totals while keeping the highest live records', () => {
    expect(mergeLocalAndRemoteStats(
      stats({ highScore: 1200, longestStreak: 3, gamesPlayed: 4, totalScore: 1800, averageScore: 450 }),
      stats({ highScore: 900, longestStreak: 5, gamesPlayed: 6, totalScore: 3300, averageScore: 550 }),
    )).toEqual({
      highScore: 1200,
      longestStreak: 5,
      gamesPlayed: 10,
      totalScore: 5100,
      averageScore: 510,
    });
  });

  test('imports guest cookie stats into the account once, then reuses synced remote stats', async () => {
    const localByMode = new Map<string, GameStats>([
      ['classic', stats({ highScore: 1000, longestStreak: 4, gamesPlayed: 3, totalScore: 1200, averageScore: 400 })],
      ['speed', stats()],
    ]);
    const saved: Array<{ modeId: string; stats: GameStats }> = [];
    const storage = makeMemoryStorage();
    const api = createApi({
      remoteStats: {
        classic: stats({ highScore: 800, longestStreak: 5, gamesPlayed: 2, totalScore: 900, averageScore: 450 }),
        speed: stats({ highScore: 50, longestStreak: 1, gamesPlayed: 1, totalScore: 50, averageScore: 50 }),
      },
    });

    const store = new AccountStatsStore(TEST_MODES, {
      api,
      storage,
      loadCookieStats: modeId => cloneStats(localByMode.get(modeId) ?? stats()),
      saveCookieStats: (modeId, value) => {
        saved.push({ modeId, stats: cloneStats(value) });
        localByMode.set(modeId, cloneStats(value));
      },
    });

    await store.ready;

    expect(store.getState()).toMatchObject({
      account: { id: 'account-1', displayName: 'Player One' },
      apiAvailable: true,
      loading: false,
    });
    expect(store.loadStats('classic')).toEqual({
      highScore: 1000,
      longestStreak: 5,
      gamesPlayed: 5,
      totalScore: 2100,
      averageScore: 420,
    });
    expect(api.putStats).toHaveBeenCalledTimes(1);
    expect(api.putStats).toHaveBeenCalledWith('classic', {
      highScore: 1000,
      longestStreak: 5,
      gamesPlayed: 5,
      totalScore: 2100,
      averageScore: 420,
    });
    expect(saved.at(-1)).toEqual({
      modeId: 'speed',
      stats: stats({ highScore: 50, longestStreak: 1, gamesPlayed: 1, totalScore: 50, averageScore: 50 }),
    });

    saved.length = 0;
    const secondStore = new AccountStatsStore(TEST_MODES, {
      api,
      storage,
      loadCookieStats: modeId => cloneStats(localByMode.get(modeId) ?? stats()),
      saveCookieStats: (modeId, value) => {
        saved.push({ modeId, stats: cloneStats(value) });
        localByMode.set(modeId, cloneStats(value));
      },
    });

    await secondStore.ready;

    expect(api.putStats).toHaveBeenCalledTimes(1);
    expect(secondStore.loadStats('classic')).toEqual({
      highScore: 1000,
      longestStreak: 5,
      gamesPlayed: 5,
      totalScore: 2100,
      averageScore: 420,
    });
  });

  test('promotes better local records on later sign-ins without reimporting totals', async () => {
    const localByMode = new Map<string, GameStats>([
      ['classic', stats({ highScore: 1500, longestStreak: 7, gamesPlayed: 10, totalScore: 5000, averageScore: 500 })],
    ]);
    const storage = makeMemoryStorage({ 'disco_imported_account_account-1': '1' });
    const api = createApi({
      remoteStats: {
        classic: stats({ highScore: 1000, longestStreak: 5, gamesPlayed: 2, totalScore: 900, averageScore: 450 }),
      },
    });

    const store = new AccountStatsStore(TEST_MODES, {
      api,
      storage,
      loadCookieStats: modeId => cloneStats(localByMode.get(modeId) ?? stats()),
      saveCookieStats: (modeId, value) => {
        localByMode.set(modeId, cloneStats(value));
      },
    });

    await store.ready;

    expect(store.loadStats('classic')).toEqual({
      highScore: 1500,
      longestStreak: 7,
      gamesPlayed: 2,
      totalScore: 900,
      averageScore: 450,
    });
    expect(api.putStats).toHaveBeenCalledTimes(1);
    expect(api.putStats).toHaveBeenCalledWith('classic', {
      highScore: 1500,
      longestStreak: 7,
      gamesPlayed: 2,
      totalScore: 900,
      averageScore: 450,
    });
  });

  test('falls back to guest cookie stats when the API is unavailable', async () => {
    const localClassic = stats({ highScore: 320, longestStreak: 2, gamesPlayed: 4, totalScore: 900, averageScore: 225 });
    const api = createApi({
      me: async () => {
        throw new Error('network down');
      },
    });

    const store = new AccountStatsStore(TEST_MODES, {
      api,
      loadCookieStats: modeId => modeId === 'classic' ? cloneStats(localClassic) : stats(),
      saveCookieStats: vi.fn(),
      storage: makeMemoryStorage(),
    });

    await store.ready;

    expect(store.getState()).toEqual({
      account: null,
      identities: [],
      loading: false,
      apiAvailable: false,
    });
    expect(store.loadStats('classic')).toEqual(localClassic);
  });

  test('treats unauthorized auth checks as guest mode instead of offline mode', async () => {
    const api = createApi({
      me: async () => {
        throw new ApiUnauthorizedError();
      },
    });

    const store = new AccountStatsStore(TEST_MODES, {
      api,
      loadCookieStats: () => stats(),
      saveCookieStats: vi.fn(),
      storage: makeMemoryStorage(),
    });

    await store.ready;

    expect(store.getState()).toEqual({
      account: null,
      identities: [],
      loading: false,
      apiAvailable: true,
    });
  });

  test('a rejected sync (4xx) does not flip the account offline', async () => {
    const api = createApi({});
    api.putStats.mockRejectedValueOnce(new ApiRequestError(400));

    const store = new AccountStatsStore(TEST_MODES, {
      api,
      loadCookieStats: () => stats(),
      saveCookieStats: vi.fn(),
      storage: makeMemoryStorage(),
    });

    await store.ready;
    store.saveStats('classic', stats({ highScore: 10, gamesPlayed: 1, totalScore: 10, averageScore: 10 }));
    await vi.waitFor(() => expect(api.putStats).toHaveBeenCalled());

    expect(store.getState()).toMatchObject({
      account: { id: 'account-1', displayName: 'Player One' },
      apiAvailable: true,
    });
  });

  test('a network failure during sync still flips the account offline', async () => {
    const api = createApi({});
    api.putStats.mockRejectedValueOnce(new TypeError('fetch failed'));

    const store = new AccountStatsStore(TEST_MODES, {
      api,
      loadCookieStats: () => stats(),
      saveCookieStats: vi.fn(),
      storage: makeMemoryStorage(),
    });

    await store.ready;
    store.saveStats('classic', stats({ highScore: 10, gamesPlayed: 1, totalScore: 10, averageScore: 10 }));
    await vi.waitFor(() => expect(store.getState().apiAvailable).toBe(false));
  });
});
