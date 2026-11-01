import { openConfiguredDatabase } from './database.js';
import { promptText } from './prompts.js';

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

try {
  const currentEmail = (await promptText('Current admin email: ')).trim().toLowerCase();
  const nextEmail = (await promptText('New admin email: ')).trim().toLowerCase();
  if (!emailPattern.test(currentEmail) || !emailPattern.test(nextEmail)) {
    throw new Error('Enter valid current and new email addresses.');
  }
  if (currentEmail === nextEmail) throw new Error('The new email is the same as the current email.');

  const database = openConfiguredDatabase({ readonly: false });
  try {
    const admin = database.prepare('SELECT id FROM admin_users WHERE email = ?').get(currentEmail);
    if (!admin) throw new Error('No admin account with the current email exists in this database.');
    if (database.prepare('SELECT id FROM admin_users WHERE email = ?').get(nextEmail)) {
      throw new Error('Another admin account already uses the new email.');
    }

    const changeEmail = database.transaction(() => {
      database.prepare('UPDATE admin_users SET email = ? WHERE id = ?').run(nextEmail, admin.id);
      database.prepare('DELETE FROM admin_sessions WHERE user_id = ?').run(admin.id);
      database.prepare('DELETE FROM admin_password_resets WHERE user_id = ?').run(admin.id);
    });
    changeEmail();
    console.log(`Admin email changed. Sign in again with the new email; active sessions and reset links were revoked (ID ${admin.id}).`);
  } finally {
    database.close();
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
