import { existsSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import dotenv from 'dotenv';
import { backendDirectory, getDatabasePath } from '../src/config/paths.js';

export { backendDirectory };

dotenv.config({ path: path.join(backendDirectory, '.env') });

export const databasePath = getDatabasePath();

export function openConfiguredDatabase({ readonly = true } = {}) {
  if (!existsSync(databasePath)) {
    throw new Error('The configured SQLite database was not found. Check DATABASE_PATH in .env.');
  }
  const database = new Database(databasePath, { readonly });
  if (!readonly) {
    const adminTable = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'admin_users'").get();
    if (adminTable) {
      const columns = new Set(database.prepare('PRAGMA table_info(admin_users)').all().map((column) => column.name));
      if (!columns.has('phone')) database.exec('ALTER TABLE admin_users ADD COLUMN phone TEXT');
      if (!columns.has('role')) database.exec("ALTER TABLE admin_users ADD COLUMN role TEXT NOT NULL DEFAULT 'portfolio_owner'");
      if (!columns.has('status')) database.exec("ALTER TABLE admin_users ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");
    }
  }
  return database;
}
