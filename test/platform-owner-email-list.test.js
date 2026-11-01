import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { test } from 'node:test';

const backendDirectory = fileURLToPath(new URL('../', import.meta.url));

function runDatabaseBootstrap(databasePath, variables = {}) {
  const result = spawnSync(process.execPath, [
    '--input-type=module',
    '-e',
    "const { default: database } = await import('./src/database/database.js'); database.close();"
  ], {
    cwd: backendDirectory,
    env: {
      ...process.env,
      DATABASE_PATH: databasePath,
      STORAGE_DIR: path.dirname(databasePath),
      NODE_ENV: 'test',
      ADMIN_EMAIL: '',
      ADMIN_PASSWORD: '',
      ADMIN_DISPLAY_NAME: '',
      ADMIN_PHONE: '',
      ADMIN_EMAIL_2: '',
      ADMIN_PASSWORD_2: '',
      ADMIN_DISPLAY_NAME_2: '',
      ADMIN_PHONE_2: '',
      PLATFORM_OWNER_EMAIL: '',
      PLATFORM_OWNER_EMAILS: '',
      SUPER_ADMIN_EMAIL: '',
      SUPER_ADMIN_PASSWORD: '',
      SUPER_ADMIN_DISPLAY_NAME: '',
      ...variables
    },
    encoding: 'utf8',
    timeout: 30000
  });

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
}

test('platform-owner email list promotes existing accounts and skips missing accounts', () => {
  const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'kade-platform-owner-list-'));
  const databasePath = path.join(temporaryDirectory, 'portfolio.sqlite');
  const firstEmail = 'first-owner@example.test';
  const secondEmail = 'second-owner@example.test';

  try {
    runDatabaseBootstrap(databasePath, {
      ADMIN_EMAIL: firstEmail,
      ADMIN_PASSWORD: 'first-test-password',
      ADMIN_DISPLAY_NAME: 'First Admin',
      ADMIN_EMAIL_2: secondEmail,
      ADMIN_PASSWORD_2: 'second-test-password',
      ADMIN_DISPLAY_NAME_2: 'Second Admin'
    });

    const database = new Database(databasePath);
    const originalAdmins = database.prepare(
      'SELECT id, email, password_hash FROM admin_users ORDER BY email'
    ).all();
    const insertSession = database.prepare(`
      INSERT INTO admin_sessions (token_hash, user_id, expires_at, created_at)
      VALUES (?, ?, ?, ?)
    `);
    for (const [index, admin] of originalAdmins.entries()) {
      insertSession.run(`session-${index}`, admin.id, Date.now() + 60_000, Date.now());
    }
    database.close();

    runDatabaseBootstrap(databasePath, {
      PLATFORM_OWNER_EMAILS: `${firstEmail}, second-owner@example.test, missing-owner@example.test`
    });

    const resultDatabase = new Database(databasePath, { readonly: true });
    try {
      const promotedAdmins = resultDatabase.prepare(`
        SELECT id, email, password_hash, role, status, roles_json
        FROM admin_users ORDER BY email
      `).all();
      assert.equal(promotedAdmins.length, 2);
      for (let index = 0; index < promotedAdmins.length; index += 1) {
        const admin = promotedAdmins[index];
        assert.equal(admin.role, 'platform_owner');
        assert.equal(admin.status, 'active');
        assert.ok(JSON.parse(admin.roles_json).includes('platform_owner'));
        assert.equal(admin.password_hash, originalAdmins[index].password_hash);
      }
      assert.equal(resultDatabase.prepare('SELECT COUNT(*) AS count FROM admin_sessions').get().count, 0);
    } finally {
      resultDatabase.close();
    }
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});
