import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config.js';
import { openDatabase } from './connection.js';
import { runMigrations } from './migrations.js';

const MIGRATIONS_DIR = join(
  dirname(dirname(dirname(fileURLToPath(import.meta.url)))),
  'migrations',
);

/** Common database startup for the server and migration script. */
export function bootstrapDb() {
  const config = loadConfig();
  const db = openDatabase(config.databasePath);
  runMigrations(db, MIGRATIONS_DIR);
  return { config, db };
}
