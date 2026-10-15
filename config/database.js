import Database from 'better-sqlite3';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, scryptSync } from 'node:crypto';

const backendDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// On Vercel the filesystem is read-only except /tmp, so the database must live there.
const isVercel = Boolean(process.env.VERCEL);
let databasePath = process.env.DATABASE_PATH
  || (isVercel ? '/tmp/portfolio.sqlite' : path.join(backendDirectory, 'data', 'portfolio.sqlite'));

// Seed the ephemeral database from the bundled copy on first boot in a lambda instance.
if (isVercel && !process.env.DATABASE_PATH && !existsSync(databasePath)) {
  try {
    const bundledDatabase = path.join(backendDirectory, 'data', 'portfolio.sqlite');
    if (existsSync(bundledDatabase)) {
      copyFileSync(bundledDatabase, databasePath);
      console.log('Seeded /tmp database from bundled portfolio.sqlite.');
    }
  } catch (seedError) {
    console.error('Could not seed the /tmp database:', seedError.message);
  }
}
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

  CREATE TABLE IF NOT EXISTS portfolio_settings (
    setting_key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS download_enquiries (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT,
    phone TEXT,
    reason TEXT NOT NULL DEFAULT '',
    document_id TEXT NOT NULL,
    document_label TEXT NOT NULL,
    requested_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    downloaded_at TEXT
  );

  CREATE TABLE IF NOT EXISTS download_email_verifications (
    challenge_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    phone TEXT,
    reason TEXT NOT NULL,
    document_id TEXT NOT NULL,
    document_label TEXT NOT NULL,
    filename TEXT NOT NULL,
    code_hash TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS download_verification_limits (
    email_hash TEXT NOT NULL,
    ip_address TEXT NOT NULL,
    attempts INTEGER NOT NULL,
    window_started_at INTEGER NOT NULL,
    PRIMARY KEY (email_hash, ip_address)
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

const downloadEnquiryColumns = new Set(
  database.prepare('PRAGMA table_info(download_enquiries)').all().map((column) => column.name)
);
if (!downloadEnquiryColumns.has('reason')) {
  database.exec("ALTER TABLE download_enquiries ADD COLUMN reason TEXT NOT NULL DEFAULT ''");
}

// Track the real upload date of every document (existing rows keep NULL = seeded defaults).
const documentColumns = new Set(
  database.prepare('PRAGMA table_info(portfolio_documents)').all().map((column) => column.name)
);
if (!documentColumns.has('created_at')) {
  database.exec('ALTER TABLE portfolio_documents ADD COLUMN created_at TEXT');
}

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

const bootstrapAdmins = [
  {
    email: process.env.ADMIN_EMAIL?.trim().toLowerCase(),
    password: process.env.ADMIN_PASSWORD,
    displayName: process.env.ADMIN_DISPLAY_NAME?.trim()
  },
  {
    email: process.env.ADMIN_EMAIL_2?.trim().toLowerCase(),
    password: process.env.ADMIN_PASSWORD_2,
    displayName: process.env.ADMIN_DISPLAY_NAME_2?.trim()
  }
].filter((account) => account.email && account.password && account.displayName);

if (bootstrapAdmins.length) {
  for (const account of bootstrapAdmins) {
    if (account.password.length < 5) {
      throw new Error('ADMIN_PASSWORD (and ADMIN_PASSWORD_2, when set) must be at least 5 characters long.');
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(account.email)) {
      throw new Error(`The admin email "${account.email}" is not a valid email address.`);
    }

    const existingAdmin = database.prepare('SELECT rowid FROM admin_users WHERE email = ?').get(account.email);
    if (!existingAdmin) {
      const salt = randomBytes(16).toString('hex');
      const passwordHash = scryptSync(account.password, salt, 64).toString('hex');
      database.prepare(`
        INSERT INTO admin_users (email, display_name, password_hash)
        VALUES (?, ?, ?)
      `).run(account.email, account.displayName, `${salt}:${passwordHash}`);
      console.log(`Admin account created for ${account.email}.`);
    }
  }
} else {
  console.warn('Admin login is disabled until ADMIN_EMAIL, ADMIN_PASSWORD, and ADMIN_DISPLAY_NAME are configured.');
}

export default database;
