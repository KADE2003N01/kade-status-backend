import { randomBytes, scryptSync } from 'node:crypto';
import { openConfiguredDatabase } from './database.js';
import { promptPasswordPair, promptText } from './prompts.js';

const SUPER_ADMIN_ROLES = [
  'platform_owner',
  'portfolio_owner',
  'content_manager',
  'document_manager',
  'download_manager',
  'profile_manager'
];

try {
  const email = (await promptText('Super-admin email: ')).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('Enter a valid email address.');
  }

  const displayName = (await promptText('Display name: ')).trim();
  if (displayName.length < 2 || displayName.length > 120) {
    throw new Error('Enter a display name from 2 to 120 characters.');
  }

  const phone = (await promptText('Phone number (optional): ')).trim();
  if (phone.length > 40) throw new Error('Enter a phone number no longer than 40 characters.');

  const password = await promptPasswordPair(12);
  if (password === null) {
    console.log('Super-admin creation cancelled.');
    process.exitCode = 1;
  } else {
    const database = openConfiguredDatabase({ readonly: false });
    try {
      if (database.prepare('SELECT id FROM admin_users WHERE email = ?').get(email)) {
        throw new Error('An admin with that email already exists. Run `npm run super-admin:promote` to grant super-admin access without changing its password.');
      }

      const salt = randomBytes(16).toString('hex');
      const passwordHash = scryptSync(password, salt, 64).toString('hex');
      const result = database.prepare(`
        INSERT INTO admin_users (email, display_name, password_hash, phone, role, status, roles_json)
        VALUES (?, ?, ?, ?, 'platform_owner', 'active', ?)
      `).run(email, displayName, `${salt}:${passwordHash}`, phone || null, JSON.stringify(SUPER_ADMIN_ROLES));
      database.prepare('DELETE FROM admin_sessions WHERE user_id = ?').run(result.lastInsertRowid);
      console.log(`Super-admin account created in admin_users (ID ${result.lastInsertRowid}).`);
    } finally {
      database.close();
    }
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
