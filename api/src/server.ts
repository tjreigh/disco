import { buildApp } from './app.js';
import { bootstrapDb } from './db/bootstrap.js';

const { config, db } = bootstrapDb();

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
