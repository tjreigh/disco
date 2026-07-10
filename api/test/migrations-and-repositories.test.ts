import { afterEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { runMigrations } from '../src/db/migrations.js';
import { Repositories } from '../src/db/repositories.js';
import { createTestDb } from './helpers.js';

let db: Database.Database | null = null;

afterEach(() => {
  db?.close();
  db = null;
});

describe('runMigrations', () => {
  it('applies each migration once', () => {
    db = createTestDb();

    runMigrations(db, new URL('../migrations', import.meta.url).pathname);

    const applied = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{ version: string }>;
    const tables = db.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name IN ('accounts', 'account_identities', 'sessions', 'account_mode_stats', 'score_submissions')
      ORDER BY name
    `).all() as Array<{ name: string }>;

    expect(applied).toEqual([{ version: '001_initial.sql' }]);
    expect(tables.map(table => table.name)).toEqual([
      'account_identities',
      'account_mode_stats',
      'accounts',
      'score_submissions',
      'sessions',
    ]);
  });
});

describe('Repositories', () => {
  it('does not return expired sessions created earlier on the same day', () => {
    db = createTestDb();
    const repos = new Repositories(db);
    const account = repos.findOrCreateAccountForIdentity({
      issuer: 'https://issuer.example',
      subject: 'user-1',
      email: 'user@example.com',
      emailVerified: true,
      providerName: 'test',
      displayName: 'User One',
    });

    repos.createSession(account.id, 'expired-token', new Date(Date.now() - 60 * 60 * 1000));

    expect(repos.findSessionByToken('expired-token')).toBeNull();
  });

  it('records score submissions and produces a leaderboard ordered by high score', () => {
    db = createTestDb();
    const repos = new Repositories(db);
    const alpha = repos.findOrCreateAccountForIdentity({
      issuer: 'https://issuer.example',
      subject: 'alpha',
      email: 'alpha@example.com',
      emailVerified: true,
      providerName: 'test',
      displayName: 'Alpha',
    });
    const beta = repos.findOrCreateAccountForIdentity({
      issuer: 'https://issuer.example',
      subject: 'beta',
      email: 'beta@example.com',
      emailVerified: true,
      providerName: 'test',
      displayName: 'Beta',
    });

    const alphaStats = repos.submitScore(alpha.id, {
      modeId: 'classic',
      score: 120,
      longestStreak: 6,
      clientStats: null,
    });
    repos.submitScore(beta.id, {
      modeId: 'classic',
      score: 90,
      longestStreak: 5,
      clientStats: null,
    });

    const submissions = db.prepare(`
      SELECT score, longest_streak, accepted
      FROM score_submissions
      ORDER BY score DESC
    `).all() as Array<{ score: number; longest_streak: number; accepted: number }>;
    const leaderboard = repos.leaderboard('classic', 10);

    expect(alphaStats.highScore).toBe(120);
    expect(alphaStats.gamesPlayed).toBe(1);
    expect(alphaStats.totalScore).toBe(120);
    expect(alphaStats.averageScore).toBe(120);
    expect(submissions).toEqual([
      { score: 120, longest_streak: 6, accepted: 1 },
      { score: 90, longest_streak: 5, accepted: 1 },
    ]);
    expect(leaderboard.map(entry => [entry.displayName, entry.highScore])).toEqual([
      ['Alpha', 120],
      ['Beta', 90],
    ]);
  });
});
