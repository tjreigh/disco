// @vitest-environment happy-dom

import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  USER_SETTINGS_STORAGE_KEY,
  UserSettingsStore,
} from '../../platform/user-settings-store.js';

describe('UserSettingsStore', () => {
  beforeEach(() => window.localStorage.removeItem(USER_SETTINGS_STORAGE_KEY));

  test('defaults Advanced HUD off and persists changes', () => {
    const store = new UserSettingsStore(window.localStorage);
    expect(store.get()).toEqual({ advancedHud: false });

    store.setAdvancedHud(true);

    expect(new UserSettingsStore(window.localStorage).get()).toEqual({ advancedHud: true });
  });

  test('falls back safely for invalid or unavailable storage', () => {
    window.localStorage.setItem(USER_SETTINGS_STORAGE_KEY, '{bad json');
    expect(new UserSettingsStore(window.localStorage).get()).toEqual({ advancedHud: false });

    const unavailable = {
      getItem: vi.fn(() => { throw new Error('blocked'); }),
      setItem: vi.fn(() => { throw new Error('blocked'); }),
    };
    const store = new UserSettingsStore(unavailable);
    expect(store.get()).toEqual({ advancedHud: false });
    expect(() => store.setAdvancedHud(true)).not.toThrow();
    expect(store.get()).toEqual({ advancedHud: true });
  });
});
