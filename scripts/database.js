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
  return new Database(databasePath, { readonly });
}
