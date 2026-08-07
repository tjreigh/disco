// @vitest-environment happy-dom

import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  USER_SETTINGS_STORAGE_KEY,
  UserSettingsStore,
} from '../../platform/user-settings-store.js';

describe('UserSettingsStore', () => {
  beforeEach(() => window.localStorage.removeItem(USER_SETTINGS_STORAGE_KEY));

  test('defaults Advanced HUD off and zoom at 1x, and persists changes', () => {
    const store = new UserSettingsStore(window.localStorage);
    expect(store.get()).toEqual({ advancedHud: false, zoomLevel: 1 });

    store.setAdvancedHud(true);
    store.setZoomLevel(1.75);

    expect(new UserSettingsStore(window.localStorage).get())
      .toEqual({ advancedHud: true, zoomLevel: 1.75 });
  });

  test('clamps zoom level to the supported range', () => {
    const store = new UserSettingsStore(window.localStorage);

    store.setZoomLevel(10);
    expect(store.get().zoomLevel).toBe(2.5);

    store.setZoomLevel(0);
    expect(store.get().zoomLevel).toBe(1);
  });

  test('falls back safely for invalid or unavailable storage', () => {
    window.localStorage.setItem(USER_SETTINGS_STORAGE_KEY, '{bad json');
    expect(new UserSettingsStore(window.localStorage).get()).toEqual({ advancedHud: false, zoomLevel: 1 });

    const unavailable = {
      getItem: vi.fn(() => { throw new Error('blocked'); }),
      setItem: vi.fn(() => { throw new Error('blocked'); }),
    };
    const store = new UserSettingsStore(unavailable);
    expect(store.get()).toEqual({ advancedHud: false, zoomLevel: 1 });
    expect(() => store.setAdvancedHud(true)).not.toThrow();
    expect(store.get()).toEqual({ advancedHud: true, zoomLevel: 1 });
  });

  test('migrates a legacy payload saved before zoomLevel existed', () => {
    window.localStorage.setItem(USER_SETTINGS_STORAGE_KEY, JSON.stringify({ advancedHud: true }));

    expect(new UserSettingsStore(window.localStorage).get()).toEqual({ advancedHud: true, zoomLevel: 1 });
  });

  test('two live instances do not stomp each other\'s field on write', () => {
    const hudInstance = new UserSettingsStore(window.localStorage);
    const zoomInstance = new UserSettingsStore(window.localStorage);

    hudInstance.setAdvancedHud(true);
    zoomInstance.setZoomLevel(1.5);

    expect(new UserSettingsStore(window.localStorage).get())
      .toEqual({ advancedHud: true, zoomLevel: 1.5 });
  });

  test('a storage read failure falls back to this instance\'s current values, not defaults', () => {
    const backing = new Map<string, string>();
    const flaky = {
      getItem: vi.fn(() => { throw new Error('blocked'); }),
      setItem: vi.fn((key: string, value: string) => { backing.set(key, value); }),
    };
    const store = new UserSettingsStore(flaky);

    store.setAdvancedHud(true);
    store.setZoomLevel(2);

    expect(store.get()).toEqual({ advancedHud: true, zoomLevel: 2 });
  });
});
