import { describe, expect, test, vi } from 'vitest';
import { DiscKind } from '../../game/model.js';
import { CLASSIC_MODE, GAME_MODES, GRAVITY_MODE } from '../../game/modes/index.js';
import type { GameModeConfig } from '../../game/modes/mode.js';
import {
  SAVE_GAME_RULES_VERSION,
  SAVE_GAME_VERSION,
} from '../../game/save.js';
import type { SaveGameV1 } from '../../game/save.js';
import { ApiSaveConflictError, ApiUnauthorizedError } from '../../platform/api-client.js';
import type { ApiSaveSlot, AuthState, PutSaveRequest } from '../../platform/api-client.js';
import { LOCAL_SAVE_KEY } from '../../platform/local-save-store.js';
import type { SaveStorage } from '../../platform/local-save-store.js';
import {
  LAST_SAVE_ACCOUNT_KEY,
  SAVE_SYNC_KEY_PREFIX,
  SyncedSaveStore,
} from '../../platform/synced-save-store.js';

function validSave(mode: GameModeConfig = CLASSIC_MODE, overrides: { score?: number; savedAt?: number } = {}): SaveGameV1 {
  return {
    version: SAVE_GAME_VERSION,
    rulesVersion: SAVE_GAME_RULES_VERSION,
    savedAt: overrides.savedAt ?? 1_725_000_000_000,
    modeId: mode.id,
    state: {
      phase: 'waiting',
      board: Array.from(
        { length: mode.board.rows },
        () => Array.from({ length: mode.board.cols }, () => null),
      ),
      cursorCol: 2,
      score: overrides.score ?? 12_345,
      dropCount: 9,
      level: 1,
      turnsPerLevel: mode.initialTurnsPerLevel,
      turnsRemaining: mode.initialTurnsPerLevel - 9,
      ...(mode.gravity ? { gravity: { angle: mode.gravity.initialAngleDeg } } : {}),
    },
    generation: {
      source: 'seeded',
      seed: 123,
      queue: [
        { value: mode.discValueMin, kind: DiscKind.Numbered },
        { value: mode.discValueMax, kind: DiscKind.DoubleCracked },
        { value: mode.discValueMin, kind: DiscKind.Numbered },
      ],
      playableGenerator: {
        recentValues: [mode.discValueMin, mode.discValueMax, mode.discValueMin],
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

  constructor(seed: Record<string, string> = {}) {
    for (const [key, value] of Object.entries(seed)) this.values.set(key, value);
  }

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

function accountAuth(id = 'account-1'): AuthState {
  return { account: { id, displayName: 'Player One' }, identities: [] };
}

function slot(
  modeId: string,
  revision: number,
  save: SaveGameV1 | null,
  runId = save ? `00000000-0000-4000-8000-00000000000${revision}` : null,
): ApiSaveSlot {
  return { modeId, revision, runId, save, updatedAt: `2026-07-${String(revision).padStart(2, '0')}T00:00:00.000Z` };
}

function api(options: {
  auth?: AuthState | null;
  saves?: ApiSaveSlot[];
  put?: (modeId: string, request: PutSaveRequest) => Promise<ApiSaveSlot>;
} = {}) {
  let revision = Math.max(0, ...(options.saves ?? []).map(save => save.revision));
  return {
    me: vi.fn(async () => {
      if (options.auth === null) throw new ApiUnauthorizedError();
      return options.auth ?? accountAuth();
    }),
    getSaves: vi.fn(async () => options.saves ?? []),
    putSave: vi.fn(options.put ?? (async (modeId: string, request: PutSaveRequest) => {
      revision++;
      return slot(modeId, revision, request.save, request.runId);
    })),
  };
}

function record(save: SaveGameV1 | null, options: { revision?: number; dirty?: boolean; runId?: string | null } = {}) {
  return JSON.stringify({
    storageVersion: 1,
    runId: options.runId === undefined
      ? (save ? '00000000-0000-4000-8000-000000000099' : null)
      : options.runId,
    remoteRevision: options.revision ?? 0,
    dirty: options.dirty ?? true,
    save,
  });
}

describe('SyncedSaveStore', () => {
  test('migrates the legacy single save into its guest mode without overwriting an existing record', async () => {
    const classic = validSave(CLASSIC_MODE, { score: 100 });
    const gravity = validSave(GRAVITY_MODE, { score: 200 });
    const storage = new MemoryStorage({
      [LOCAL_SAVE_KEY]: JSON.stringify(classic),
      [`${SAVE_SYNC_KEY_PREFIX}.guest.${GRAVITY_MODE.id}`]: record(gravity),
    });
    const store = new SyncedSaveStore(GAME_MODES, {
      api: api({ auth: null }),
      storage,
      createRunId: () => '00000000-0000-4000-8000-000000000001',
    });

    await store.ready;

    expect(store.read(CLASSIC_MODE.id)?.state.score).toBe(100);
    expect(store.read(GRAVITY_MODE.id)?.state.score).toBe(200);
    expect(storage.values.has(LOCAL_SAVE_KEY)).toBe(false);
    expect(JSON.parse(storage.values.get(`${SAVE_SYNC_KEY_PREFIX}.guest.classic`)!).dirty).toBe(true);
  });

  test('retains the legacy save when writing the migrated record fails', async () => {
    const classic = validSave(CLASSIC_MODE, { score: 100 });
    const storage = new MemoryStorage({ [LOCAL_SAVE_KEY]: JSON.stringify(classic) });
    vi.spyOn(storage, 'setItem').mockImplementation(() => { throw new Error('quota exceeded'); });

    const store = new SyncedSaveStore(GAME_MODES, {
      api: api({ auth: null }),
      storage,
      autoInitialize: false,
    });
    await store.ready;

    expect(storage.values.has(LOCAL_SAVE_KEY)).toBe(true);
    expect(storage.values.has(`${SAVE_SYNC_KEY_PREFIX}.guest.classic`)).toBe(false);
  });

  test('keeps independent saves for each mode and isolates account storage', async () => {
    const storage = new MemoryStorage();
    const store = new SyncedSaveStore(GAME_MODES, { api: api({ auth: null }), storage });
    await store.ready;

    store.write('classic', validSave(CLASSIC_MODE, { score: 11 }));
    store.write('gravity', validSave(GRAVITY_MODE, { score: 22 }));
    expect(store.read('classic')?.state.score).toBe(11);
    expect(store.read('gravity')?.state.score).toBe(22);

    await store.setAuthState(accountAuth('account-a'));
    expect(store.read('classic')?.state.score).toBe(11); // guest import
    await store.setAuthState(accountAuth('account-b'));
    expect(store.read('classic')).toBeNull();
    expect(storage.values.has(`${SAVE_SYNC_KEY_PREFIX}.account.account-a.classic`)).toBe(true);
  });

  test('recovers a cloud-only save and caches a clean account record', async () => {
    const cloud = validSave(CLASSIC_MODE, { score: 500 });
    const storage = new MemoryStorage();
    const store = new SyncedSaveStore(GAME_MODES, {
      api: api({ saves: [slot('classic', 4, cloud)] }),
      storage,
    });

    await store.ready;

    expect(store.read('classic')?.state.score).toBe(500);
    expect(JSON.parse(storage.values.get(`${SAVE_SYNC_KEY_PREFIX}.account.account-1.classic`)!)).toMatchObject({
      remoteRevision: 4,
      dirty: false,
    });
  });

  test('uploads a guest save against a cloud tombstone and removes guest only after success', async () => {
    const guest = validSave(CLASSIC_MODE, { score: 700 });
    const storage = new MemoryStorage({
      [LAST_SAVE_ACCOUNT_KEY]: 'account-1',
      [`${SAVE_SYNC_KEY_PREFIX}.account.account-1.classic`]: record(null, { revision: 3, dirty: false }),
      [`${SAVE_SYNC_KEY_PREFIX}.guest.classic`]: record(guest),
    });
    const client = api({ saves: [slot('classic', 3, null)] });
    const store = new SyncedSaveStore(GAME_MODES, { api: client, storage });

    await store.ready;

    expect(client.putSave).toHaveBeenCalledWith('classic', expect.objectContaining({
      expectedRevision: 3,
      save: expect.objectContaining({ state: expect.objectContaining({ score: 700 }) }),
    }));
    expect(storage.values.has(`${SAVE_SYNC_KEY_PREFIX}.guest.classic`)).toBe(false);
    expect(store.read('classic')?.state.score).toBe(700);
  });

  test('ignores a stale save listing after logout', async () => {
    let finishListing!: (slots: ApiSaveSlot[]) => void;
    const listing = new Promise<ApiSaveSlot[]>(resolve => { finishListing = resolve; });
    const cloud = validSave(CLASSIC_MODE, { score: 500 });
    const client = api();
    client.getSaves.mockImplementationOnce(async () => await listing);
    const storage = new MemoryStorage();
    const store = new SyncedSaveStore(GAME_MODES, { api: client, storage });

    await vi.waitFor(() => expect(client.getSaves).toHaveBeenCalled());
    await store.setAuthState(null);
    finishListing([slot('classic', 4, cloud)]);
    await store.ready;

    expect(store.getState()).toMatchObject({ scope: 'guest', accountId: null });
    expect(store.read('classic')).toBeNull();
    expect(storage.values.has(`${SAVE_SYNC_KEY_PREFIX}.guest.classic`)).toBe(false);
  });

  test('ignores a stale upload response after logout', async () => {
    let finishUpload!: (saved: ApiSaveSlot) => void;
    const upload = new Promise<ApiSaveSlot>(resolve => { finishUpload = resolve; });
    let request!: PutSaveRequest;
    const client = api({
      put: async (_modeId, nextRequest) => {
        request = nextRequest;
        return await upload;
      },
    });
    const guest = validSave(CLASSIC_MODE, { score: 900 });
    const storage = new MemoryStorage();
    const store = new SyncedSaveStore(GAME_MODES, { api: client, storage });
    await store.ready;
    storage.setItem(`${SAVE_SYNC_KEY_PREFIX}.guest.classic`, record(guest));

    store.write('classic', validSave(CLASSIC_MODE, { score: 100 }));
    await vi.waitFor(() => expect(client.putSave).toHaveBeenCalled());
    await store.setAuthState(null);
    finishUpload(slot('classic', 1, request.save, request.runId));
    await vi.waitFor(() => expect(
      (store as unknown as { flushPromises: Map<string, Promise<void>> }).flushPromises.size,
    ).toBe(0));

    expect(store.read('classic')?.state.score).toBe(900);
    expect(JSON.parse(storage.values.get(`${SAVE_SYNC_KEY_PREFIX}.guest.classic`)!)).toMatchObject({
      remoteRevision: 0,
      save: { state: { score: 900 } },
    });
  });

  test('retains guest and cloud choices as a conflict when both are live', async () => {
    const guest = validSave(CLASSIC_MODE, { score: 700 });
    const cloud = validSave(CLASSIC_MODE, { score: 900 });
    const storage = new MemoryStorage({
      [`${SAVE_SYNC_KEY_PREFIX}.guest.classic`]: record(guest),
    });
    const client = api({ saves: [slot('classic', 3, cloud)] });
    const store = new SyncedSaveStore(GAME_MODES, { api: client, storage });

    await store.ready;

    expect(store.getConflict('classic')).toMatchObject({
      kind: 'diverged',
      localScope: 'guest',
      local: { state: { score: 700 } },
      cloud: { state: { score: 900 } },
      cloudRevision: 3,
    });
    expect(client.putSave).not.toHaveBeenCalled();

    store.resolveConflict('classic', 'cloud');
    expect(store.read('classic')?.state.score).toBe(900);
    expect(storage.values.has(`${SAVE_SYNC_KEY_PREFIX}.guest.classic`)).toBe(false);
  });

  test('detects a changed remote revision and can overwrite it with the local choice', async () => {
    const local = validSave(CLASSIC_MODE, { score: 700 });
    const cloud = validSave(CLASSIC_MODE, { score: 900 });
    const storage = new MemoryStorage({
      [LAST_SAVE_ACCOUNT_KEY]: 'account-1',
      [`${SAVE_SYNC_KEY_PREFIX}.account.account-1.classic`]: record(local, { revision: 2 }),
    });
    const client = api({ saves: [slot('classic', 3, cloud)] });
    const store = new SyncedSaveStore(GAME_MODES, { api: client, storage });
    await store.ready;

    expect(store.getConflict('classic')).toMatchObject({
      kind: 'diverged',
      localScope: 'account',
      cloudRevision: 3,
    });
    store.resolveConflict('classic', 'local');
    await vi.waitFor(() => expect(client.putSave).toHaveBeenCalledWith('classic', expect.objectContaining({
      expectedRevision: 3,
      save: expect.objectContaining({ state: expect.objectContaining({ score: 700 }) }),
    })));
  });

  test('turns a 409 during background upload into a deferred conflict', async () => {
    const cloud = validSave(CLASSIC_MODE, { score: 900 });
    const client = api({
      saves: [],
      put: async () => { throw new ApiSaveConflictError(slot('classic', 2, cloud)); },
    });
    const store = new SyncedSaveStore(GAME_MODES, { api: client, storage: new MemoryStorage() });
    await store.ready;

    store.write('classic', validSave(CLASSIC_MODE, { score: 100 }));
    await vi.waitFor(() => expect(store.getConflict('classic')).toMatchObject({
      kind: 'diverged',
      cloudRevision: 2,
    }));
    expect(store.read('classic')?.state.score).toBe(100);
  });

  test('keeps a deferred conflict while gameplay continues and updates its local choice', async () => {
    const cloud = validSave(CLASSIC_MODE, { score: 900 });
    const client = api({ saves: [slot('classic', 3, cloud)] });
    const storage = new MemoryStorage({
      [LAST_SAVE_ACCOUNT_KEY]: 'account-1',
      [`${SAVE_SYNC_KEY_PREFIX}.account.account-1.classic`]: record(
        validSave(CLASSIC_MODE, { score: 100 }),
        { revision: 2 },
      ),
    });
    const store = new SyncedSaveStore(GAME_MODES, { api: client, storage });
    await store.ready;

    store.write('classic', validSave(CLASSIC_MODE, { score: 200 }));
    expect(store.getConflict('classic')).toMatchObject({
      kind: 'diverged',
      local: { state: { score: 200 } },
      cloud: { state: { score: 900 } },
    });
    expect(client.putSave).not.toHaveBeenCalled();

    store.remove('classic');
    expect(store.getConflict('classic')).toMatchObject({ local: null, cloudRevision: 3 });
    expect(client.putSave).not.toHaveBeenCalled();
  });

  test('coalesces a write made during an upload and sends it against the returned revision', async () => {
    let finishFirst!: (value: ApiSaveSlot) => void;
    const first = new Promise<ApiSaveSlot>(resolve => { finishFirst = resolve; });
    const requests: PutSaveRequest[] = [];
    const client = api({
      saves: [],
      put: async (modeId, request) => {
        requests.push(request);
        if (requests.length === 1) return await first;
        return slot(modeId, 2, request.save, request.runId);
      },
    });
    const store = new SyncedSaveStore(GAME_MODES, { api: client, storage: new MemoryStorage() });
    await store.ready;

    store.write('classic', validSave(CLASSIC_MODE, { score: 100 }));
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    store.write('classic', validSave(CLASSIC_MODE, { score: 200 }));
    finishFirst(slot('classic', 1, requests[0]!.save, requests[0]!.runId));

    await vi.waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[1]).toMatchObject({
      expectedRevision: 1,
      save: { state: { score: 200 } },
    });
    await vi.waitFor(() => expect(store.read('classic')?.state.score).toBe(200));
  });

  test('synchronizes a deletion as a tombstone without affecting other modes', async () => {
    const classic = validSave(CLASSIC_MODE, { score: 100 });
    const gravity = validSave(GRAVITY_MODE, { score: 200 });
    const client = api({ saves: [slot('classic', 1, classic), slot('gravity', 2, gravity)] });
    const store = new SyncedSaveStore(GAME_MODES, { api: client, storage: new MemoryStorage() });
    await store.ready;

    store.remove('classic');
    expect(store.read('classic')).toBeNull();
    expect(store.read('gravity')?.state.score).toBe(200);
    await vi.waitFor(() => expect(client.putSave).toHaveBeenCalledWith('classic', {
      expectedRevision: 1,
      runId: null,
      save: null,
    }));
  });

  test('uses the cached account scope offline but switches to guest on confirmed anonymous auth', async () => {
    const local = validSave(CLASSIC_MODE, { score: 333 });
    const storage = new MemoryStorage({
      [LAST_SAVE_ACCOUNT_KEY]: 'account-1',
      [`${SAVE_SYNC_KEY_PREFIX}.account.account-1.classic`]: record(local, { revision: 4, dirty: false }),
    });
    const offlineApi = api();
    offlineApi.me.mockRejectedValueOnce(new Error('offline'));
    const offlineStore = new SyncedSaveStore(GAME_MODES, { api: offlineApi, storage });
    await offlineStore.ready;
    expect(offlineStore.getState()).toMatchObject({ scope: 'account', accountId: 'account-1', apiAvailable: false });
    expect(offlineStore.read('classic')?.state.score).toBe(333);

    const anonymousStore = new SyncedSaveStore(GAME_MODES, { api: api({ auth: null }), storage });
    await anonymousStore.ready;
    expect(anonymousStore.getState()).toMatchObject({ scope: 'guest', accountId: null, apiAvailable: true });
    expect(anonymousStore.read('classic')).toBeNull();
    expect(storage.values.has(LAST_SAVE_ACCOUNT_KEY)).toBe(false);
  });

  test('surfaces malformed cloud payloads without deleting or overwriting them', async () => {
    const invalid = { ...validSave(CLASSIC_MODE), rulesVersion: 999 };
    const client = api({ saves: [slot('classic', 5, invalid as SaveGameV1)] });
    const store = new SyncedSaveStore(GAME_MODES, { api: client, storage: new MemoryStorage() });
    await store.ready;

    expect(store.read('classic')).toBeNull();
    expect(store.getConflict('classic')).toMatchObject({
      kind: 'invalid-cloud',
      cloud: null,
      cloudRevision: 5,
    });
    expect(client.putSave).not.toHaveBeenCalled();
  });
});
