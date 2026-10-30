import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { after, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'kade-platform-portfolios-'));
process.env.DATABASE_PATH = path.join(temporaryDirectory, 'portfolio.sqlite');
process.env.STORAGE_DIR = path.join(temporaryDirectory, 'storage');
process.env.NODE_ENV = 'test';
process.env.FRONTEND_URL = 'http://localhost:5173';
process.env.ADMIN_EMAIL = '';
process.env.ADMIN_PASSWORD = '';
process.env.ADMIN_DISPLAY_NAME = '';
process.env.ADMIN_EMAIL_2 = '';
process.env.ADMIN_PASSWORD_2 = '';
process.env.ADMIN_DISPLAY_NAME_2 = '';
process.env.SUPER_ADMIN_EMAIL = '';
process.env.SUPER_ADMIN_PASSWORD = '';
process.env.SUPER_ADMIN_DISPLAY_NAME = '';
process.env.EMAIL_USER = '';
process.env.EMAIL_PASSWORD = '';
process.env.MASTER_KEY = 'a'.repeat(64);
process.env.OTP_HMAC_SECRET = 'otp-secret-used-only-for-automated-tests-123';
process.env.SESSION_SECRET = 'session-secret-used-only-for-automated-tests-123';

const [{ default: app }, { default: database }] = await Promise.all([
  import('../app.js'),
  import('../src/database/database.js')
]);
const { hashRecruiterCode, hashRecruiterEmail, hashRecruiterSession } = await import('../src/services/platform-privacy.js');
const users = ['portfolio-owner-a@example.com', 'portfolio-owner-b@example.com'].map((email) => (
  database.prepare(`
    INSERT INTO users (email, display_name, password_hash, status, email_verified_at)
    VALUES (?, ?, 'test-hash', 'active', CURRENT_TIMESTAMP)
  `).run(email, email.split('@')[0]).lastInsertRowid
));
const cookies = users.map((userId) => {
  const token = randomBytes(32).toString('hex');
  database.prepare(`
    INSERT INTO sessions (token_hash, user_id, expires_at, created_at)
    VALUES (?, ?, ?, ?)
  `).run(createHash('sha256').update(token).digest('hex'), userId, Date.now() + 60_000, Date.now());
  return `kade_platform_session=${token}`;
});
const server = app.listen(0);
await new Promise((resolve) => server.once('listening', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const headers = { Origin: 'http://localhost:5173', 'Content-Type': 'application/json' };

async function request(pathname, { method = 'GET', body, cookie } = {}) {
  return fetch(`${baseUrl}/api${pathname}`, {
    method,
    headers: {
      ...headers,
      ...(cookie ? { Cookie: cookie } : {})
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
}

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  database.close();
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

test('portfolio routes require a verified platform account', async () => {
  const response = await request('/portfolios');
  assert.equal(response.status, 401);
});

test('owners can create, edit, publish, and read only their own portfolios', async () => {
  const created = await request('/portfolios', {
    method: 'POST',
    cookie: cookies[0],
    body: { slug: 'owner-a-portfolio', title: 'Owner A' }
  });
  assert.equal(created.status, 201);
  const { portfolio } = await created.json();
  assert.equal(portfolio.status, 'draft');
  assert.equal(portfolio.sections[0].data.title, 'Owner A');

  const crossOwnerRead = await request(`/portfolios/${portfolio.id}`, { cookie: cookies[1] });
  assert.equal(crossOwnerRead.status, 404);
  const crossOwnerEdit = await request(`/portfolios/${portfolio.id}`, {
    method: 'PUT',
    cookie: cookies[1],
    body: { title: 'Changed by another user' }
  });
  assert.equal(crossOwnerEdit.status, 404);

  const saved = await request(`/portfolios/${portfolio.id}/sections`, {
    method: 'PUT',
    cookie: cookies[0],
    body: {
      sections: [
        { type: 'hero', sortOrder: 0, data: { title: 'Owner A updated' } },
        { type: 'about', sortOrder: 1, data: { description: 'Public summary' } },
        { type: 'skills', sortOrder: 2, isPrivate: true, data: { items: ['private skill'] } }
      ]
    }
  });
  assert.equal(saved.status, 200);

  const draftRequest = await request('/public/owner-a-portfolio');
  assert.equal(draftRequest.status, 404);
  const published = await request(`/portfolios/${portfolio.id}/publish`, {
    method: 'PUT',
    cookie: cookies[0],
    body: {}
  });
  assert.equal(published.status, 200);

  const publicResponse = await request('/public/owner-a-portfolio');
  assert.equal(publicResponse.status, 200);
  const publicPortfolio = (await publicResponse.json()).portfolio;
  assert.deepEqual(publicPortfolio.sections.map(({ type }) => type), ['hero', 'about']);
  assert.equal(JSON.stringify(publicPortfolio).includes('private skill'), false);
  assert.equal('ownerUserId' in publicPortfolio, false);

  const privateResponse = await request('/public/owner-a-portfolio/full');
  assert.equal(privateResponse.status, 403);
});

test('portfolio content rejects unsafe links and reserved slugs', async () => {
  const created = await request('/portfolios', {
    method: 'POST',
    cookie: cookies[0],
    body: { slug: 'owner-a-portfolio-2', title: 'Owner A' }
  });
  const { portfolio } = await created.json();
  const unsafe = await request(`/portfolios/${portfolio.id}/sections`, {
    method: 'PUT',
    cookie: cookies[0],
    body: {
      sections: [{ type: 'contact', data: { websiteUrl: 'javascript:alert(1)' } }]
    }
  });
  assert.equal(unsafe.status, 400);

  const reserved = await request('/portfolios', {
    method: 'POST',
    cookie: cookies[0],
    body: { slug: 'admin', title: 'Reserved' }
  });
  assert.equal(reserved.status, 400);
});

test('recruiter OTP unlocks private sections, while contact details remain encrypted and owner-scoped', async () => {
  const created = await request('/portfolios', {
    method: 'POST',
    cookie: cookies[0],
    body: { slug: 'private-portfolio', title: 'Private Portfolio' }
  });
  const { portfolio } = await created.json();
  await request(`/portfolios/${portfolio.id}/sections`, {
    method: 'PUT',
    cookie: cookies[0],
    body: {
      sections: [
        { type: 'hero', data: { title: 'Private Portfolio' } },
        { type: 'about', isPrivate: true, data: { description: 'Private details' } }
      ]
    }
  });
  await request(`/portfolios/${portfolio.id}/publish`, {
    method: 'PUT',
    cookie: cookies[0],
    body: {}
  });

  const recruiterEmail = 'recruiter@example.com';
  const emailHash = hashRecruiterEmail(recruiterEmail);
  const code = '123456';
  database.prepare(`
    INSERT INTO recruiter_otps (
      portfolio_id, email_hash, code_hash, expires_at, attempts, requests,
      request_window_started_at, created_at
    ) VALUES (?, ?, ?, ?, 0, 1, ?, ?)
  `).run(portfolio.id, emailHash, hashRecruiterCode(portfolio.id, emailHash, code).toString('hex'), Date.now() + 60_000, Date.now(), Date.now());

  const verified = await request('/public/private-portfolio/recruiter/verify-otp', {
    method: 'POST',
    body: { email: recruiterEmail, code }
  });
  assert.equal(verified.status, 200);
  const recruiterCookie = verified.headers.get('set-cookie').split(';', 1)[0];
  const privatePage = await request('/public/private-portfolio/full', { cookie: recruiterCookie });
  assert.equal(privatePage.status, 200);
  assert.equal(JSON.stringify((await privatePage.json()).portfolio).includes('Private details'), true);

  const submitted = await request('/public/private-portfolio/recruiter/contact', {
    method: 'POST',
    cookie: recruiterCookie,
    body: {
      name: 'Jane Recruiter',
      email: recruiterEmail,
      position: 'Hiring Manager',
      phone: '+250788123456',
      reason: 'Discuss a role',
      consent: false
    }
  });
  assert.equal(submitted.status, 400);
  const consented = await request('/public/private-portfolio/recruiter/contact', {
    method: 'POST',
    cookie: recruiterCookie,
    body: {
      name: 'Jane Recruiter',
      email: recruiterEmail,
      position: 'Hiring Manager',
      phone: '+250788123456',
      reason: 'Discuss a role',
      consent: true
    }
  });
  assert.equal(consented.status, 200);
  const stored = database.prepare('SELECT * FROM recruiter_contacts WHERE portfolio_id = ?').get(portfolio.id);
  assert.equal(JSON.stringify(stored).includes('Jane Recruiter'), false);
  assert.equal(JSON.stringify(stored).includes(recruiterEmail), false);
  assert.ok(stored.consent_at);

  const ownerLeads = await request(`/portfolios/${portfolio.id}/leads`, { cookie: cookies[0] });
  assert.equal(ownerLeads.status, 200);
  assert.equal((await ownerLeads.json()).leads[0].name, 'Jane Recruiter');
  const otherOwnerLeads = await request(`/portfolios/${portfolio.id}/leads`, { cookie: cookies[1] });
  assert.equal(otherOwnerLeads.status, 404);

  const superAdminId = database.prepare(`
    INSERT INTO users (email, display_name, password_hash, role, status, email_verified_at)
    VALUES ('platform-admin@example.com', 'Platform Admin', 'test-hash', 'super_admin', 'active', CURRENT_TIMESTAMP)
  `).run().lastInsertRowid;
  const adminToken = randomBytes(32).toString('hex');
  database.prepare(`
    INSERT INTO sessions (token_hash, user_id, expires_at, created_at)
    VALUES (?, ?, ?, ?)
  `).run(createHash('sha256').update(adminToken).digest('hex'), superAdminId, Date.now() + 60_000, Date.now());
  const adminLeads = await request(`/portfolios/${portfolio.id}/leads`, {
    cookie: `kade_platform_session=${adminToken}`
  });
  assert.equal(adminLeads.status, 403);
});

test('invalid recruiter codes lock after five attempts and OTP delivery requires mail configuration', async () => {
  const created = await request('/portfolios', {
    method: 'POST',
    cookie: cookies[0],
    body: { slug: 'otp-lock-portfolio', title: 'OTP Lock' }
  });
  const { portfolio } = await created.json();
  await request(`/portfolios/${portfolio.id}/publish`, { method: 'PUT', cookie: cookies[0], body: {} });

  const email = 'locked@example.com';
  const emailHash = hashRecruiterEmail(email);
  database.prepare(`
    INSERT INTO recruiter_otps (
      portfolio_id, email_hash, code_hash, expires_at, attempts, requests,
      request_window_started_at, created_at
    ) VALUES (?, ?, ?, ?, 0, 1, ?, ?)
  `).run(portfolio.id, emailHash, hashRecruiterCode(portfolio.id, emailHash, '123456').toString('hex'), Date.now() + 60_000, Date.now(), Date.now());

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await request('/public/otp-lock-portfolio/recruiter/verify-otp', {
      method: 'POST',
      body: { email, code: '000000' }
    });
    assert.equal(response.status, 400);
  }
  const locked = await request('/public/otp-lock-portfolio/recruiter/verify-otp', {
    method: 'POST',
    body: { email, code: '000000' }
  });
  assert.equal(locked.status, 429);

  const noMailer = await request('/public/otp-lock-portfolio/recruiter/request-otp', {
    method: 'POST',
    body: { email: 'another@example.com' }
  });
  assert.equal(noMailer.status, 503);
});