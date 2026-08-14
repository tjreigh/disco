import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config.js';
import type { AppConfig } from '../config.js';
import { openDatabase } from './connection.js';
import type { Db } from './connection.js';
import { runMigrations } from './migrations.js';

// This file lives at api/src/db/bootstrap.ts, exactly three directories
// below the API package root (api/) — a fixed, known depth, unlike
// server.ts and migrate.ts's own locations, which previously each
// hand-counted their own distance from api/ (2 and 3 dirname() calls
// respectively) and would silently break if either file moved. Computing
// the root from this file's own import.meta.url instead means callers
// never need to know or recompute that depth themselves.
const API_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

export function resolveMigrationsDir(): string {
  return join(API_ROOT, 'migrations');
}

export interface DbBootstrap {
  readonly config: AppConfig;
  readonly db: Db;
}

/** Loads config, opens the database, and runs pending migrations — the common startup sequence for both the server and the standalone migrate script. */
export function bootstrapDb(): DbBootstrap {
  const config = loadConfig();
  const db = openDatabase(config.databasePath);
  runMigrations(db, resolveMigrationsDir());
  return { config, db };
}
