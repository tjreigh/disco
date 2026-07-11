import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { Repositories } from '../src/db/repositories.js';
import { createTestConfig, createTestDb } from './helpers.js';

let app: FastifyInstance | null = null;

afterEach(async () => {
  await app?.close();
  app = null;
});

// Regression test for audit-2 finding #1: every mode id the front end ships
// must be accepted by the stats/scores/leaderboard routes. If this list and
// src/game/modes/index.ts drift apart, signed-in players in the missing mode
// get 400s on every sync and the UI falls back to "Playing offline".
const FRONT_END_MODE_IDS = ['classic', 'gravity'] as const;

describe('mode id contract', () => {
  it.each(FRONT_END_MODE_IDS)('accepts stats, scores, and leaderboards for %s', async (modeId) => {
    const db = createTestDb();
    app = await buildApp(createTestConfig(), db);
    const repos = new Repositories(db);

    const account = repos.findOrCreateAccountForIdentity({
      issuer: 'https://accounts.google.com',
      subject: `mode-contract-${modeId}`,
      email: null,
      emailVerified: true,
      providerName: 'google',
      displayName: null,
    });
    const token = `mode-contract-token-${modeId}`;
    repos.createSession(account.id, token, new Date(Date.now() + 60_000));
    const cookie = `disco_session=${token}`;
    const stats = { highScore: 100, longestStreak: 2, gamesPlayed: 1, totalScore: 100, averageScore: 100 };

    const put = await app.inject({ method: 'PUT', url: `/stats/${modeId}`, headers: { cookie }, payload: stats });
    expect(put.statusCode).toBe(200);

    const score = await app.inject({
      method: 'POST', url: `/scores/${modeId}`, headers: { cookie },
      payload: { score: 120, longestStreak: 3, clientStats: { ...stats, modeId } },
    });
    expect(score.statusCode).toBe(201);

    const leaderboard = await app.inject({ method: 'GET', url: `/leaderboards/${modeId}?limit=5` });
    expect(leaderboard.statusCode).toBe(200);
    expect(leaderboard.json().entries.length).toBeGreaterThan(0);
  });

  it('still rejects unknown mode ids', async () => {
    const db = createTestDb();
    app = await buildApp(createTestConfig(), db);
    const leaderboard = await app.inject({ method: 'GET', url: '/leaderboards/nonsense' });
    expect(leaderboard.statusCode).toBe(400);
  });
});
