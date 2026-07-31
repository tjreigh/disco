import type { GameStats } from '../game/stats.js';
import type { SaveGameV1 } from '../game/save.js';

export interface PublicAccount {
  id: string;
  displayName: string | null;
}

export interface AuthIdentity {
  id: string;
  providerName: string;
  issuer: string;
  email: string | null;
  emailVerified: boolean;
}

export interface AuthState {
  account: PublicAccount | null;
  identities: AuthIdentity[];
}

export interface ApiStats extends GameStats {
  accountId: string;
  modeId: string;
  updatedAt: string;
}

export class ApiUnauthorizedError extends Error {
  constructor() {
    super('API request is not authenticated');
  }
}

/** The server answered but rejected the request (4xx/5xx other than 401). */
export class ApiRequestError extends Error {
  constructor(readonly status: number) {
    super(`API request failed with ${status}`);
  }
}

export interface ApiSaveSlot {
  modeId: string;
  revision: number;
  runId: string | null;
  /** Untrusted until the frontend validates it against the selected mode. */
  save: unknown | null;
  updatedAt: string;
}

export interface PutSaveRequest {
  expectedRevision: number;
  runId: string | null;
  save: SaveGameV1 | null;
}

/** A compare-and-swap save write lost a race with another client. */
export class ApiSaveConflictError extends Error {
  constructor(readonly current: ApiSaveSlot | null) {
    super('Cloud save was changed by another client');
  }
}

export interface ApiBaseUrlEnvironment {
  metaBaseUrl?: string | null;
  storageBaseUrl?: string | null;
  hostname: string;
}

export function resolveApiBaseUrl(env: ApiBaseUrlEnvironment): string {
  const meta = env.metaBaseUrl?.trim();
  if (meta) return meta.replace(/\/$/, '');

  const override = env.storageBaseUrl?.trim();
  if (override) return override.replace(/\/$/, '');

  if (env.hostname === 'localhost' || env.hostname === '127.0.0.1' || env.hostname === '::1') {
    return 'http://localhost:8787';
  }

  const hostname = env.hostname.startsWith('www.')
    ? env.hostname.slice(4)
    : env.hostname;
  return `https://api.${hostname}`;
}

export function configuredApiBaseUrl(): string {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="disco-api-base-url"]')?.content;
  let storageBaseUrl: string | null = null;

  try {
    storageBaseUrl = window.localStorage.getItem('disco_api_base_url');
  } catch {
    // Ignore localStorage failures; the hostname default still works.
  }

  return resolveApiBaseUrl({
    metaBaseUrl: meta ?? null,
    storageBaseUrl,
    hostname: location.hostname,
  });
}

async function parseJson<T>(response: Response): Promise<T> {
  if (response.status === 401) throw new ApiUnauthorizedError();
  if (!response.ok) throw new ApiRequestError(response.status);
  return await response.json() as T;
}

async function parseSaveJson(response: Response): Promise<{ save: ApiSaveSlot }> {
  if (response.status === 401) throw new ApiUnauthorizedError();
  if (response.status === 409) {
    const body = await response.json() as { current?: ApiSaveSlot | null };
    if (Object.hasOwn(body, 'current')) throw new ApiSaveConflictError(body.current ?? null);
    throw new ApiRequestError(response.status);
  }
  if (!response.ok) throw new ApiRequestError(response.status);
  return await response.json() as { save: ApiSaveSlot };
}

export class DiscoApiClient {
  readonly baseUrl: string;

  constructor(baseUrl = configuredApiBaseUrl()) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  login(provider = 'google'): void {
    location.href = `${this.baseUrl}/auth/login/${encodeURIComponent(provider)}`;
  }

  async logout(): Promise<void> {
    await parseJson<{ ok: boolean }>(await fetch(`${this.baseUrl}/auth/logout`, {
      method: 'POST',
      credentials: 'include',
    }));
  }

  async me(): Promise<AuthState> {
    return await parseJson<AuthState>(await fetch(`${this.baseUrl}/me`, {
      credentials: 'include',
    }));
  }

  async getStats(): Promise<ApiStats[]> {
    const response = await parseJson<{ stats: ApiStats[] }>(await fetch(`${this.baseUrl}/stats`, {
      credentials: 'include',
    }));
    return response.stats;
  }

  async putStats(modeId: string, stats: GameStats): Promise<ApiStats> {
    const response = await parseJson<{ stats: ApiStats }>(await fetch(`${this.baseUrl}/stats/${encodeURIComponent(modeId)}`, {
      method: 'PUT',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(stats),
    }));
    return response.stats;
  }

  async submitScore(modeId: string, score: number, longestStreak: number, stats: GameStats): Promise<ApiStats> {
    const response = await parseJson<{ stats: ApiStats }>(await fetch(`${this.baseUrl}/scores/${encodeURIComponent(modeId)}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ score, longestStreak, clientStats: { ...stats, modeId } }),
    }));
    return response.stats;
  }

  async getSaves(): Promise<ApiSaveSlot[]> {
    const response = await parseJson<{ saves: ApiSaveSlot[] }>(await fetch(`${this.baseUrl}/saves`, {
      credentials: 'include',
    }));
    return response.saves;
  }

  async putSave(modeId: string, request: PutSaveRequest): Promise<ApiSaveSlot> {
    const response = await parseSaveJson(await fetch(`${this.baseUrl}/saves/${encodeURIComponent(modeId)}`, {
      method: 'PUT',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    }));
    return response.save;
  }
}
