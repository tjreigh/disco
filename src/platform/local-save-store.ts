import type { SoloModeDefinition } from '../game/modes/mode.js';
import { parseSaveGame, stringifySaveGame } from '../game/save.js';
import type { SaveGameV1 } from '../game/save.js';

export const LOCAL_SAVE_KEY = 'disco.save.v1.current';

export interface SaveStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface LocalSaveStoreOptions {
  storage?: SaveStorage;
  key?: string;
}

/** Best-effort storage for the single current local autosave. */
export class LocalSaveStore {
  private readonly modesById: ReadonlyMap<string, SoloModeDefinition>;

  constructor(
    modes: readonly SoloModeDefinition[],
    private readonly options: LocalSaveStoreOptions = {},
  ) {
    this.modesById = new Map(
      modes.filter(mode => mode.persistence.enabled).map(mode => [mode.id, mode]),
    );
  }

  /** Reads and validates the current autosave, removing invalid data when possible. */
  read(): SaveGameV1 | null {
    const storage = this.storage();
    if (!storage) return null;

    let json: string | null;
    try {
      json = storage.getItem(this.key);
    } catch {
      return null;
    }
    if (json === null) return null;

    const save = this.parse(json);
    if (save) return save;

    this.removeFrom(storage);
    return null;
  }

  /** Replaces the current autosave. Invalid saves and storage failures are ignored. */
  write(save: SaveGameV1): void {
    const mode = this.modesById.get(save.modeId);
    if (!mode) return;
    const cleanSave = parseSaveGame(save, mode.rules);
    if (!cleanSave) return;

    const storage = this.storage();
    if (!storage) return;
    try {
      storage.setItem(this.key, stringifySaveGame(cleanSave));
    } catch {
      // Autosaving is best-effort and must never interrupt gameplay.
    }
  }

  /** Removes the current autosave. Storage failures are ignored. */
  remove(): void {
    const storage = this.storage();
    if (storage) this.removeFrom(storage);
  }

  private parse(json: string): SaveGameV1 | null {
    let value: unknown;
    try {
      value = JSON.parse(json) as unknown;
    } catch {
      return null;
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;

    const modeId = (value as Record<string, unknown>).modeId;
    if (typeof modeId !== 'string') return null;
    const mode = this.modesById.get(modeId);
    return mode ? parseSaveGame(value, mode.rules) : null;
  }

  private removeFrom(storage: SaveStorage): void {
    try {
      storage.removeItem(this.key);
    } catch {
      // Invalid data may remain when storage is unavailable; reads still ignore it.
    }
  }

  private storage(): SaveStorage | null {
    if (this.options.storage) return this.options.storage;
    try {
      return typeof window === 'undefined' ? null : window.localStorage;
    } catch {
      return null;
    }
  }

  private get key(): string {
    return this.options.key ?? LOCAL_SAVE_KEY;
  }
}
