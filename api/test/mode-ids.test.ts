import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { Repositories } from '../src/db/repositories.js';
import { createTestConfig, createTestDb } from './helpers.js';
import { modeIdSchema } from '../src/stats/schemas.js';
import { SOLO_MODES } from '#game-modes';

let app: FastifyInstance | null = null;

afterEach(async () => {
  await app?.close();
  app = null;
});

// Regression test for audit-2 finding #1: every solo mode id the front end
// ships must be accepted by the stats/scores/leaderboards/saves routes. If
// this drifts from src/game/modes/index.ts's SOLO_MODES registry, signed-in
// players in the missing mode get 400s on every sync and the UI falls back
// to "Playing offline". Score Race and Disco Duel are multiplayer-only and
// must stay rejected here; see
// docs/deduplication-type-system-remediation-plan.md for the ownership
// rationale (these routes are solo-capability routes, not "every mode id").
const STATS_ELIGIBLE_MODE_IDS = SOLO_MODES
  .filter(mode => mode.stats.enabled)
  .map(mode => mode.id)
  .sort();
const SAVE_ELIGIBLE_MODE_IDS = SOLO_MODES
  .filter(mode => mode.persistence.enabled)
  .map(mode => mode.id)
  .sort();
const REJECTED_MODE_IDS = ['score-race', 'shared-duel', 'nonsense'] as const;

function savePayload(modeId: string) {
  return {
    version: 1,
    rulesVersion: 1,
    savedAt: 1_700_000_000_000,
    modeId,
    state: {},
    generation: {},
    session: {},
    meta: {},
  };
}

async function buildAuthenticatedRequest(label: string) {
  const db = createTestDb();
  app = await buildApp(createTestConfig(), db);
  const repos = new Repositories(db);

  const account = repos.findOrCreateAccountForIdentity({
    issuer: 'https://accounts.google.com',
    subject: `mode-contract-${label}`,
    email: null,
    emailVerified: true,
    providerName: 'google',
    displayName: null,
  });
  const token = `mode-contract-token-${label}`;
  repos.createSession(account.id, token, new Date(Date.now() + 60_000));
  return `disco_session=${token}`;
}

describe('mode id contract', () => {
  it('stats/score/leaderboard schema matches the live solo stats-eligible registry', () => {
    expect([...modeIdSchema.options].sort()).toEqual(STATS_ELIGIBLE_MODE_IDS);
  });

  it('save schema matches the live solo persistence-eligible registry', () => {
    // Saves reuse modeIdSchema (api/src/saves/schemas.ts), so the two
    // capability sets must stay equal for sharing one schema to remain
    // valid. If they ever diverge, split modeIdSchema into
    // capability-specific schemas instead of widening both routes.
    expect(SAVE_ELIGIBLE_MODE_IDS).toEqual(STATS_ELIGIBLE_MODE_IDS);
  });

  it.each(STATS_ELIGIBLE_MODE_IDS)('accepts stats, scores, and leaderboards for %s', async (modeId) => {
    const cookie = await buildAuthenticatedRequest(`stats-${modeId}`);
    const stats = { highScore: 100, longestStreak: 2, gamesPlayed: 1, totalScore: 100, averageScore: 100 };

    const put = await app!.inject({ method: 'PUT', url: `/stats/${modeId}`, headers: { cookie }, payload: stats });
    expect(put.statusCode).toBe(200);

    const score = await app!.inject({
      method: 'POST', url: `/scores/${modeId}`, headers: { cookie },
      payload: { score: 120, longestStreak: 3, clientStats: { ...stats, modeId } },
    });
    expect(score.statusCode).toBe(201);

    const leaderboard = await app!.inject({ method: 'GET', url: `/leaderboards/${modeId}?limit=5` });
    expect(leaderboard.statusCode).toBe(200);
    expect(leaderboard.json().entries.length).toBeGreaterThan(0);
  });

  it.each(SAVE_ELIGIBLE_MODE_IDS)('accepts save-slot writes for %s', async (modeId) => {
    const cookie = await buildAuthenticatedRequest(`save-${modeId}`);

    const put = await app!.inject({
      method: 'PUT', url: `/saves/${modeId}`, headers: { cookie },
      payload: {
        expectedRevision: 0,
        runId: '00000000-0000-4000-8000-000000000001',
        save: savePayload(modeId),
      },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().save).toMatchObject({ modeId, revision: 1 });
  });

  it.each(REJECTED_MODE_IDS)('rejects multiplayer and unknown mode ids (%s)', async (modeId) => {
    const cookie = await buildAuthenticatedRequest(`rejected-${modeId}`);

    const stats = await app!.inject({
      method: 'PUT', url: `/stats/${modeId}`, headers: { cookie },
      payload: { highScore: 100, longestStreak: 2, gamesPlayed: 1, totalScore: 100, averageScore: 100 },
    });
    expect(stats.statusCode).toBe(400);

    const save = await app!.inject({
      method: 'PUT', url: `/saves/${modeId}`, headers: { cookie },
      payload: {
        expectedRevision: 0,
        runId: '00000000-0000-4000-8000-000000000001',
        save: savePayload(modeId),
      },
    });
    expect(save.statusCode).toBe(400);

    const leaderboard = await app!.inject({ method: 'GET', url: `/leaderboards/${modeId}?limit=5` });
    expect(leaderboard.statusCode).toBe(400);
  });
});
