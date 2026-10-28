import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomBytes, scryptSync } from 'node:crypto';
import { backendDirectory, getDatabasePath } from '../config/paths.js';

const databasePath = getDatabasePath();
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
    phone TEXT,
    role TEXT NOT NULL DEFAULT 'portfolio_owner',
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS admin_sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS portfolio_settings (
    setting_key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS contact_messages (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    phone TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'new',
    deleted_at TEXT
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
    downloaded_at TEXT,
    download_status TEXT NOT NULL DEFAULT 'requested'
  );

  CREATE TABLE IF NOT EXISTS admin_password_resets (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS platform_admin_audit (
    id INTEGER PRIMARY KEY,
    actor_id INTEGER REFERENCES admin_users(id) ON DELETE SET NULL,
    target_id INTEGER REFERENCES admin_users(id) ON DELETE SET NULL,
    action TEXT NOT NULL,
    details_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS admin_support_requests (
    id INTEGER PRIMARY KEY,
    admin_user_id INTEGER REFERENCES admin_users(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    category TEXT NOT NULL,
    message TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    resolved_at TEXT
  );

  CREATE TABLE IF NOT EXISTS platform_message_threads (
    id INTEGER PRIMARY KEY,
    admin_user_id INTEGER NOT NULL UNIQUE REFERENCES admin_users(id) ON DELETE CASCADE,
    reply_allowed INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS platform_message_owner_reply_access (
    admin_user_id INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
    owner_user_id INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
    reply_allowed INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (admin_user_id, owner_user_id)
  );

  CREATE TABLE IF NOT EXISTS platform_messages (
    id INTEGER PRIMARY KEY,
    thread_id INTEGER NOT NULL REFERENCES platform_message_threads(id) ON DELETE CASCADE,
    sender_id INTEGER REFERENCES admin_users(id) ON DELETE SET NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS admin_public_messages (
    id INTEGER PRIMARY KEY,
    sender_id INTEGER REFERENCES admin_users(id) ON DELETE SET NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    edited_at TEXT,
    deleted_at TEXT
  );

  CREATE TABLE IF NOT EXISTS admin_public_message_reads (
    message_id INTEGER NOT NULL REFERENCES admin_public_messages(id) ON DELETE CASCADE,
    reader_id INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
    read_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (message_id, reader_id)
  );

  CREATE TABLE IF NOT EXISTS contact_message_replies (
    id INTEGER PRIMARY KEY,
    contact_message_id INTEGER NOT NULL REFERENCES contact_messages(id) ON DELETE CASCADE,
    admin_user_id INTEGER REFERENCES admin_users(id) ON DELETE SET NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS contact_message_reads (
    contact_message_id INTEGER NOT NULL REFERENCES contact_messages(id) ON DELETE CASCADE,
    reader_id INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
    read_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (contact_message_id, reader_id)
  );

  CREATE TABLE IF NOT EXISTS platform_message_reactions (
    message_id INTEGER NOT NULL REFERENCES platform_messages(id) ON DELETE CASCADE,
    reactor_id INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
    emoji TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (message_id, reactor_id, emoji)
  );

  CREATE TABLE IF NOT EXISTS platform_message_user_flags (
    message_id INTEGER NOT NULL REFERENCES platform_messages(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
    is_pinned INTEGER NOT NULL DEFAULT 0,
    is_starred INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (message_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS contact_message_reactions (
    contact_message_id INTEGER REFERENCES contact_messages(id) ON DELETE CASCADE,
    reply_id INTEGER REFERENCES contact_message_replies(id) ON DELETE CASCADE,
    reactor_id INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
    emoji TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK ((contact_message_id IS NOT NULL AND reply_id IS NULL) OR (contact_message_id IS NULL AND reply_id IS NOT NULL))
  );

  CREATE TABLE IF NOT EXISTS platform_message_reads (
    message_id INTEGER NOT NULL REFERENCES platform_messages(id) ON DELETE CASCADE,
    reader_id INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
    read_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (message_id, reader_id)
  );

  CREATE TABLE IF NOT EXISTS platform_message_deliveries (
    message_id INTEGER NOT NULL REFERENCES platform_messages(id) ON DELETE CASCADE,
    recipient_id INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
    delivered_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (message_id, recipient_id)
  );

  CREATE TABLE IF NOT EXISTS platform_message_hidden (
    message_id INTEGER NOT NULL REFERENCES platform_messages(id) ON DELETE CASCADE,
    admin_user_id INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
    hidden_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (message_id, admin_user_id)
  );

  CREATE TABLE IF NOT EXISTS platform_message_permanent_hidden (
    message_id INTEGER NOT NULL REFERENCES platform_messages(id) ON DELETE CASCADE,
    admin_user_id INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
    deleted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (message_id, admin_user_id)
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

  CREATE TABLE IF NOT EXISTS document_preview_tokens (
    token_hash TEXT PRIMARY KEY,
    document_id TEXT NOT NULL,
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
if (!downloadEnquiryColumns.has('download_status')) {
  database.exec("ALTER TABLE download_enquiries ADD COLUMN download_status TEXT NOT NULL DEFAULT 'requested'");
  database.exec("UPDATE download_enquiries SET download_status = 'downloaded' WHERE downloaded_at IS NOT NULL");
}
if (!downloadEnquiryColumns.has('phone')) database.exec('ALTER TABLE download_enquiries ADD COLUMN phone TEXT');

const verificationColumns = new Set(
  database.prepare('PRAGMA table_info(download_email_verifications)').all().map((column) => column.name)
);
if (!verificationColumns.has('phone')) database.exec('ALTER TABLE download_email_verifications ADD COLUMN phone TEXT');
if (!verificationColumns.has('purpose')) database.exec("ALTER TABLE download_email_verifications ADD COLUMN purpose TEXT NOT NULL DEFAULT 'download'");

const adminColumns = new Set(database.prepare('PRAGMA table_info(admin_users)').all().map((column) => column.name));
if (!adminColumns.has('phone')) database.exec('ALTER TABLE admin_users ADD COLUMN phone TEXT');
if (!adminColumns.has('role')) database.exec("ALTER TABLE admin_users ADD COLUMN role TEXT NOT NULL DEFAULT 'portfolio_owner'");
if (!adminColumns.has('status')) database.exec("ALTER TABLE admin_users ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");
if (!adminColumns.has('roles_json')) database.exec("ALTER TABLE admin_users ADD COLUMN roles_json TEXT NOT NULL DEFAULT '[]'");
const allSuperAdminRoles = ['platform_owner', 'portfolio_owner', 'content_manager', 'document_manager', 'download_manager', 'profile_manager'];
for (const admin of database.prepare('SELECT id, role, roles_json FROM admin_users').all()) {
  let roles;
  try { roles = JSON.parse(admin.roles_json || '[]'); } catch { roles = []; }
  if (!Array.isArray(roles) || !roles.length) roles = [admin.role || 'portfolio_owner'];
  if (admin.role === 'platform_owner' || roles.includes('platform_owner')) roles = allSuperAdminRoles;
  roles = [...new Set(roles.filter((role) => typeof role === 'string'))];
  database.prepare('UPDATE admin_users SET roles_json = ?, role = ? WHERE id = ?')
    .run(JSON.stringify(roles), roles.includes('platform_owner') ? 'platform_owner' : roles[0], admin.id);
}
database.exec('DROP INDEX IF EXISTS one_platform_owner');

const messageThreadColumns = new Set(database.prepare('PRAGMA table_info(platform_message_threads)').all().map((column) => column.name));
if (!messageThreadColumns.has('reply_allowed')) database.exec('ALTER TABLE platform_message_threads ADD COLUMN reply_allowed INTEGER NOT NULL DEFAULT 1');
const platformMessageColumns = new Set(database.prepare('PRAGMA table_info(platform_messages)').all().map((column) => column.name));
if (!platformMessageColumns.has('deleted_at')) database.exec('ALTER TABLE platform_messages ADD COLUMN deleted_at TEXT');
if (!platformMessageColumns.has('edited_at')) database.exec('ALTER TABLE platform_messages ADD COLUMN edited_at TEXT');
if (!platformMessageColumns.has('message_group_id')) database.exec('ALTER TABLE platform_messages ADD COLUMN message_group_id TEXT');
if (!platformMessageColumns.has('message_group_label')) database.exec('ALTER TABLE platform_messages ADD COLUMN message_group_label TEXT');
if (!platformMessageColumns.has('reply_allowed')) database.exec('ALTER TABLE platform_messages ADD COLUMN reply_allowed INTEGER NOT NULL DEFAULT 1');
if (!platformMessageColumns.has('reply_to_message_id')) database.exec('ALTER TABLE platform_messages ADD COLUMN reply_to_message_id INTEGER REFERENCES platform_messages(id) ON DELETE SET NULL');
if (!platformMessageColumns.has('recipient_owner_id')) database.exec('ALTER TABLE platform_messages ADD COLUMN recipient_owner_id INTEGER REFERENCES admin_users(id) ON DELETE SET NULL');
const contactMessageColumns = new Set(database.prepare('PRAGMA table_info(contact_messages)').all().map((column) => column.name));
if (!contactMessageColumns.has('status')) database.exec("ALTER TABLE contact_messages ADD COLUMN status TEXT NOT NULL DEFAULT 'new'");
if (!contactMessageColumns.has('deleted_at')) database.exec('ALTER TABLE contact_messages ADD COLUMN deleted_at TEXT');
database.exec(`CREATE TABLE IF NOT EXISTS platform_message_attachments (
  id TEXT PRIMARY KEY,
  uploaded_by_id INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  message_id INTEGER REFERENCES platform_messages(id) ON DELETE CASCADE,
  public_message_id INTEGER REFERENCES admin_public_messages(id) ON DELETE CASCADE,
  message_group_id TEXT,
  original_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  stored_name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)`);
const messageAttachmentColumns = new Set(database.prepare('PRAGMA table_info(platform_message_attachments)').all().map((column) => column.name));
if (!messageAttachmentColumns.has('public_message_id')) database.exec('ALTER TABLE platform_message_attachments ADD COLUMN public_message_id INTEGER REFERENCES admin_public_messages(id) ON DELETE CASCADE');
database.exec('CREATE INDEX IF NOT EXISTS idx_platform_message_attachments_group ON platform_message_attachments(message_group_id)');
database.exec('CREATE INDEX IF NOT EXISTS idx_admin_public_messages_created ON admin_public_messages(created_at, id)');
database.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_contact_message_reactions_root
  ON contact_message_reactions(contact_message_id, reactor_id, emoji) WHERE contact_message_id IS NOT NULL`);
database.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_contact_message_reactions_reply
  ON contact_message_reactions(reply_id, reactor_id, emoji) WHERE reply_id IS NOT NULL`);

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
    displayName: process.env.ADMIN_DISPLAY_NAME?.trim(),
    phone: process.env.ADMIN_PHONE?.trim() || null
  },
  {
    email: process.env.ADMIN_EMAIL_2?.trim().toLowerCase(),
    password: process.env.ADMIN_PASSWORD_2,
    displayName: process.env.ADMIN_DISPLAY_NAME_2?.trim(),
    phone: process.env.ADMIN_PHONE_2?.trim() || null
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
        INSERT INTO admin_users (email, display_name, password_hash, phone)
        VALUES (?, ?, ?, ?)
      `).run(account.email, account.displayName, `${salt}:${passwordHash}`, account.phone);
      console.log(`Admin account created for ${account.email}.`);
    } else if (account.phone) {
      database.prepare('UPDATE admin_users SET phone = ? WHERE email = ?').run(account.phone, account.email);
    }
  }
} else {
  console.warn(`Admin login is disabled because this database has no admin account: ${databasePath}`);
  console.warn(`Create one with "npm run admin:add" from ${backendDirectory}.`);
}

const configuredPlatformOwnerEmail = process.env.PLATFORM_OWNER_EMAIL?.trim().toLowerCase();
if (configuredPlatformOwnerEmail) {
  const platformOwner = database.prepare('SELECT id, roles_json FROM admin_users WHERE email = ?').get(configuredPlatformOwnerEmail) || null;
  if (!platformOwner) {
    console.warn(`PLATFORM_OWNER_EMAIL does not match an admin account: ${configuredPlatformOwnerEmail}.`);
  } else {
    const roles = JSON.parse(platformOwner.roles_json || '[]');
    if (!roles.includes('platform_owner')) roles.push('platform_owner');
    database.prepare("UPDATE admin_users SET role = 'platform_owner', roles_json = ?, status = 'active' WHERE id = ?")
      .run(JSON.stringify(roles), platformOwner.id);
  }
}

export default database;
