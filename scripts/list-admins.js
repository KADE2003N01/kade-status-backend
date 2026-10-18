import { openConfiguredDatabase } from './database.js';

const database = openConfiguredDatabase();
try {
  const admins = database.prepare(`
    SELECT id, email, display_name, created_at
    FROM admin_users
    ORDER BY id
  `).all();
  if (admins.length) console.table(admins);
  else console.log('No admin accounts are stored in this database.');
} finally {
  database.close();
}
