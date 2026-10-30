import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const migrationsDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');
const migrationFilename = /^(\d{3})_([a-z0-9_]+)\.sql$/;

export function runMigrations(database, directory = migrationsDirectory) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  const migrations = readdirSync(directory)
    .filter((filename) => filename.endsWith('.sql'))
    .map((filename) => {
      const match = migrationFilename.exec(filename);
      if (!match) throw new Error(`Invalid migration filename: ${filename}`);
      return { filename, version: Number(match[1]) };
    })
    .sort((left, right) => left.version - right.version);

  for (let index = 1; index < migrations.length; index += 1) {
    if (migrations[index - 1].version === migrations[index].version) {
      throw new Error(`Duplicate migration version: ${migrations[index].version}`);
    }
  }

  const getAppliedMigration = database.prepare(
    'SELECT name FROM schema_migrations WHERE version = ?'
  );
  const recordMigration = database.prepare(
    'INSERT INTO schema_migrations (version, name) VALUES (?, ?)'
  );

  for (const migration of migrations) {
    const applied = getAppliedMigration.get(migration.version);
    if (applied) {
      if (applied.name !== migration.filename) {
        throw new Error(`Applied migration ${migration.version} has been renamed.`);
      }
      continue;
    }

    const sql = readFileSync(path.join(directory, migration.filename), 'utf8');
    try {
      database.transaction(() => {
        database.exec(sql);
        recordMigration.run(migration.version, migration.filename);
      })();
    } catch (error) {
      throw new Error(`Failed to apply migration ${migration.filename}: ${error.message}`, { cause: error });
    }
  }
}
