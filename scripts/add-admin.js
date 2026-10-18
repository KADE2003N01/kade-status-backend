import { randomBytes, scryptSync } from 'node:crypto';
import { openConfiguredDatabase } from './database.js';
import { promptPasswordPair, promptText } from './prompts.js';

try {
  const email = (await promptText('New admin email: ')).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('Enter a valid email address.');
  }

  const displayName = (await promptText('Admin display name: ')).trim();
  if (!displayName || displayName.length > 120) {
    throw new Error('Enter a display name from 1 to 120 characters.');
  }

  const password = await promptPasswordPair();
  if (password === null) {
    console.log('Admin creation cancelled.');
    process.exitCode = 1;
  } else {
    const database = openConfiguredDatabase({ readonly: false });
    try {
      if (database.prepare('SELECT id FROM admin_users WHERE email = ?').get(email)) {
        throw new Error('An admin with that email already exists.');
      }

      const salt = randomBytes(16).toString('hex');
      const passwordHash = scryptSync(password, salt, 64).toString('hex');
      database.prepare(`
        INSERT INTO admin_users (email, display_name, password_hash)
        VALUES (?, ?, ?)
      `).run(email, displayName, `${salt}:${passwordHash}`);
      console.log(`Admin account created for ${email}.`);
    } finally {
      database.close();
    }
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
