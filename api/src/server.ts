import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { buildApp } from './app.js';
import { openDatabase } from './db/connection.js';
import { runMigrations } from './db/migrations.js';

const config = loadConfig();
const db = openDatabase(config.databasePath);
const apiRoot = dirname(dirname(fileURLToPath(import.meta.url)));
runMigrations(db, join(apiRoot, 'migrations'));

const app = await buildApp(config, db);

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}

process.on('SIGTERM', () => {
  void app.close().finally(() => db.close());
});
