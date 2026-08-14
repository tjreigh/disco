import { browserStorage } from './browser-storage.js';

export const USER_SETTINGS_STORAGE_KEY = 'disco.user-settings';

// Shared with ZoomControls' gesture clamp, which already imports this module
// for UserSettingsStore itself — defining the range here (rather than in
// zoom-controls.ts and importing it back) avoids a circular import.
export const MIN_ZOOM = 1;
export const MAX_ZOOM = 2.5;

export interface UserSettings {
  advancedHud: boolean;
  zoomLevel: number;
}

const DEFAULT_SETTINGS: UserSettings = {
  advancedHud: false,
  zoomLevel: MIN_ZOOM,
};

type SettingsStorage = Pick<Storage, 'getItem' | 'setItem'>;

/** Local, device-specific presentation preferences that do not belong in game saves. */
export class UserSettingsStore {
  private settings: UserSettings;

  constructor(private readonly storage: SettingsStorage | null = browserStorage()) {
    this.settings = this.load(DEFAULT_SETTINGS);
  }

  get(): Readonly<UserSettings> {
    return this.settings;
  }

  setAdvancedHud(enabled: boolean): void {
    this.settings = { ...this.load(this.settings), advancedHud: enabled };
    this.persist();
  }

  setZoomLevel(level: number): void {
    // Math.min/Math.max both propagate NaN rather than ignoring it, so a
    // non-finite input (e.g. a divide-by-zero upstream) would otherwise
    // silently corrupt this.settings.zoomLevel to NaN — and JSON.stringify
    // serializes NaN as `null`, corrupting the persisted value too.
    const safeLevel = Number.isFinite(level) ? level : MIN_ZOOM;
    const zoomLevel = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, safeLevel));
    this.settings = { ...this.load(this.settings), zoomLevel };
    this.persist();
  }

  // Reloads from storage and decodes each field independently, defaulting
  // any missing/invalid field to the matching field on `fallback` rather
  // than rejecting the whole payload. This does two jobs depending on the
  // caller: at construction, `fallback` is DEFAULT_SETTINGS, so a legacy
  // payload saved before a field existed (e.g. `zoomLevel`) still migrates
  // cleanly instead of resetting every field. From a setter, `fallback` is
  // this instance's current in-memory `this.settings`, so with two
  // UserSettingsStore instances alive at once (the mode controller's and
  // ZoomControls') each setter re-reads the latest persisted value for the
  // *other* instance's field before writing its own, instead of stomping it
  // with a stale cached copy — and if the storage read itself fails, the
  // setter falls back to this instance's own current values rather than
  // discarding whatever it already changed this session.
  private load(fallback: UserSettings): UserSettings {
    if (!this.storage) return fallback;
    try {
      const raw = this.storage.getItem(USER_SETTINGS_STORAGE_KEY);
      if (!raw) return fallback;
      const value = JSON.parse(raw) as unknown;
      if (typeof value !== 'object' || value === null) return fallback;
      const v = value as Record<string, unknown>;
      return {
        advancedHud: typeof v.advancedHud === 'boolean' ? v.advancedHud : fallback.advancedHud,
        zoomLevel: typeof v.zoomLevel === 'number' && Number.isFinite(v.zoomLevel)
          && v.zoomLevel >= MIN_ZOOM && v.zoomLevel <= MAX_ZOOM
          ? v.zoomLevel : fallback.zoomLevel,
      };
    } catch {
      return fallback;
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
