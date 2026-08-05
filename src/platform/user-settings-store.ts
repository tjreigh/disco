export const USER_SETTINGS_STORAGE_KEY = 'disco.user-settings';

export interface UserSettings {
  advancedHud: boolean;
}

const DEFAULT_SETTINGS: UserSettings = {
  advancedHud: false,
};

type SettingsStorage = Pick<Storage, 'getItem' | 'setItem'>;

/** Local, device-specific presentation preferences that do not belong in game saves. */
export class UserSettingsStore {
  private settings: UserSettings;

  constructor(private readonly storage: SettingsStorage | null = browserStorage()) {
    this.settings = this.load();
  }

  get(): Readonly<UserSettings> {
    return this.settings;
  }

  setAdvancedHud(enabled: boolean): void {
    this.settings = { ...this.settings, advancedHud: enabled };
    this.persist();
  }

  private load(): UserSettings {
    if (!this.storage) return { ...DEFAULT_SETTINGS };
    try {
      const raw = this.storage.getItem(USER_SETTINGS_STORAGE_KEY);
      if (!raw) return { ...DEFAULT_SETTINGS };
      const value = JSON.parse(raw) as unknown;
      if (!isSettings(value)) return { ...DEFAULT_SETTINGS };
      return { advancedHud: value.advancedHud };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  private persist(): void {
    if (!this.storage) return;
    try {
      this.storage.setItem(USER_SETTINGS_STORAGE_KEY, JSON.stringify(this.settings));
    } catch {
      // The preference still applies for this page when storage is unavailable.
    }
  }
}

function browserStorage(): SettingsStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

function isSettings(value: unknown): value is UserSettings {
  return typeof value === 'object'
    && value !== null
    && typeof (value as { advancedHud?: unknown }).advancedHud === 'boolean';
}
