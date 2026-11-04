// One-off QA for the platform-owner customer routes over the live HTTP server.
import { createHash, randomBytes, scryptSync } from 'node:crypto';
import database from '../src/database/database.js';

const baseUrl = process.argv[2] || 'http://127.0.0.1:5000';
const results = [];
function record(label, ok, detail = '') {
  results.push({ label, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
}
async function api(path, { method = 'GET', body, cookie } = {}) {
  const response = await fetch(`${baseUrl}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:5173', ...(cookie ? { Cookie: cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
}

// Sign in as the seeded owner to prove the real auth path works.
const owner = database.prepare("SELECT id, email FROM admin_users WHERE email = 'qa-owner@foliospace.test'").get();
const login = await fetch(`${baseUrl}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:5173' },
  body: JSON.stringify({ email: owner.email, password: 'qa-owner-password-123' })
});
record('owner can sign in via /auth/login', login.status === 200, `status ${login.status}`);
const setCookie = login.headers.get('set-cookie') || '';
const cookie = setCookie.split(';', 1)[0];
record('login set a session cookie', cookie.includes('='));

const customerEmail = `customer-qa-${Date.now()}@example.com`;
const customerId = database.prepare(`
  INSERT INTO users (email, display_name, password_hash, status, email_verified_at)
  VALUES (?, 'QA Customer', 'not-a-login', 'active', CURRENT_TIMESTAMP)
`).run(customerEmail).lastInsertRowid;

try {
  const unauth = await api('/platform-owner/customers');
  record('customers requires owner auth', unauth.status === 401 || unauth.status === 403, `status ${unauth.status}`);

  const list = await api('/platform-owner/customers', { cookie });
  record('GET /customers lists accounts', list.status === 200 && Array.isArray(list.json.customers), `status ${list.status}`);
  record('customers include the QA customer', list.json.customers?.some((row) => row.id === customerId));
  record('customers include portfolioCount + plan', list.json.customers?.every((row) => typeof row.portfolioCount === 'number' && 'planId' in row));
  record('planCounts present', typeof list.json.planCounts === 'object');

  const searched = await api('/platform-owner/customers?search=QA%20Customer', { cookie });
  record('search finds the QA customer', searched.json.customers?.length === 1);

  const suspend = await api(`/platform-owner/customers/${customerId}/status`, { method: 'PATCH', cookie, body: { status: 'suspended' } });
  record('suspend works', suspend.status === 200, suspend.json.message || suspend.json.error);
  record('status persisted as suspended', database.prepare('SELECT status FROM users WHERE id = ?').get(customerId).status === 'suspended');

  const activate = await api(`/platform-owner/customers/${customerId}/status`, { method: 'PATCH', cookie, body: { status: 'active' } });
  record('activate works', activate.status === 200);

  const badPlan = await api(`/platform-owner/customers/${customerId}/plan`, { method: 'PATCH', cookie, body: { planId: 'deluxe' } });
  record('invalid plan rejected', badPlan.status === 400);

  const setPlan = await api(`/platform-owner/customers/${customerId}/plan`, { method: 'PATCH', cookie, body: { planId: 'professional' } });
  record('set plan works', setPlan.status === 200, setPlan.json.message || setPlan.json.error);
  const plan = database.prepare('SELECT plan_id, state FROM subscriptions WHERE user_id = ?').get(customerId);
  record('plan persisted as professional/active', plan?.plan_id === 'professional' && plan?.state === 'active', JSON.stringify(plan));
  record('plan shows in customer list', (await api('/platform-owner/customers', { cookie })).json.customers?.find((row) => row.id === customerId)?.planId === 'professional');

  const deleted = await api(`/platform-owner/customers/${customerId}`, { method: 'DELETE', cookie });
  record('delete works', deleted.status === 200, deleted.json.message || deleted.json.error);
  record('customer removed from database', !database.prepare('SELECT id FROM users WHERE id = ?').get(customerId));
  record('subscription cascaded away', !database.prepare('SELECT user_id FROM subscriptions WHERE user_id = ?').get(customerId));
  record('deletion audited', Boolean(database.prepare("SELECT id FROM platform_admin_audit WHERE action = 'customer_deleted' ORDER BY id DESC LIMIT 1").get()));
} finally {
  database.prepare('DELETE FROM users WHERE id = ?').run(customerId);
  database.prepare("DELETE FROM platform_admin_audit WHERE action LIKE 'customer_%'").run();
  console.log('\nQA data cleaned up.');
}

const failed = results.filter((item) => !item.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
process.exit(failed.length ? 1 : 0);
