import type { GameStats } from '../game/stats.js';

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

function configuredApiBaseUrl(): string {
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

export class DiscoApiClient {
  readonly baseUrl = configuredApiBaseUrl();

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
}
