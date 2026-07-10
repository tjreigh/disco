import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config.js';
import { openDatabase } from './connection.js';
import { runMigrations } from './migrations.js';

const config = loadConfig();
const db = openDatabase(config.databasePath);
const apiRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const migrationsDir = join(apiRoot, 'migrations');

runMigrations(db, migrationsDir);
db.close();
