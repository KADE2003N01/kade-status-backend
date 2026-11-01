import { openConfiguredDatabase } from './database.js';
import { promptText } from './prompts.js';

const SUPER_ADMIN_ROLES = [
  'platform_owner',
  'portfolio_owner',
  'content_manager',
  'document_manager',
  'download_manager',
  'profile_manager'
];

try {
  const email = (await promptText('Existing admin email to promote: ')).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('Enter a valid email address.');
  }

  const database = openConfiguredDatabase({ readonly: false });
  try {
    const admin = database.prepare('SELECT id FROM admin_users WHERE email = ?').get(email);
    if (!admin) {
      throw new Error('No admin account with that email exists in the configured database.');
    }

    database.transaction(() => {
      database.prepare(`UPDATE admin_users
        SET role = 'platform_owner', roles_json = ?, status = 'active'
        WHERE id = ?`).run(JSON.stringify(SUPER_ADMIN_ROLES), admin.id);
      database.prepare('DELETE FROM admin_sessions WHERE user_id = ?').run(admin.id);
    })();
    console.log(`Admin account promoted to super admin. Sign in again with its existing password (ID ${admin.id}).`);
  } finally {
    database.close();
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
