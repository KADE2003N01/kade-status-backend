import dotenv from 'dotenv';
import path from 'node:path';
import { backendDirectory } from './database.js';

dotenv.config({ path: path.join(backendDirectory, '.env') });
const { default: database } = await import('../src/database/database.js');

try {
  const tables = database.prepare(`
    SELECT name, sql FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND sql IS NOT NULL
    ORDER BY name
  `).all();
  for (const { sql } of tables) process.stdout.write(`${sql};\n\n`);
} finally {
  database.close();
}
