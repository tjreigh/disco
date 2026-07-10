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

describe('API routes', () => {
  it('returns health and an anonymous profile without a session', async () => {
    db = createTestDb();
    app = await buildApp(createTestConfig(), db);

    const health = await app.inject({ method: 'GET', url: '/health' });
    const me = await app.inject({ method: 'GET', url: '/me' });
    const stats = await app.inject({ method: 'GET', url: '/stats' });

    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ ok: true });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toEqual({ account: null, identities: [] });
    expect(stats.statusCode).toBe(401);
    expect(stats.json()).toEqual({ error: 'unauthorized' });
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
});
