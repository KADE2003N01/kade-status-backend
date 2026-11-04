// Seed demo accounts for checking the FolioSpace plan gates in the browser.
// Creates (or resets) three verified customers — one per plan — and a platform
// owner. Safe to run repeatedly; existing accounts get their password and plan
// reset to the values below.
//
// Usage: node scripts/seed-demo-accounts.mjs
import bcrypt from 'bcryptjs';
import { randomBytes, scryptSync } from 'node:crypto';
import database from '../src/database/database.js';

const accounts = [
  { email: 'free@demo.foliospace', name: 'Free Plan Demo', plan: 'free', password: 'FreeDemo#2026' },
  { email: 'standard@demo.foliospace', name: 'Standard Plan Demo', plan: 'standard', password: 'StandardDemo#2026' },
  { email: 'professional@demo.foliospace', name: 'Professional Plan Demo', plan: 'professional', password: 'ProDemo#2026' }
];

function setPlan(userId, planId) {
  database.prepare(`
    INSERT INTO subscriptions (user_id, plan_id, state, period_end, updated_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id) DO UPDATE SET
      plan_id = excluded.plan_id,
      state = excluded.state,
      period_end = excluded.period_end,
      updated_at = CURRENT_TIMESTAMP
  `).run(userId, planId, planId === 'free' ? 'free' : 'active',
    planId === 'free' ? null : new Date(Date.now() + 182 * 24 * 60 * 60 * 1000).toISOString());
}

for (const account of accounts) {
  const passwordHash = await bcrypt.hash(account.password, 12);
  const existing = database.prepare('SELECT id FROM users WHERE email = ?').get(account.email);
  let userId;
  if (existing) {
    database.prepare(`
      UPDATE users SET display_name = ?, password_hash = ?, status = 'active',
        email_verified_at = COALESCE(email_verified_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(account.name, passwordHash, existing.id);
    userId = existing.id;
    console.log(`reset  ${account.email}`);
  } else {
    userId = database.prepare(`
      INSERT INTO users (email, display_name, password_hash, status, email_verified_at)
      VALUES (?, ?, ?, 'active', CURRENT_TIMESTAMP)
    `).run(account.email, account.name, passwordHash).lastInsertRowid;
    console.log(`created ${account.email}`);
  }
  setPlan(userId, account.plan);
  // Clear stale sessions so a fresh sign-in is guaranteed to work.
  database.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

// Platform owner (admin_users — signs in at the platform-owner console).
const ownerEmail = 'owner@demo.foliospace';
const ownerPassword = 'OwnerDemo#2026';
const salt = randomBytes(16).toString('hex');
const ownerHash = `${salt}:${scryptSync(ownerPassword, salt, 64).toString('hex')}`;
const existingOwner = database.prepare('SELECT id FROM admin_users WHERE email = ?').get(ownerEmail);
if (existingOwner) {
  database.prepare("UPDATE admin_users SET password_hash = ?, status = 'active' WHERE id = ?")
    .run(ownerHash, existingOwner.id);
  database.prepare('DELETE FROM admin_sessions WHERE user_id = ?').run(existingOwner.id);
  console.log(`reset  ${ownerEmail}`);
} else {
  database.prepare(`
    INSERT INTO admin_users (email, display_name, password_hash, role, roles_json, status)
    VALUES (?, 'Platform Owner Demo', ?, 'platform_owner', '["platform_owner"]', 'active')
  `).run(ownerEmail, ownerHash);
  console.log(`created ${ownerEmail}`);
}

console.log('\nAll demo accounts ready.');
