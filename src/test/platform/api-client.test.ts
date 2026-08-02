import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  ApiRequestError,
  ApiSaveConflictError,
  ApiUnauthorizedError,
  DiscoApiClient,
  resolveApiBaseUrl,
} from '../../platform/api-client.js';
import type { GameStats } from '../../game/stats.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('resolveApiBaseUrl', () => {
  test('prefers the meta tag override when present', () => {
    expect(resolveApiBaseUrl({
      metaBaseUrl: 'https://api-meta.example.com/',
      storageBaseUrl: 'https://api-storage.example.com',
      hostname: 'play.example.com',
    })).toBe('https://api-meta.example.com');
  });

  test('uses the local storage override when there is no meta tag', () => {
    expect(resolveApiBaseUrl({
      metaBaseUrl: '',
      storageBaseUrl: 'https://api-storage.example.com/',
      hostname: 'play.example.com',
    })).toBe('https://api-storage.example.com');
  });

  test('maps local browser hosts to the local API origin', () => {
    expect(resolveApiBaseUrl({
      hostname: 'localhost',
    })).toBe('http://localhost:8787');
    expect(resolveApiBaseUrl({
      hostname: '127.0.0.1',
    })).toBe('http://localhost:8787');
    expect(resolveApiBaseUrl({
      hostname: '::1',
    })).toBe('http://localhost:8787');
  });

  test('strips a leading www for production hosts', () => {
    expect(resolveApiBaseUrl({
      hostname: 'www.disco.example',
    })).toBe('https://api.disco.example');
  });
});

describe('login', () => {
  test('navigates to the given provider login route', () => {
    vi.stubGlobal('location', { href: '' });
    const client = new DiscoApiClient('https://api.example.test');

    client.login('discord');

    expect(location.href).toBe('https://api.example.test/auth/login/discord');
  });

  test('defaults to the google provider', () => {
    vi.stubGlobal('location', { href: '' });
    const client = new DiscoApiClient('https://api.example.test');

    client.login();

    expect(location.href).toBe('https://api.example.test/auth/login/google');
  });
});

describe('logout', () => {
  test('posts to the logout route with credentials', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ ok: true }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    const client = new DiscoApiClient('https://api.example.test');

    await expect(client.logout()).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith('https://api.example.test/auth/logout', {
      method: 'POST',
      credentials: 'include',
    });
  });
});

describe('me', () => {
  test('returns the parsed auth state', async () => {
    const authState = {
      account: { id: 'acct_1', displayName: 'Ada' },
      identities: [{
        id: 'ident_1',
        providerName: 'google',
        issuer: 'https://accounts.google.com',
        email: 'ada@example.com',
        emailVerified: true,
      }],
    };
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify(authState),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    const client = new DiscoApiClient('https://api.example.test');

    await expect(client.me()).resolves.toEqual(authState);
    expect(fetchMock).toHaveBeenCalledWith('https://api.example.test/me', {
      credentials: 'include',
    });
  });

  test('throws ApiUnauthorizedError on a 401 response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 401 }));
    const client = new DiscoApiClient('https://api.example.test');

    await expect(client.me()).rejects.toBeInstanceOf(ApiUnauthorizedError);
  });
});

describe('getStats', () => {
  test('parses the stats array', async () => {
    const stats = [{
      accountId: 'acct_1',
      modeId: 'classic',
      updatedAt: '2026-07-13T00:00:00.000Z',
      highScore: 500,
      longestStreak: 4,
      averageScore: 200,
      gamesPlayed: 3,
      totalScore: 600,
    }];
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ stats }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    const client = new DiscoApiClient('https://api.example.test');

    await expect(client.getStats()).resolves.toEqual(stats);
    expect(fetchMock).toHaveBeenCalledWith('https://api.example.test/stats', {
      credentials: 'include',
    });
  });

  test('throws ApiRequestError with the response status on a non-401 error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 500 }));
    const client = new DiscoApiClient('https://api.example.test');

    const error = await client.getStats().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiRequestError);
    expect((error as ApiRequestError).status).toBe(500);
  });
});

describe('putStats', () => {
  test('puts stats for a mode and returns the parsed result', async () => {
    const stats: GameStats = {
      highScore: 500, longestStreak: 4, averageScore: 200, gamesPlayed: 3, totalScore: 600,
      totalPlayTimeMs: 120_000, totalDiscsDropped: 20, totalDiscsBroken: 8,
    };
    const returned = {
      ...stats, accountId: 'acct_1', modeId: 'classic', updatedAt: '2026-07-13T00:00:00.000Z',
    };
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ stats: returned }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    const client = new DiscoApiClient('https://api.example.test');

    await expect(client.putStats('classic', stats)).resolves.toEqual(returned);
    expect(fetchMock).toHaveBeenCalledWith('https://api.example.test/stats/classic', {
      method: 'PUT',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(stats),
    });
  });
});

describe('submitScore', () => {
  test('submits a score with the client stats and returns the parsed result', async () => {
    const stats: GameStats = {
      highScore: 500, longestStreak: 4, averageScore: 200, gamesPlayed: 3, totalScore: 600,
      totalPlayTimeMs: 120_000, totalDiscsDropped: 20, totalDiscsBroken: 8,
    };
    const returned = {
      ...stats, accountId: 'acct_1', modeId: 'classic', updatedAt: '2026-07-13T00:00:00.000Z',
    };
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ stats: returned }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    const client = new DiscoApiClient('https://api.example.test');

    await expect(client.submitScore('classic', 500, 4, stats)).resolves.toEqual(returned);
    expect(fetchMock).toHaveBeenCalledWith('https://api.example.test/scores/classic', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ score: 500, longestStreak: 4, clientStats: { ...stats, modeId: 'classic' } }),
    });
  });
});

describe('cloud save requests', () => {
  test('gets all save slots with credentials', async () => {
    const saves = [{
      modeId: 'classic', revision: 2, runId: null, save: null,
      updatedAt: '2026-07-13T00:00:00.000Z',
    }];
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ saves }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    const client = new DiscoApiClient('https://api.example.test/');

    await expect(client.getSaves()).resolves.toEqual(saves);
    expect(fetchMock).toHaveBeenCalledWith('https://api.example.test/saves', {
      credentials: 'include',
    });
  });

  test('throws ApiRequestError with the response status on a non-401 error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 500 }));
    const client = new DiscoApiClient('https://api.example.test');

    const error = await client.getSaves().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiRequestError);
    expect((error as ApiRequestError).status).toBe(500);
  });

  test('puts a compare-and-swap save and exposes the current slot on conflict', async () => {
    const current = {
      modeId: 'classic', revision: 3, runId: null, save: null,
      updatedAt: '2026-07-13T00:00:00.000Z',
    };
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ error: 'save_conflict', current }),
      { status: 409, headers: { 'content-type': 'application/json' } },
    ));
    const client = new DiscoApiClient('https://api.example.test');

    const error = await client.putSave('classic', {
      expectedRevision: 2,
      runId: null,
      save: null,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiSaveConflictError);
    expect((error as ApiSaveConflictError).current).toEqual(current);
    expect(fetchMock).toHaveBeenCalledWith('https://api.example.test/saves/classic', expect.objectContaining({
      method: 'PUT',
      credentials: 'include',
      body: JSON.stringify({ expectedRevision: 2, runId: null, save: null }),
    }));
  });

  test('preserves an absent current slot in a conflict response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ error: 'save_conflict', current: null }),
      { status: 409, headers: { 'content-type': 'application/json' } },
    ));
    const client = new DiscoApiClient('https://api.example.test');

    const error = await client.putSave('classic', {
      expectedRevision: 4,
      runId: null,
      save: null,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiSaveConflictError);
    expect((error as ApiSaveConflictError).current).toBeNull();
  });

  test('throws a plain ApiRequestError when a conflict body omits current', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ error: 'save_conflict' }),
      { status: 409, headers: { 'content-type': 'application/json' } },
    ));
    const client = new DiscoApiClient('https://api.example.test');

    const error = await client.putSave('classic', {
      expectedRevision: 5,
      runId: null,
      save: null,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiRequestError);
    expect(error).not.toBeInstanceOf(ApiSaveConflictError);
    expect((error as ApiRequestError).status).toBe(409);
  });
});
