import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { validateRequest } from '../src/middleware/validate-request.js';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'kade-foundation-test-'));
process.env.DATABASE_PATH = path.join(temporaryDirectory, 'portfolio.sqlite');
process.env.STORAGE_DIR = path.join(temporaryDirectory, 'storage');
process.env.ADMIN_EMAIL = '';
process.env.ADMIN_PASSWORD = '';
process.env.ADMIN_DISPLAY_NAME = '';
process.env.ADMIN_EMAIL_2 = '';
process.env.ADMIN_PASSWORD_2 = '';
process.env.ADMIN_DISPLAY_NAME_2 = '';
process.env.FRONTEND_URL = 'https://portfolio.example';
process.env.NODE_ENV = 'test';

const [{ default: app }, { default: database }, { runMigrations }] = await Promise.all([
  import('../app.js'),
  import('../src/database/database.js'),
  import('../src/database/migrations.js')
]);
const server = app.listen(0);
await new Promise((resolve) => server.once('listening', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  database.close();
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

test('platform account migration is applied and safe to rerun', () => {
  runMigrations(database);
  const migration = database.prepare('SELECT version, name FROM schema_migrations').get();
  assert.deepEqual(migration, { version: 1, name: '001_platform_accounts.sql' });
  assert.ok(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'users'").get());
  assert.equal(database.pragma('foreign_keys', { simple: true }), 1);
  assert.equal(database.pragma('journal_mode', { simple: true }).toLowerCase(), 'wal');
});

test('Zod request validation returns field issues and exposes parsed data', () => {
  const schema = z.object({
    body: z.object({ email: z.email() }),
    params: z.object({}),
    query: z.object({})
  });
  let statusCode;
  let responseBody;
  let nextCalled = false;
  const response = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(body) {
      responseBody = body;
      return this;
    }
  };
  const middleware = validateRequest(schema);

  middleware({ body: { email: 'invalid' }, params: {}, query: {} }, response, () => {
    nextCalled = true;
  });
  assert.equal(statusCode, 400);
  assert.equal(responseBody.error, 'Request validation failed.');
  assert.equal(responseBody.issues[0].path, 'body.email');
  assert.equal(nextCalled, false);

  const validRequest = { body: { email: 'owner@example.com' }, params: {}, query: {} };
  middleware(validRequest, response, () => {
    nextCalled = true;
  });
  assert.deepEqual(validRequest.validated, {
    body: { email: 'owner@example.com' },
    params: {},
    query: {}
  });
  assert.equal(nextCalled, true);
});

test('API sets security headers and allows configured frontend origins', async () => {
  const response = await fetch(`${baseUrl}/api/health`, {
    headers: { Origin: 'https://portfolio.example' }
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://portfolio.example');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('cross-origin-resource-policy'), 'cross-origin');
});

test('API rejects unconfigured origins', async () => {
  const response = await fetch(`${baseUrl}/api/health`, {
    headers: { Origin: 'https://untrusted.example' }
  });
  assert.equal(response.status, 403);
  assert.equal(response.headers.get('access-control-allow-origin'), null);
});
