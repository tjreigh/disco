import { describe, expect, test } from 'vitest';
import { DiscKind } from '../../game/model.js';
import { CLASSIC_MODE, GAME_MODES } from '../../game/modes/index.js';
import {
  SAVE_GAME_RULES_VERSION,
  SAVE_GAME_VERSION,
  type SaveGameV1,
} from '../../game/save.js';
import {
  LOCAL_SAVE_KEY,
  LocalSaveStore,
  type SaveStorage,
} from '../../platform/local-save-store.js';

function validSave(): SaveGameV1 {
  return {
    version: SAVE_GAME_VERSION,
    rulesVersion: SAVE_GAME_RULES_VERSION,
    savedAt: 1_725_000_000_000,
    modeId: CLASSIC_MODE.id,
    state: {
      phase: 'waiting',
      board: Array.from(
        { length: CLASSIC_MODE.board.rows },
        () => Array.from({ length: CLASSIC_MODE.board.cols }, () => null),
      ),
      cursorCol: 2,
      score: 12_345,
      dropCount: 9,
      level: 1,
      turnsPerLevel: CLASSIC_MODE.initialTurnsPerLevel,
      turnsRemaining: CLASSIC_MODE.initialTurnsPerLevel - 9,
    },
    generation: {
      source: 'seeded',
      seed: 123,
      queue: [
        { value: 1, kind: DiscKind.Numbered },
        { value: 2, kind: DiscKind.DoubleCracked },
        { value: 3, kind: DiscKind.Numbered },
      ],
      playableGenerator: {
        recentValues: [1, 2, 3],
        recentKinds: [DiscKind.Numbered, DiscKind.DoubleCracked, DiscKind.Numbered],
      },
      random: { playableState: 456, pushState: 789 },
    },
    session: { longestStreak: 4 },
    meta: { source: 'autosave' },
  };
}

class MemoryStorage implements SaveStorage {
  readonly values = new Map<string, string>();
  readonly removed: string[] = [];

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.removed.push(key);
    this.values.delete(key);
  }
}

describe('LocalSaveStore', () => {
  test('writes, reads, and removes the single current autosave', () => {
    const storage = new MemoryStorage();
    const store = new LocalSaveStore(GAME_MODES, { storage });
    const save = validSave();

    store.write(save);
    expect(storage.values.get(LOCAL_SAVE_KEY)).toBe(JSON.stringify(save));
    expect(store.read()).toEqual(save);

    store.remove();
    expect(storage.values.has(LOCAL_SAVE_KEY)).toBe(false);
    expect(store.read()).toBeNull();
  });

  test('returns clean copies rather than trusting stored or previously returned objects', () => {
    const storage = new MemoryStorage();
    const store = new LocalSaveStore(GAME_MODES, { storage });
    const source = validSave();

    store.write(source);
    source.state.score = 1;
    const first = store.read()!;
    first.state.score = 2;
    first.generation.queue[0]!.value = 7;
    const second = store.read()!;

    expect(second.state.score).toBe(12_345);
    expect(second.generation.queue[0]!.value).toBe(1);
    expect(second).not.toBe(first);
  });

  test.each([
    ['invalid JSON', '{not json'],
    ['invalid structure', JSON.stringify({ modeId: 'classic' })],
    ['unknown mode', JSON.stringify({ ...validSave(), modeId: 'unknown' })],
    ['schema version mismatch', JSON.stringify({ ...validSave(), version: 2 })],
    ['rules version mismatch', JSON.stringify({ ...validSave(), rulesVersion: 2 })],
  ])('ignores and removes %s', (_label, json) => {
    const storage = new MemoryStorage();
    storage.values.set(LOCAL_SAVE_KEY, json);
    const store = new LocalSaveStore(GAME_MODES, { storage });

    expect(store.read()).toBeNull();
    expect(storage.removed).toEqual([LOCAL_SAVE_KEY]);
    expect(storage.values.has(LOCAL_SAVE_KEY)).toBe(false);
  });

  test('supports a dependency-injected storage key', () => {
    const storage = new MemoryStorage();
    const store = new LocalSaveStore(GAME_MODES, { storage, key: 'test.save' });

    store.write(validSave());
    expect(storage.values.has('test.save')).toBe(true);
    expect(storage.values.has(LOCAL_SAVE_KEY)).toBe(false);
  });

  test('ignores invalid values passed to write', () => {
    const storage = new MemoryStorage();
    const store = new LocalSaveStore(GAME_MODES, { storage });
    const invalid = { ...validSave(), rulesVersion: 2 } as unknown as SaveGameV1;

    expect(() => store.write(invalid)).not.toThrow();
    expect(storage.values.size).toBe(0);
  });

  test('swallows read, write, and remove failures', () => {
    const throwingStorage: SaveStorage = {
      getItem: () => { throw new Error('read disabled'); },
      setItem: () => { throw new Error('quota exceeded'); },
      removeItem: () => { throw new Error('remove disabled'); },
    };
    const store = new LocalSaveStore(GAME_MODES, { storage: throwingStorage });

    expect(() => store.write(validSave())).not.toThrow();
    expect(store.read()).toBeNull();
    expect(() => store.remove()).not.toThrow();
  });

  test('swallows removal failure while rejecting invalid stored data', () => {
    const storage: SaveStorage = {
      getItem: () => '{not json',
      setItem: () => undefined,
      removeItem: () => { throw new Error('remove disabled'); },
    };
    const store = new LocalSaveStore(GAME_MODES, { storage });

    expect(store.read()).toBeNull();
  });
});
