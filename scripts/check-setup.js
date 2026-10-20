import { existsSync } from 'node:fs';
import Database from 'better-sqlite3';
import { backendDirectory, databasePath } from './database.js';

const envPath = `${backendDirectory}/.env`;
const envFileExists = existsSync(envPath);
const databaseExists = existsSync(databasePath);
let adminCount = null;

if (databaseExists) {
  const database = new Database(databasePath, { readonly: true });
  try {
    const hasAdminTable = database.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'admin_users'"
    ).get();
    if (hasAdminTable) {
      adminCount = database.prepare('SELECT COUNT(*) AS count FROM admin_users').get().count;
    }
  } finally {
    database.close();
  }
}

console.log('Portfolio backend setup');
console.log(`Backend folder: ${backendDirectory}`);
console.log(`Environment file: ${envFileExists ? 'found' : 'not found (optional for admin:add)'}`);
console.log(`Database file: ${databaseExists ? databasePath : `${databasePath} (not created yet)`}`);
console.log(`Admin accounts: ${adminCount === null ? 'database schema is not initialized' : adminCount}`);

if (adminCount === 0) {
  console.log('\nNo administrator is configured. Run `npm run admin:add` in this folder, then use the email and password you set on the login page.');
} else if (adminCount === null) {
  console.log('\nStart the backend once with `npm start` to initialize the database, then run `npm run admin:add`.');
} else {
  console.log('\nAdmin setup is ready. If login still fails, check that the frontend is using this backend and run `npm run admin:list`.');
}

if (adminCount === null || adminCount === 0) process.exitCode = 1;
