import type { GameModeConfig } from '../game/modes/mode.js';
import { parseSaveGame } from '../game/save.js';
import type { SaveGameV1 } from '../game/save.js';
import {
  ApiRequestError,
  ApiSaveConflictError,
  ApiUnauthorizedError,
  DiscoApiClient,
} from './api-client.js';
import type { ApiSaveSlot, AuthState, PublicAccount, PutSaveRequest } from './api-client.js';
import { LOCAL_SAVE_KEY } from './local-save-store.js';
import type { SaveStorage } from './local-save-store.js';

export const SAVE_SYNC_STORAGE_VERSION = 1 as const;
export const SAVE_SYNC_KEY_PREFIX = 'disco.save-sync.v1';
export const LAST_SAVE_ACCOUNT_KEY = `${SAVE_SYNC_KEY_PREFIX}.last-account`;

export interface SyncedSaveRecord {
  storageVersion: typeof SAVE_SYNC_STORAGE_VERSION;
  runId: string | null;
  remoteRevision: number;
  dirty: boolean;
  save: SaveGameV1 | null;
}

export interface SaveConflict {
  kind: 'diverged' | 'invalid-cloud';
  modeId: string;
  local: SaveGameV1 | null;
  cloud: SaveGameV1 | null;
  cloudRevision: number;
  cloudUpdatedAt: string;
  /** Guest means the local choice came from a pre-sign-in save. */
  localScope: 'account' | 'guest';
}

export type SaveConflictResolution = 'local' | 'cloud' | 'new';

export interface SyncedSaveStoreState {
  account: PublicAccount | null;
  accountId: string | null;
  scope: 'account' | 'guest';
  loading: boolean;
  apiAvailable: boolean;
}

export interface SaveSyncApi {
  me(): Promise<AuthState>;
  getSaves(): Promise<ApiSaveSlot[]>;
  putSave(modeId: string, request: PutSaveRequest): Promise<ApiSaveSlot>;
}

export interface SyncedSaveStoreOptions {
  api?: SaveSyncApi;
  storage?: SaveStorage;
  createRunId?: () => string;
  /** Tests and externally coordinated auth flows can opt out of the initial /me request. */
  autoInitialize?: boolean;
}

type Listener = () => void;

interface ValidCloudSlot {
  modeId: string;
  revision: number;
  runId: string | null;
  save: SaveGameV1 | null;
  updatedAt: string;
}

interface InternalConflict {
  public: SaveConflict;
  localRecord: SyncedSaveRecord | null;
  cloud: ValidCloudSlot | null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function cloneSave(save: SaveGameV1, mode: GameModeConfig): SaveGameV1 {
  // Callers only receive validated independent values.
  return parseSaveGame(save, mode)!;
}

function sameRecordVersion(left: SyncedSaveRecord, right: SyncedSaveRecord): boolean {
  return left.runId === right.runId
    && left.remoteRevision === right.remoteRevision
    && JSON.stringify(left.save) === JSON.stringify(right.save);
}

/**
 * Local-first autosaves with one compare-and-swap cloud slot per mode.
 *
 * `write` and `remove` finish after local persistence; cloud work is serialized
 * in the background. `ready` resolves after the initial auth/reconciliation pass,
 * including any immediately required guest import.
 */
export class SyncedSaveStore {
  readonly ready: Promise<void>;

  private readonly api: SaveSyncApi;
  private readonly modesById: ReadonlyMap<string, GameModeConfig>;
  private readonly listeners = new Set<Listener>();
  private readonly records = new Map<string, SyncedSaveRecord>();
  private readonly conflicts = new Map<string, InternalConflict>();
  private readonly flushing = new Set<string>();
  private readonly flushPromises = new Map<string, Promise<void>>();
  private readonly pendingGuestRemoval = new Set<string>();
  private scopeGeneration = 0;
  private state: SyncedSaveStoreState;

  constructor(
    private readonly modes: readonly GameModeConfig[],
    private readonly options: SyncedSaveStoreOptions = {},
  ) {
    this.api = options.api ?? new DiscoApiClient();
    this.modesById = new Map(modes.map(mode => [mode.id, mode]));
    this.migrateLegacySave();

    const cachedAccountId = this.readStorage(LAST_SAVE_ACCOUNT_KEY);
    this.state = cachedAccountId
      ? {
          account: { id: cachedAccountId, displayName: null },
          accountId: cachedAccountId,
          scope: 'account',
          loading: true,
          apiAvailable: true,
        }
      : { account: null, accountId: null, scope: 'guest', loading: true, apiAvailable: true };
    this.loadScope();
    this.ready = options.autoInitialize === false
      ? Promise.resolve().then(() => {
          this.state = { ...this.state, loading: false };
          this.emit();
        })
      : this.refresh();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getState(): SyncedSaveStoreState {
    return {
      ...this.state,
      account: this.state.account ? { ...this.state.account } : null,
    };
  }

  /** Returns a validated independent save from the active guest/account scope. */
  read(modeId: string): SaveGameV1 | null {
    const mode = this.modesById.get(modeId);
    const save = this.records.get(modeId)?.save;
    return mode && save ? cloneSave(save, mode) : null;
  }

  getConflict(modeId: string): SaveConflict | null {
    const conflict = this.conflicts.get(modeId)?.public;
    if (!conflict) return null;
    const mode = this.modesById.get(modeId);
    if (!mode) return null;
    return {
      ...conflict,
      local: conflict.local ? cloneSave(conflict.local, mode) : null,
      cloud: conflict.cloud ? cloneSave(conflict.cloud, mode) : null,
    };
  }

  /** Synchronously replaces this mode's local autosave and queues cloud sync. */
  write(modeId: string, value: SaveGameV1): void {
    const mode = this.modesById.get(modeId);
    if (!mode) return;
    const save = parseSaveGame(value, mode);
    if (!save) return;

    const previous = this.records.get(modeId);
    const next: SyncedSaveRecord = {
      storageVersion: SAVE_SYNC_STORAGE_VERSION,
      runId: previous?.save ? previous.runId : this.createRunId(),
      remoteRevision: previous?.remoteRevision ?? 0,
      dirty: true,
      save,
    };
    this.setRecord(modeId, next);
    const conflict = this.conflicts.get(modeId);
    if (conflict) {
      conflict.localRecord = this.cloneRecord(next, modeId);
      conflict.public.local = cloneSave(save, mode);
    }
    this.emit();
    if (!conflict) this.queueFlush(modeId);
  }

  /** Synchronously records a tombstone for this mode and queues cloud sync. */
  remove(modeId: string): void {
    if (!this.modesById.has(modeId)) return;
    const previous = this.records.get(modeId);
    const conflict = this.conflicts.get(modeId);
    if (!previous && !conflict) return;
    const next: SyncedSaveRecord = {
      storageVersion: SAVE_SYNC_STORAGE_VERSION,
      runId: null,
      remoteRevision: conflict?.public.cloudRevision ?? previous?.remoteRevision ?? 0,
      dirty: true,
      save: null,
    };
    this.setRecord(modeId, next);
    if (conflict) {
      conflict.localRecord = this.cloneRecord(next, modeId);
      conflict.public.local = null;
    }
    this.emit();
    if (!conflict) this.queueFlush(modeId);
  }

  /**
   * Waits for this mode's currently queued cloud work. Guest saves are already
   * complete once written locally. A false result leaves the local dirty record
   * intact so a later refresh can retry it.
   */
  async sync(modeId: string): Promise<boolean> {
    if (!this.modesById.has(modeId)) return false;
    if (this.state.scope !== 'account' || !this.state.accountId) return true;

    await this.flushMode(modeId);
    return !this.records.get(modeId)?.dirty && !this.conflicts.has(modeId);
  }

  /** Pulls the latest cloud slots for the active account. */
  async refreshSaves(): Promise<void> {
    const account = this.state.account;
    if (this.state.scope !== 'account' || !account || this.state.loading) return;
    await this.activateAccount(account);
  }

  /** Applies a user choice after getConflict(). Invalid cloud data cannot be resumed. */
  resolveConflict(modeId: string, resolution: SaveConflictResolution): void {
    const conflict = this.conflicts.get(modeId);
    if (!conflict) return;

    if (resolution === 'cloud') {
      if (!conflict.cloud) return;
      this.conflicts.delete(modeId);
      this.setRecord(modeId, this.recordFromCloud(conflict.cloud));
      if (conflict.public.localScope === 'guest') this.removeStorage(this.guestKey(modeId));
      this.emit();
      return;
    }

    const next: SyncedSaveRecord = resolution === 'new'
      ? {
          storageVersion: SAVE_SYNC_STORAGE_VERSION,
          runId: null,
          remoteRevision: conflict.public.cloudRevision,
          dirty: true,
          save: null,
        }
      : {
          storageVersion: SAVE_SYNC_STORAGE_VERSION,
          runId: conflict.localRecord?.runId ?? null,
          remoteRevision: conflict.public.cloudRevision,
          dirty: true,
          save: conflict.localRecord?.save ?? null,
        };
    this.conflicts.delete(modeId);
    this.setRecord(modeId, next);
    if (conflict.public.localScope === 'guest') this.pendingGuestRemoval.add(modeId);
    this.emit();
    this.queueFlush(modeId);
  }

  /** Re-checks auth/cloud state after a previous offline initialization. */
  async retry(): Promise<void> {
    this.state = { ...this.state, loading: true };
    this.emit();
    await this.refresh();
  }

  /** Allows the app's auth owner to coordinate login/logout without another /me. */
  async setAuthState(auth: AuthState | null): Promise<void> {
    if (!auth?.account) {
      this.activateGuest(true);
      return;
    }
    await this.activateAccount(auth.account);
  }

  private async refresh(): Promise<void> {
    try {
      const auth = await this.api.me();
      if (auth.account) await this.activateAccount(auth.account);
      else this.activateGuest(true);
    } catch (error) {
      if (error instanceof ApiUnauthorizedError) {
        this.activateGuest(true);
      } else {
        // A cached account scope remains usable when the network is unavailable.
        this.state = { ...this.state, loading: false, apiAvailable: false };
        this.emit();
      }
    }
  }

  private async activateAccount(account: PublicAccount): Promise<void> {
    const scopeGeneration = ++this.scopeGeneration;
    this.writeStorage(LAST_SAVE_ACCOUNT_KEY, account.id);
    this.state = {
      account: { ...account },
      accountId: account.id,
      scope: 'account',
      loading: true,
      apiAvailable: true,
    };
    this.loadScope();
    this.emit();

    try {
      const remote = await this.api.getSaves();
      if (this.scopeGeneration !== scopeGeneration) return;
      await this.reconcile(remote);
      if (this.scopeGeneration !== scopeGeneration) return;
      this.state = { ...this.state, loading: false, apiAvailable: true };
    } catch (error) {
      if (this.scopeGeneration !== scopeGeneration) return;
      if (error instanceof ApiUnauthorizedError) {
        this.activateGuest(true);
        return;
      }
      this.state = {
        ...this.state,
        loading: false,
        apiAvailable: error instanceof ApiRequestError,
      };
    }
    this.emit();
  }

  private activateGuest(clearCachedAccount: boolean): void {
    this.scopeGeneration++;
    if (clearCachedAccount) this.removeStorage(LAST_SAVE_ACCOUNT_KEY);
    this.state = {
      account: null,
      accountId: null,
      scope: 'guest',
      loading: false,
      apiAvailable: true,
    };
    this.conflicts.clear();
    this.loadScope();
    this.emit();
  }

  private async reconcile(rawSlots: readonly ApiSaveSlot[]): Promise<void> {
    const remoteByMode = new Map<string, ApiSaveSlot>();
    for (const slot of rawSlots) {
      if (typeof slot.modeId === 'string' && this.modesById.has(slot.modeId)) {
        const previous = remoteByMode.get(slot.modeId);
        if (!previous || slot.revision > previous.revision) remoteByMode.set(slot.modeId, slot);
      }
    }

    const flushes: Promise<void>[] = [];
    for (const mode of this.modes) {
      const local = this.records.get(mode.id) ?? null;
      const guest = this.readRecord(this.guestKey(mode.id), mode);
      const rawRemote = remoteByMode.get(mode.id);
      const remote = rawRemote ? this.validateCloudSlot(rawRemote, mode) : null;

      if (rawRemote && !remote) {
        const localCandidate = local?.dirty ? local : guest ?? local;
        const localScope = local?.dirty || !guest ? 'account' : 'guest';
        this.setInvalidCloudConflict(mode.id, localCandidate, localScope, rawRemote);
        continue;
      }

      // A clean account record is only a cache of the cloud slot. A guest run
      // created after logout must still be imported or offered as a conflict
      // when the player signs back in. A dirty account tombstone must not hide
      // that playable guest run either.
      if (guest?.save && (!local || !local.dirty || local.save === null)) {
        if (!remote || remote.save === null) {
          const imported: SyncedSaveRecord = {
            storageVersion: SAVE_SYNC_STORAGE_VERSION,
            runId: guest.runId ?? this.createRunId(),
            remoteRevision: remote?.revision ?? 0,
            dirty: true,
            save: cloneSave(guest.save, mode),
          };
          this.setRecord(mode.id, imported);
          this.pendingGuestRemoval.add(mode.id);
          flushes.push(this.flushMode(mode.id));
        } else {
          this.setDivergedConflict(mode.id, guest, remote, 'guest');
        }
        continue;
      }

      if (!local) {
        if (remote) this.setRecord(mode.id, this.recordFromCloud(remote));
        continue;
      }

      // Clean imported copies can remove the matching guest record after reload.
      if (!local.dirty && guest?.runId === local.runId) this.removeStorage(this.guestKey(mode.id));

      if (!remote) {
        if (local.dirty) flushes.push(this.flushMode(mode.id));
        continue;
      }

      if (local.dirty) {
        if (local.remoteRevision === remote.revision) flushes.push(this.flushMode(mode.id));
        else if (local.save === null && remote.save === null) {
          this.setRecord(mode.id, this.recordFromCloud(remote));
        } else this.setDivergedConflict(mode.id, local, remote, 'account');
      } else if (remote.revision > local.remoteRevision) {
        this.setRecord(mode.id, this.recordFromCloud(remote));
      }
    }

    this.emit();
    await Promise.all(flushes);
  }

  private queueFlush(modeId: string): void {
    if (this.state.scope !== 'account' || !this.state.accountId || this.conflicts.has(modeId)) return;
    void this.flushMode(modeId);
  }

  private flushMode(modeId: string): Promise<void> {
    const existing = this.flushPromises.get(modeId);
    if (existing) return existing;
    const promise = this.runFlushLoop(modeId).finally(() => {
      this.flushPromises.delete(modeId);
      this.flushing.delete(modeId);
    });
    this.flushing.add(modeId);
    this.flushPromises.set(modeId, promise);
    return promise;
  }

  private async runFlushLoop(modeId: string): Promise<void> {
    const accountId = this.state.accountId;
    while (accountId && this.state.scope === 'account' && this.state.accountId === accountId) {
      const current = this.records.get(modeId);
      if (!current?.dirty || this.conflicts.has(modeId)) return;
      const snapshot = this.cloneRecord(current, modeId);

      try {
        const savedRaw = await this.api.putSave(modeId, {
          expectedRevision: snapshot.remoteRevision,
          runId: snapshot.runId,
          save: snapshot.save,
        });
        // Login/logout can replace the active record map while a request is in
        // flight. A response for the old account must never mutate the new
        // guest/account scope.
        if (this.state.scope !== 'account' || this.state.accountId !== accountId) return;
        const mode = this.modesById.get(modeId)!;
        const saved = this.validateCloudSlot(savedRaw, mode);
        if (!saved) {
          this.setInvalidCloudConflict(modeId, this.records.get(modeId) ?? snapshot, 'account', savedRaw);
          this.emit();
          return;
        }

        const latest = this.records.get(modeId);
        if (!latest) return;
        if (sameRecordVersion(latest, snapshot)) {
          this.setRecord(modeId, this.recordFromCloud(saved));
          if (this.pendingGuestRemoval.delete(modeId)) this.removeStorage(this.guestKey(modeId));
          this.emit();
          return;
        }

        // A turn was saved while this request was in flight. Preserve it and
        // continue the loop against the revision returned by the first write.
        this.setRecord(modeId, { ...latest, remoteRevision: saved.revision, dirty: true });
        this.emit();
      } catch (error) {
        if (this.state.scope !== 'account' || this.state.accountId !== accountId) return;
        if (error instanceof ApiSaveConflictError) {
          const mode = this.modesById.get(modeId)!;
          const local = this.records.get(modeId) ?? snapshot;
          if (error.current === null) {
            if (local.save === null) {
              this.setRecord(modeId, {
                storageVersion: SAVE_SYNC_STORAGE_VERSION,
                runId: null,
                remoteRevision: 0,
                dirty: false,
                save: null,
              });
            } else {
              this.setDivergedConflict(modeId, local, {
                modeId, revision: 0, runId: null, save: null, updatedAt: '',
              }, 'account');
            }
          } else {
            const remote = this.validateCloudSlot(error.current, mode);
            if (remote && local.save === null && remote.save === null) {
              this.setRecord(modeId, this.recordFromCloud(remote));
            } else if (remote) this.setDivergedConflict(modeId, local, remote, 'account');
            else this.setInvalidCloudConflict(modeId, local, 'account', error.current);
          }
        } else if (error instanceof ApiUnauthorizedError) {
          this.activateGuest(true);
          return;
        } else if (error instanceof ApiRequestError) {
          console.warn('disco: save sync rejected by API', error.status);
        } else {
          this.state = { ...this.state, loading: false, apiAvailable: false };
        }
        this.emit();
        return;
      }
    }
  }

  private validateCloudSlot(slot: ApiSaveSlot, mode: GameModeConfig): ValidCloudSlot | null {
    if (!isObject(slot)
      || slot.modeId !== mode.id
      || !isRevision(slot.revision)
      || slot.revision < 1
      || typeof slot.updatedAt !== 'string') return null;
    if (slot.runId === null && slot.save === null) {
      return { modeId: mode.id, revision: slot.revision, runId: null, save: null, updatedAt: slot.updatedAt };
    }
    if (typeof slot.runId !== 'string' || slot.runId.length === 0 || slot.save === null) return null;
    const save = parseSaveGame(slot.save, mode);
    return save
      ? { modeId: mode.id, revision: slot.revision, runId: slot.runId, save, updatedAt: slot.updatedAt }
      : null;
  }

  private setDivergedConflict(
    modeId: string,
    local: SyncedSaveRecord,
    cloud: ValidCloudSlot,
    localScope: 'account' | 'guest',
  ): void {
    this.conflicts.set(modeId, {
      public: {
        kind: 'diverged',
        modeId,
        local: local.save,
        cloud: cloud.save,
        cloudRevision: cloud.revision,
        cloudUpdatedAt: cloud.updatedAt,
        localScope,
      },
      localRecord: this.cloneRecord(local, modeId),
      cloud,
    });
  }

  private setInvalidCloudConflict(
    modeId: string,
    local: SyncedSaveRecord | null,
    localScope: 'account' | 'guest',
    cloud: ApiSaveSlot | null,
  ): void {
    this.conflicts.set(modeId, {
      public: {
        kind: 'invalid-cloud',
        modeId,
        local: local?.save ?? null,
        cloud: null,
        cloudRevision: cloud && isRevision(cloud.revision) ? cloud.revision : 0,
        cloudUpdatedAt: cloud && typeof cloud.updatedAt === 'string' ? cloud.updatedAt : '',
        localScope,
      },
      localRecord: local ? this.cloneRecord(local, modeId) : null,
      cloud: null,
    });
  }

  private recordFromCloud(cloud: ValidCloudSlot): SyncedSaveRecord {
    return {
      storageVersion: SAVE_SYNC_STORAGE_VERSION,
      runId: cloud.runId,
      remoteRevision: cloud.revision,
      dirty: false,
      save: cloud.save,
    };
  }

  private cloneRecord(record: SyncedSaveRecord, modeId: string): SyncedSaveRecord {
    const mode = this.modesById.get(modeId)!;
    return {
      ...record,
      save: record.save ? cloneSave(record.save, mode) : null,
    };
  }

  private setRecord(modeId: string, record: SyncedSaveRecord): void {
    const copy = this.cloneRecord(record, modeId);
    this.records.set(modeId, copy);
    this.writeStorage(this.activeKey(modeId), JSON.stringify(copy));
  }

  private loadScope(): void {
    this.records.clear();
    this.conflicts.clear();
    for (const mode of this.modes) {
      const record = this.readRecord(this.activeKey(mode.id), mode);
      if (record) this.records.set(mode.id, record);
    }
  }

  private readRecord(key: string, mode: GameModeConfig): SyncedSaveRecord | null {
    const json = this.readStorage(key);
    if (json === null) return null;
    try {
      const value = JSON.parse(json) as unknown;
      if (!isObject(value)
        || value.storageVersion !== SAVE_SYNC_STORAGE_VERSION
        || !isRevision(value.remoteRevision)
        || typeof value.dirty !== 'boolean') throw new Error('invalid record');
      if (value.runId === null && value.save === null) {
        return {
          storageVersion: SAVE_SYNC_STORAGE_VERSION,
          runId: null,
          remoteRevision: value.remoteRevision,
          dirty: value.dirty,
          save: null,
        };
      }
      if (typeof value.runId !== 'string' || value.runId.length === 0) throw new Error('invalid run id');
      const save = parseSaveGame(value.save, mode);
      if (!save) throw new Error('invalid save');
      return {
        storageVersion: SAVE_SYNC_STORAGE_VERSION,
        runId: value.runId,
        remoteRevision: value.remoteRevision,
        dirty: value.dirty,
        save,
      };
    } catch {
      this.removeStorage(key);
      return null;
    }
  }

  private migrateLegacySave(): void {
    const json = this.readStorage(LOCAL_SAVE_KEY);
    if (json === null) return;
    let removeLegacy = true;
    try {
      const value = JSON.parse(json) as unknown;
      if (!isObject(value) || typeof value.modeId !== 'string') return;
      const mode = this.modesById.get(value.modeId);
      const save = mode ? parseSaveGame(value, mode) : null;
      if (!mode || !save) return;
      const key = this.guestKey(mode.id);
      if (this.readStorage(key) === null) {
        const record: SyncedSaveRecord = {
          storageVersion: SAVE_SYNC_STORAGE_VERSION,
          runId: this.createRunId(),
          remoteRevision: 0,
          dirty: true,
          save,
        };
        removeLegacy = this.writeStorage(key, JSON.stringify(record));
      }
    } catch {
      // Invalid legacy saves are discarded below, matching LocalSaveStore.
    } finally {
      if (removeLegacy) this.removeStorage(LOCAL_SAVE_KEY);
    }
  }

  private activeKey(modeId: string): string {
    return this.state.scope === 'account' && this.state.accountId
      ? this.accountKey(this.state.accountId, modeId)
      : this.guestKey(modeId);
  }

  private guestKey(modeId: string): string {
    return `${SAVE_SYNC_KEY_PREFIX}.guest.${modeId}`;
  }

  private accountKey(accountId: string, modeId: string): string {
    return `${SAVE_SYNC_KEY_PREFIX}.account.${accountId}.${modeId}`;
  }

  private createRunId(): string {
    if (this.options.createRunId) return this.options.createRunId();
    return crypto.randomUUID();
  }

  private readStorage(key: string): string | null {
    try {
      return this.storage?.getItem(key) ?? null;
    } catch {
      return null;
    }
  }

  private writeStorage(key: string, value: string): boolean {
    try {
      const storage = this.storage;
      if (!storage) return false;
      storage.setItem(key, value);
      return true;
    } catch {
      // Saving remains best-effort when browser storage is unavailable.
      return false;
    }
  }

  private removeStorage(key: string): void {
    try {
      this.storage?.removeItem(key);
    } catch {
      // Ignore storage failures; in-memory state remains authoritative.
    }
  }

  private get storage(): SaveStorage | null {
    if (this.options.storage) return this.options.storage;
    try {
      return typeof window === 'undefined' ? null : window.localStorage;
    } catch {
      return null;
    }
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
