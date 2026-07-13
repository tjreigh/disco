import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  ApiSaveConflictError,
  DiscoApiClient,
  resolveApiBaseUrl,
} from '../../platform/api-client.js';

afterEach(() => vi.restoreAllMocks());

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
});
