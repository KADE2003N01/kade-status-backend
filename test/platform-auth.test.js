import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { after, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import bcrypt from 'bcryptjs';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'kade-platform-auth-test-'));
process.env.DATABASE_PATH = path.join(temporaryDirectory, 'portfolio.sqlite');
process.env.STORAGE_DIR = path.join(temporaryDirectory, 'storage');
process.env.ADMIN_EMAIL = '';
process.env.ADMIN_PASSWORD = '';
process.env.ADMIN_DISPLAY_NAME = '';
process.env.ADMIN_EMAIL_2 = '';
process.env.ADMIN_PASSWORD_2 = '';
process.env.ADMIN_DISPLAY_NAME_2 = '';
process.env.SUPER_ADMIN_EMAIL = '';
process.env.SUPER_ADMIN_PASSWORD = '';
process.env.SUPER_ADMIN_DISPLAY_NAME = '';
process.env.FRONTEND_URL = 'http://localhost:5173';
process.env.NODE_ENV = 'test';
process.env.EMAIL_USER = '';
process.env.EMAIL_PASSWORD = '';

const [{ default: app }, { default: database }] = await Promise.all([
  import('../app.js'),
  import('../src/database/database.js')
]);
const server = app.listen(0);
await new Promise((resolve) => server.once('listening', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const headers = {
  Origin: 'http://localhost:5173',
  'Content-Type': 'application/json'
};
const password = 'Correct-Horse-Battery-1';
let sessionCookie;

async function post(pathname, body, cookie) {
  return fetch(`${baseUrl}/api/platform-auth/${pathname}`, {
    method: 'POST',
    headers: { ...headers, ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body)
  });
}

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  database.close();
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

test('signup validates account input and reports missing email configuration', async () => {
  const invalid = await post('signup', {
    email: 'not-an-email',
    displayName: 'Test User',
    password
  });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error, 'Request validation failed.');

  const unavailable = await post('signup', {
    email: 'new-user@example.com',
    displayName: 'Test User',
    password
  });
  assert.equal(unavailable.status, 503);
  assert.equal(database.prepare('SELECT id FROM users WHERE email = ?').get('new-user@example.com'), undefined);
});

test('email verification, login, protected account access, and logout work', async () => {
  const passwordHash = await bcrypt.hash(password, 4);
  const userId = database.prepare(`
    INSERT INTO users (email, display_name, password_hash)
    VALUES (?, ?, ?)
  `).run('customer@example.com', 'Test Customer', passwordHash).lastInsertRowid;
  const token = randomBytes(32).toString('hex');
  const tokenHash = createHash('sha256').update(token).digest('hex');
  database.prepare(`
    INSERT INTO email_verifications (token_hash, user_id, expires_at, created_at)
    VALUES (?, ?, ?, ?)
  `).run(tokenHash, userId, Date.now() + 60_000, Date.now());

  const verified = await post('verify-email', { token });
  assert.equal(verified.status, 200);
  assert.equal(database.prepare('SELECT status FROM users WHERE id = ?').get(userId).status, 'active');
  assert.equal(database.prepare('SELECT token_hash FROM email_verifications WHERE user_id = ?').get(userId), undefined);

  const login = await post('login', { email: 'CUSTOMER@example.com', password });
  assert.equal(login.status, 200);
  sessionCookie = login.headers.get('set-cookie').split(';', 1)[0];
  assert.match(sessionCookie, /^kade_platform_session=/);

  const me = await fetch(`${baseUrl}/api/platform-auth/me`, {
    headers: { Origin: headers.Origin, Cookie: sessionCookie }
  });
  assert.equal(me.status, 200);
  assert.deepEqual((await me.json()).user, {
    id: userId,
    email: 'customer@example.com',
    displayName: 'Test Customer',
    role: 'customer'
  });

  const adminRoute = await fetch(`${baseUrl}/api/auth/admin-users`, {
    headers: { Origin: headers.Origin, Cookie: sessionCookie }
  });
  assert.equal(adminRoute.status, 403);

  const logout = await post('logout', {}, sessionCookie);
  assert.equal(logout.status, 200);
  assert.equal(database.prepare('SELECT token_hash FROM sessions WHERE user_id = ?').get(userId), undefined);
  const expiredSession = await fetch(`${baseUrl}/api/platform-auth/me`, {
    headers: { Origin: headers.Origin, Cookie: sessionCookie }
  });
  assert.equal(expiredSession.status, 401);
});

test('password reset is one-use and revokes existing sessions', async () => {
  const user = database.prepare('SELECT id FROM users WHERE email = ?').get('customer@example.com');
  const token = randomBytes(32).toString('hex');
  database.prepare(`
    INSERT INTO password_resets (token_hash, user_id, expires_at, created_at)
    VALUES (?, ?, ?, ?)
  `).run(createHash('sha256').update(token).digest('hex'), user.id, Date.now() + 60_000, Date.now());
  database.prepare(`
    INSERT INTO sessions (token_hash, user_id, expires_at, created_at)
    VALUES (?, ?, ?, ?)
  `).run('existing-session-hash', user.id, Date.now() + 60_000, Date.now());

  const reset = await post('reset-password', {
    token,
    password: 'New-Correct-Horse-Battery-2'
  });
  assert.equal(reset.status, 200);
  assert.equal(database.prepare('SELECT token_hash FROM sessions WHERE user_id = ?').get(user.id), undefined);
  assert.equal(database.prepare('SELECT token_hash FROM password_resets WHERE user_id = ?').get(user.id), undefined);

  const oldPassword = await post('login', { email: 'customer@example.com', password });
  assert.equal(oldPassword.status, 401);
  const newPassword = await post('login', {
    email: 'customer@example.com',
    password: 'New-Correct-Horse-Battery-2'
  });
  assert.equal(newPassword.status, 200);
});

test('forgot-password does not falsely succeed when email delivery is unavailable', async () => {
  const response = await post('forgot-password', { email: 'customer@example.com' });
  assert.equal(response.status, 503);
});
