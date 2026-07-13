import { afterEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { Repositories } from '../src/db/repositories.js';
import { createTestConfig, createTestDb } from './helpers.js';

let db: Database.Database | null = null;
let app: FastifyInstance | null = null;

afterEach(async () => {
  await app?.close();
  db?.close();
  app = null;
  db = null;
});

async function createAuthedApp() {
  db = createTestDb();
  app = await buildApp(createTestConfig(), db);

  const repos = new Repositories(db);
  const account = repos.findOrCreateAccountForIdentity({
    issuer: 'https://issuer.example',
    subject: 'route-user',
    email: 'route-user@example.com',
    emailVerified: true,
    providerName: 'test',
    displayName: 'Route User',
  });
  const token = 'route-session-token';
  repos.createSession(account.id, token, new Date(Date.now() + 60 * 60 * 1000));

  return { repos, account, cookie: `disco_session=${token}` };
}

function savePayload(modeId: 'classic' | 'gravity' | 'stack', overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    rulesVersion: 1,
    savedAt: 1_700_000_000_000,
    modeId,
    state: { phase: 'waiting', board: [], score: 100 },
    generation: { source: 'seeded' },
    session: { longestStreak: 4 },
    meta: { source: 'autosave' },
    ...overrides,
  };
}

describe('API routes', () => {
  it('allows credentialed JSON PUT preflights from the static site origin', async () => {
    const config = createTestConfig();
    db = createTestDb();
    app = await buildApp(config, db);

    const response = await app.inject({
      method: 'OPTIONS',
      url: '/stats/classic',
      headers: {
        origin: config.publicSiteOrigin,
        'access-control-request-method': 'PUT',
        'access-control-request-headers': 'content-type',
      },
    });

    expect(response.statusCode).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe(config.publicSiteOrigin);
    expect(response.headers['access-control-allow-credentials']).toBe('true');
    expect(response.headers['access-control-allow-methods']).toContain('PUT');
    expect(response.headers['access-control-allow-headers']).toContain('content-type');
  });

  it('returns health and an anonymous profile without a session', async () => {
    db = createTestDb();
    app = await buildApp(createTestConfig(), db);

    const health = await app.inject({ method: 'GET', url: '/health' });
    const me = await app.inject({ method: 'GET', url: '/me' });
    const stats = await app.inject({ method: 'GET', url: '/stats' });
    const saves = await app.inject({ method: 'GET', url: '/saves' });

    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ ok: true });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toEqual({ account: null, identities: [] });
    expect(stats.statusCode).toBe(401);
    expect(stats.json()).toEqual({ error: 'unauthorized' });
    expect(saves.statusCode).toBe(401);
    expect(saves.json()).toEqual({ error: 'unauthorized' });
  });

  it('stores stats, returns leaderboards, and revokes the session on logout', async () => {
    const { cookie, account } = await createAuthedApp();

    const putStats = await app!.inject({
      method: 'PUT',
      url: '/stats/classic',
      headers: { cookie },
      payload: {
        highScore: 250,
        longestStreak: 8,
        gamesPlayed: 2,
        totalScore: 400,
        averageScore: 1,
      },
    });
    const submitScore = await app!.inject({
      method: 'POST',
      url: '/scores/classic',
      headers: { cookie },
      payload: {
        score: 300,
        longestStreak: 9,
      },
    });
    const me = await app!.inject({ method: 'GET', url: '/me', headers: { cookie } });
    const stats = await app!.inject({ method: 'GET', url: '/stats', headers: { cookie } });
    const leaderboard = await app!.inject({ method: 'GET', url: '/leaderboards/classic?limit=5' });
    const logout = await app!.inject({ method: 'POST', url: '/auth/logout', headers: { cookie } });
    const statsAfterLogout = await app!.inject({ method: 'GET', url: '/stats', headers: { cookie } });

    expect(putStats.statusCode).toBe(200);
    expect(putStats.json().stats.averageScore).toBe(200);

    expect(submitScore.statusCode).toBe(201);
    expect(submitScore.json().stats).toMatchObject({
      accountId: account.id,
      modeId: 'classic',
      highScore: 300,
      longestStreak: 9,
      gamesPlayed: 3,
      totalScore: 700,
      averageScore: 233,
    });

    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({
      account: { id: account.id, displayName: 'Route User' },
      identities: [
        {
          providerName: 'test',
          issuer: 'https://issuer.example',
          email: 'route-user@example.com',
          emailVerified: true,
        },
      ],
    });

    expect(stats.statusCode).toBe(200);
    expect(stats.json().stats).toHaveLength(1);
    expect(leaderboard.statusCode).toBe(200);
    expect(leaderboard.json().entries).toMatchObject([
      {
        accountId: account.id,
        displayName: 'Route User',
        highScore: 300,
        longestStreak: 9,
        gamesPlayed: 3,
      },
    ]);

    expect(logout.statusCode).toBe(200);
    expect(logout.json()).toEqual({ ok: true });
    expect(logout.headers['set-cookie']).toContain('disco_session=');
    expect(statsAfterLogout.statusCode).toBe(401);
  });

  it('creates, lists, updates, and tombstones save slots', async () => {
    const { cookie } = await createAuthedApp();
    const runId = '00000000-0000-4000-8000-000000000001';

    const initialList = await app!.inject({ method: 'GET', url: '/saves', headers: { cookie } });
    const created = await app!.inject({
      method: 'PUT',
      url: '/saves/classic',
      headers: { cookie },
      payload: { expectedRevision: 0, runId, save: savePayload('classic') },
    });
    const listed = await app!.inject({ method: 'GET', url: '/saves', headers: { cookie } });
    const updated = await app!.inject({
      method: 'PUT',
      url: '/saves/classic',
      headers: { cookie },
      payload: { expectedRevision: 1, runId, save: savePayload('classic', { savedAt: 1_700_000_000_001 }) },
    });
    const deleted = await app!.inject({
      method: 'PUT',
      url: '/saves/classic',
      headers: { cookie },
      payload: { expectedRevision: 2, runId: null, save: null },
    });

    expect(initialList.statusCode).toBe(200);
    expect(initialList.json()).toEqual({ saves: [] });
    expect(created.statusCode).toBe(200);
    expect(created.json().save).toMatchObject({ modeId: 'classic', revision: 1, runId, save: savePayload('classic') });
    expect(created.json().save).not.toHaveProperty('accountId');
    expect(listed.json().saves).toMatchObject([{ modeId: 'classic', revision: 1, runId }]);
    expect(updated.json().save).toMatchObject({ revision: 2, save: { savedAt: 1_700_000_000_001 } });
    expect(deleted.json().save).toMatchObject({ modeId: 'classic', revision: 3, runId: null, save: null });
  });

  it('returns the current slot on a stale revision conflict, including null for a missing row', async () => {
    const { cookie } = await createAuthedApp();
    const runId = '00000000-0000-4000-8000-000000000001';
    await app!.inject({
      method: 'PUT', url: '/saves/gravity', headers: { cookie },
      payload: { expectedRevision: 0, runId, save: savePayload('gravity') },
    });

    const existingConflict = await app!.inject({
      method: 'PUT', url: '/saves/gravity', headers: { cookie },
      payload: { expectedRevision: 0, runId, save: savePayload('gravity') },
    });
    const missingConflict = await app!.inject({
      method: 'PUT', url: '/saves/stack', headers: { cookie },
      payload: { expectedRevision: 2, runId: null, save: null },
    });

    expect(existingConflict.statusCode).toBe(409);
    expect(existingConflict.json()).toMatchObject({
      error: 'save_conflict',
      current: { modeId: 'gravity', revision: 1, runId },
    });
    expect(missingConflict.statusCode).toBe(409);
    expect(missingConflict.json()).toEqual({ error: 'save_conflict', current: null });
  });

  it('isolates save slots between authenticated accounts', async () => {
    const { cookie, repos } = await createAuthedApp();
    const other = repos.findOrCreateAccountForIdentity({
      issuer: 'https://issuer.example', subject: 'other-route-user', email: null,
      emailVerified: false, providerName: 'test', displayName: 'Other',
    });
    const otherToken = 'other-route-session-token';
    repos.createSession(other.id, otherToken, new Date(Date.now() + 60 * 60 * 1000));

    await app!.inject({
      method: 'PUT', url: '/saves/classic', headers: { cookie },
      payload: {
        expectedRevision: 0,
        runId: '00000000-0000-4000-8000-000000000001',
        save: savePayload('classic'),
      },
    });
    const otherList = await app!.inject({
      method: 'GET', url: '/saves', headers: { cookie: `disco_session=${otherToken}` },
    });

    expect(otherList.json()).toEqual({ saves: [] });
  });

  it('rejects invalid save payloads, mode mismatches, and bodies over 64 KiB', async () => {
    const { cookie } = await createAuthedApp();
    const runId = '00000000-0000-4000-8000-000000000001';
    const cases = [
      { expectedRevision: 0, runId: 'not-a-uuid', save: savePayload('classic') },
      { expectedRevision: 0, runId, save: null },
      { expectedRevision: 0, runId: null, save: savePayload('classic') },
      { expectedRevision: -1, runId: null, save: null },
      { expectedRevision: 0, runId, save: savePayload('classic', { version: 2 }) },
      { expectedRevision: 0, runId, save: savePayload('classic', { rulesVersion: 2 }) },
      { expectedRevision: 0, runId, save: savePayload('gravity') },
    ];

    for (const payload of cases) {
      const response = await app!.inject({
        method: 'PUT', url: '/saves/classic', headers: { cookie }, payload,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe('invalid_request');
    }

    const tooLarge = await app!.inject({
      method: 'PUT',
      url: '/saves/classic',
      headers: { cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({
        expectedRevision: 0,
        runId,
        save: savePayload('classic', { padding: 'x'.repeat(66 * 1024) }),
      }),
    });
    expect(tooLarge.statusCode).toBe(413);
    expect(tooLarge.json()).toEqual({ error: 'payload_too_large' });
  });
});
