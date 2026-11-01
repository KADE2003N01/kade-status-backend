import { openConfiguredDatabase } from './database.js';
import { promptText } from './prompts.js';

try {
  const email = (await promptText('Admin email to edit: ')).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('Enter a valid admin email address.');
  }

  const database = openConfiguredDatabase({ readonly: false });
  try {
    const admin = database.prepare(`SELECT id, display_name AS displayName, phone
      FROM admin_users WHERE email = ?`).get(email);
    if (!admin) throw new Error('No admin account with that email exists in this database.');

    console.log('Press Enter to keep a value. Enter - as the phone to clear it.');
    const displayNameInput = (await promptText(`Display name [${admin.displayName}]: `)).trim();
    const phoneInput = (await promptText(`Phone [${admin.phone || 'not set'}]: `)).trim();
    const displayName = displayNameInput || admin.displayName;
    const phone = phoneInput === '-' ? null : phoneInput || admin.phone;

    if (displayName.length < 2 || displayName.length > 120) {
      throw new Error('Display name must be 2 to 120 characters.');
    }
    if (phone && phone.length > 40) throw new Error('Phone must be no longer than 40 characters.');
    if (displayName === admin.displayName && phone === admin.phone) {
      console.log('No changes made.');
    } else {
      database.prepare('UPDATE admin_users SET display_name = ?, phone = ? WHERE id = ?')
        .run(displayName, phone || null, admin.id);
      console.log(`Admin profile updated (ID ${admin.id}). Its role and password were left unchanged.`);
    }
  } finally {
    database.close();
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
