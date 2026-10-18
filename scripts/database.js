import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import dotenv from 'dotenv';

export const backendDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(backendDirectory, '.env') });

const configuredPath = process.env.DATABASE_PATH;
export const databasePath = configuredPath
  ? path.resolve(process.cwd(), configuredPath)
  : path.join(backendDirectory, 'data', 'portfolio.sqlite');

export function openConfiguredDatabase({ readonly = true } = {}) {
  if (!existsSync(databasePath)) {
    throw new Error('The configured SQLite database was not found. Check DATABASE_PATH in .env.');
  }
  return new Database(databasePath, { readonly });
}
