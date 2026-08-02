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
      WHERE type = 'table' AND name IN (
        'accounts', 'account_identities', 'sessions', 'account_mode_stats',
        'score_submissions', 'account_save_slots'
      )
      ORDER BY name
    `).all() as Array<{ name: string }>;

    expect(applied).toEqual([
      { version: '001_initial.sql' },
      { version: '002_account_save_slots.sql' },
      { version: '003_advanced_stats.sql' },
    ]);
    const statColumns = db.prepare('PRAGMA table_info(account_mode_stats)').all() as Array<{ name: string }>;
    expect(statColumns.map(column => column.name)).toEqual(expect.arrayContaining([
      'total_play_time_ms', 'total_discs_dropped', 'total_discs_broken',
    ]));
    expect(tables.map(table => table.name)).toEqual([
      'account_identities',
      'account_mode_stats',
      'account_save_slots',
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
    expect(alphaStats).toMatchObject({
      totalPlayTimeMs: 0,
      totalDiscsDropped: 0,
      totalDiscsBroken: 0,
    });
    expect(submissions).toEqual([
      { score: 120, longest_streak: 6, accepted: 1 },
      { score: 90, longest_streak: 5, accepted: 1 },
    ]);
    expect(leaderboard.map(entry => [entry.displayName, entry.highScore])).toEqual([
      ['Alpha', 120],
      ['Beta', 90],
    ]);
  });

  it('stores account- and mode-isolated save slots with compare-and-swap revisions and tombstones', () => {
    db = createTestDb();
    const repos = new Repositories(db);
    const alpha = repos.findOrCreateAccountForIdentity({
      issuer: 'https://issuer.example',
      subject: 'save-alpha',
      email: null,
      emailVerified: false,
      providerName: 'test',
      displayName: 'Alpha',
    });
    const beta = repos.findOrCreateAccountForIdentity({
      issuer: 'https://issuer.example',
      subject: 'save-beta',
      email: null,
      emailVerified: false,
      providerName: 'test',
      displayName: 'Beta',
    });
    const classicSave = { version: 1, modeId: 'classic', state: { score: 12 } };
    const gravitySave = { version: 1, modeId: 'gravity', state: { score: 8 } };

    const created = repos.writeSaveSlot(alpha.id, {
      modeId: 'classic',
      expectedRevision: 0,
      runId: '00000000-0000-4000-8000-000000000001',
      save: classicSave,
    });
    const otherMode = repos.writeSaveSlot(alpha.id, {
      modeId: 'gravity',
      expectedRevision: 0,
      runId: '00000000-0000-4000-8000-000000000002',
      save: gravitySave,
    });
    repos.writeSaveSlot(beta.id, {
      modeId: 'classic',
      expectedRevision: 0,
      runId: '00000000-0000-4000-8000-000000000003',
      save: { ...classicSave, state: { score: 99 } },
    });

    expect(created).toMatchObject({ ok: true, slot: { revision: 1, save: classicSave } });
    expect(otherMode).toMatchObject({ ok: true, slot: { revision: 1, save: gravitySave } });
    expect(repos.listSaveSlots(alpha.id).map(slot => slot.modeId)).toEqual(['classic', 'gravity']);
    expect(repos.listSaveSlots(beta.id)).toMatchObject([{ modeId: 'classic', save: { state: { score: 99 } } }]);

    const stale = repos.writeSaveSlot(alpha.id, {
      modeId: 'classic',
      expectedRevision: 0,
      runId: '00000000-0000-4000-8000-000000000004',
      save: classicSave,
    });
    expect(stale).toMatchObject({ ok: false, current: { revision: 1, runId: '00000000-0000-4000-8000-000000000001' } });

    const deleted = repos.writeSaveSlot(alpha.id, {
      modeId: 'classic',
      expectedRevision: 1,
      runId: null,
      save: null,
    });
    expect(deleted).toMatchObject({ ok: true, slot: { revision: 2, runId: null, save: null } });
    expect(repos.listSaveSlots(alpha.id)).toMatchObject([
      { modeId: 'classic', revision: 2, runId: null, save: null },
      { modeId: 'gravity', revision: 1 },
    ]);
  });

  it('reports a missing save slot as a revision-zero conflict', () => {
    db = createTestDb();
    const repos = new Repositories(db);
    const account = repos.findOrCreateAccountForIdentity({
      issuer: 'https://issuer.example',
      subject: 'save-missing',
      email: null,
      emailVerified: false,
      providerName: 'test',
      displayName: null,
    });

    expect(repos.writeSaveSlot(account.id, {
      modeId: 'stack',
      expectedRevision: 3,
      runId: null,
      save: null,
    })).toEqual({ ok: false, current: null });
  });
});
