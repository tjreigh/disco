import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import type { AppConfig } from '../src/config.js';
import { runMigrations } from '../src/db/migrations.js';

export function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');

  const testDir = dirname(fileURLToPath(import.meta.url));
  runMigrations(db, join(testDir, '..', 'migrations'));
  return db;
}

export function createTestConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    nodeEnv: 'test',
    host: '127.0.0.1',
    port: 8787,
    databasePath: ':memory:',
    publicSiteOrigin: 'http://localhost:3000',
    apiOrigin: 'http://localhost:8787',
    sessionSecret: 'test-session-secret-with-32-characters',
    sessionCookieName: 'disco_session',
    sessionTtlSeconds: 60 * 60,
    cookieSecure: false,
    oidcProviders: new Map(),
    ...overrides,
  };
}
