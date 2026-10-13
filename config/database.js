import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, scryptSync } from 'node:crypto';

const backendDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const databasePath = process.env.DATABASE_PATH || path.join(backendDirectory, 'data', 'portfolio.sqlite');
mkdirSync(path.dirname(databasePath), { recursive: true });

const database = new Database(databasePath);
database.pragma('journal_mode = WAL');
database.pragma('foreign_keys = ON');
database.exec(`
  CREATE TABLE IF NOT EXISTS admin_users (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS admin_sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS admin_login_attempts (
    ip_address TEXT PRIMARY KEY,
    failed_attempts INTEGER NOT NULL,
    window_started_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS download_enquiries (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT,
    phone TEXT,
    document_id TEXT NOT NULL,
    document_label TEXT NOT NULL,
    requested_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    downloaded_at TEXT
  );

  CREATE TABLE IF NOT EXISTS download_access_tokens (
    token_hash TEXT PRIMARY KEY,
    download_id INTEGER NOT NULL REFERENCES download_enquiries(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS portfolio_documents (
    document_id TEXT PRIMARY KEY,
    document_type TEXT NOT NULL CHECK (document_type IN ('cv', 'document', 'certificate')),
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    issued_at TEXT,
    institution TEXT,
    filename TEXT NOT NULL,
    stored_filename TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);

const seedDocument = database.prepare(`
  INSERT OR IGNORE INTO portfolio_documents
    (document_id, document_type, title, description, issued_at, institution, filename, stored_filename, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
seedDocument.run(
  'cv', 'cv', 'Curriculum Vitae',
  'A summary of my technical expertise, education, and professional experience.',
  null, null, 'KWIZERA-David-CV.pdf', 'KWIZERA David CV.pdf', '2026-01-01T00:00:00.000Z'
);
seedDocument.run(
  'ebc', 'document', 'EBC Document 2026',
  'Comprehensive event planning documentation and strategic management guidelines for professional event coordination.',
  '2026-01-01', 'EBC Organization', 'AGENDA_EBC-2026.pdf', 'AGENDA_EBC 2026.pdf', '2026-01-01T00:00:00.000Z'
);

const bootstrapEmail = process.env.ADMIN_EMAIL?.trim().toLowerCase();
const bootstrapPassword = process.env.ADMIN_PASSWORD;
const bootstrapDisplayName = process.env.ADMIN_DISPLAY_NAME?.trim();
const hasBootstrapCredentials = Boolean(bootstrapEmail && bootstrapPassword && bootstrapDisplayName);

if (hasBootstrapCredentials) {
  if (bootstrapPassword.length < 12) {
    throw new Error('ADMIN_PASSWORD must be at least 12 characters long.');
  }

  const existingAdmin = database.prepare('SELECT id FROM admin_users LIMIT 1').get();
  if (!existingAdmin) {
    const salt = randomBytes(16).toString('hex');
    const passwordHash = scryptSync(bootstrapPassword, salt, 64).toString('hex');
    database.prepare(`
      INSERT INTO admin_users (email, display_name, password_hash)
      VALUES (?, ?, ?)
    `).run(bootstrapEmail, bootstrapDisplayName, `${salt}:${passwordHash}`);
    console.log('Initial admin account created in SQLite.');
  }
} else {
  console.warn('Admin login is disabled until ADMIN_EMAIL, ADMIN_PASSWORD, and ADMIN_DISPLAY_NAME are configured.');
}

export default database;
