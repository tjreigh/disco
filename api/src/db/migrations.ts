import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from './connection.js';

export function runMigrations(db: Db, migrationsDir: string): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  const applied = new Set(
    db.prepare('SELECT version FROM schema_migrations').all().map((row: unknown) => String((row as { version: string }).version)),
  );

  const files = readdirSync(migrationsDir)
    .filter((file: string) => file.endsWith('.sql'))
    .sort();

  const applyMigration = db.transaction((file: string) => {
    db.exec(readFileSync(join(migrationsDir, file), 'utf8'));
    db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(file);
  });

  for (const file of files) {
    if (!applied.has(file)) applyMigration(file);
  }
}
