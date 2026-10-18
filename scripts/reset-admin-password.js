import { randomBytes, scryptSync } from 'node:crypto';
import { openConfiguredDatabase } from './database.js';
import { promptPasswordPair, promptText } from './prompts.js';

const email = (await promptText('Admin email to reset: ')).trim().toLowerCase();

if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  console.error('Enter a valid admin email address.');
  process.exitCode = 1;
} else {
  try {
    const password = await promptPasswordPair();
    if (password === null) {
      console.error('Password reset cancelled.');
      process.exitCode = 1;
    } else {
      const database = openConfiguredDatabase({ readonly: false });
      try {
        const admin = database.prepare('SELECT id FROM admin_users WHERE email = ?').get(email);
        if (!admin) {
          console.error('No admin account with that email exists in this database.');
          process.exitCode = 1;
        } else {
          const salt = randomBytes(16).toString('hex');
          const passwordHash = scryptSync(password, salt, 64).toString('hex');
          const resetPassword = database.transaction(() => {
            database.prepare('UPDATE admin_users SET password_hash = ? WHERE id = ?')
              .run(`${salt}:${passwordHash}`, admin.id);
            return database.prepare('DELETE FROM admin_sessions WHERE user_id = ?').run(admin.id).changes;
          });
          const revokedSessions = resetPassword();
          console.log(`Password reset for ${email}. Revoked ${revokedSessions} existing session(s).`);
        }
      } finally {
        database.close();
      }
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
