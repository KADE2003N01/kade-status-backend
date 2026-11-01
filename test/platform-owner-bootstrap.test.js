import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scryptSync } from 'node:crypto';
import Database from 'better-sqlite3';
import { test } from 'node:test';

const backendDirectory = fileURLToPath(new URL('../', import.meta.url));

function runDatabaseBootstrap(databasePath, variables = {}) {
  const childEnv = {
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
    PLATFORM_OWNER_PASSWORD: '',
    PLATFORM_OWNER_DISPLAY_NAME: '',
    PLATFORM_OWNER_PHONE: '',
    SUPER_ADMIN_EMAIL: '',
    SUPER_ADMIN_PASSWORD: '',
    SUPER_ADMIN_DISPLAY_NAME: '',
    ...variables
  };
  const result = spawnSync(process.execPath, [
    '--input-type=module',
    '-e',
    "const { default: database } = await import('./src/database/database.js'); database.close();"
  ], {
    cwd: backendDirectory,
    env: childEnv,
    encoding: 'utf8',
    timeout: 30000
  });

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
}

function getAdmin(databasePath, email) {
  const database = new Database(databasePath, { readonly: true });
  try {
    return database.prepare(`
      SELECT email, display_name, password_hash, role, status, roles_json
      FROM admin_users WHERE email = ?
    `).get(email);
  } finally {
    database.close();
  }
}

test('platform-owner environment bootstrap creates an admin-portal account with a valid password hash', () => {
  const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'kade-platform-owner-'));
  const databasePath = path.join(temporaryDirectory, 'portfolio.sqlite');
  const email = 'owner@example.test';
  const password = 'test-only-owner-password-123';

  try {
    runDatabaseBootstrap(databasePath, {
      PLATFORM_OWNER_EMAIL: email,
      PLATFORM_OWNER_PASSWORD: password,
      PLATFORM_OWNER_DISPLAY_NAME: 'Test Platform Owner'
    });

    const admin = getAdmin(databasePath, email);
    assert.equal(admin.email, email);
    assert.equal(admin.display_name, 'Test Platform Owner');
    assert.equal(admin.role, 'platform_owner');
    assert.equal(admin.status, 'active');
    assert.ok(JSON.parse(admin.roles_json).includes('platform_owner'));

    const [salt, passwordHash] = admin.password_hash.split(':');
    assert.equal(scryptSync(password, salt, 64).toString('hex'), passwordHash);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('platform-owner promotion preserves an existing admin password', () => {
  const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'kade-platform-owner-promotion-'));
  const databasePath = path.join(temporaryDirectory, 'portfolio.sqlite');
  const email = 'existing-admin@example.test';
  const password = 'existing-admin-test-password';

  try {
    runDatabaseBootstrap(databasePath, {
      ADMIN_EMAIL: email,
      ADMIN_PASSWORD: password,
      ADMIN_DISPLAY_NAME: 'Existing Admin'
    });
    const originalAdmin = getAdmin(databasePath, email);

    runDatabaseBootstrap(databasePath, { PLATFORM_OWNER_EMAIL: email });
    const promotedAdmin = getAdmin(databasePath, email);

    assert.equal(promotedAdmin.role, 'platform_owner');
    assert.ok(JSON.parse(promotedAdmin.roles_json).includes('platform_owner'));
    assert.equal(promotedAdmin.password_hash, originalAdmin.password_hash);
    assert.equal(promotedAdmin.display_name, originalAdmin.display_name);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});
