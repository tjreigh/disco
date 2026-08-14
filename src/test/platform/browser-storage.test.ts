import { afterEach, describe, expect, test, vi } from 'vitest';
import { SOLO_MODES } from '../../game/modes/index.js';
import { emptyStats } from '../../game/stats.js';
import { AccountStatsStore } from '../../platform/account-stats-store.js';
import { browserStorage } from '../../platform/browser-storage.js';
import { LocalSaveStore } from '../../platform/local-save-store.js';
import { SyncedSaveStore } from '../../platform/synced-save-store.js';
import { UserSettingsStore } from '../../platform/user-settings-store.js';
import { resolveDebugPanelAccess } from '../../ui/debug/debug-panel.js';

afterEach(() => vi.unstubAllGlobals());

describe('browserStorage', () => {
  test('returns null when the localStorage property lookup throws', () => {
    vi.stubGlobal('window', throwingStorageWindow());
    expect(browserStorage()).toBeNull();
  });

  test('storage-backed consumers construct safely when the property lookup throws', async () => {
    vi.stubGlobal('window', throwingStorageWindow());

    expect(() => new UserSettingsStore()).not.toThrow();
    expect(() => new LocalSaveStore(SOLO_MODES)).not.toThrow();

    const synced = new SyncedSaveStore(SOLO_MODES, {
      api: {
        me: async () => ({ account: null, identities: [] }),
        getSaves: async () => [],
        putSave: async () => { throw new Error('not called'); },
      },
      autoInitialize: false,
    });
    await expect(synced.ready).resolves.toBeUndefined();

    const account = new AccountStatsStore(SOLO_MODES, {
      api: {
        login: () => undefined,
        logout: async () => undefined,
        me: async () => ({ account: null, identities: [] }),
        getStats: async () => [],
        putStats: async () => { throw new Error('not called'); },
        submitScore: async () => { throw new Error('not called'); },
      },
      loadCookieStats: () => emptyStats(),
      saveCookieStats: () => undefined,
    });
    await expect(account.ready).resolves.toBeUndefined();

    expect(() => resolveDebugPanelAccess({ hostname: 'example.test', search: '' })).not.toThrow();
  });
});

function throwingStorageWindow(): object {
  return Object.defineProperty({}, 'localStorage', {
    configurable: true,
    get: () => { throw new Error('storage blocked'); },
  });
}
