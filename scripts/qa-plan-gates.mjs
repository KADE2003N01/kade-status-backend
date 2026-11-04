// QA harness for the FolioSpace plan gates (SUBSCRIPTION_PLAN.md).
// Creates a throwaway user, walks it through free -> standard -> professional,
// and exercises every server-side gate (Pattern C) over HTTP.
//
// Usage:  node scripts/qa-plan-gates.mjs [baseUrl]
//         baseUrl defaults to http://127.0.0.1:5000
import { createHash, randomBytes } from 'node:crypto';
import process from 'node:process';
import database from '../src/database/database.js';

const baseUrl = process.argv[2] || 'http://127.0.0.1:5000';
const email = 'plan-qa@example.com';
const results = [];

function record(label, ok, detail = '') {
  results.push({ label, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
}

async function api(path, { method = 'GET', body, cookie } = {}) {
  const response = await fetch(`${baseUrl}/api${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Origin: 'http://localhost:5173',
      ...(cookie ? { Cookie: cookie } : {})
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const json = await response.json().catch(() => ({}));
  return { status: response.status, json };
}

function sessionCookieFor(userId) {
  const token = randomBytes(32).toString('hex');
  database.prepare(`
    INSERT INTO sessions (token_hash, user_id, expires_at, created_at)
    VALUES (?, ?, ?, ?)
  `).run(createHash('sha256').update(token).digest('hex'), userId, Date.now() + 60_000, Date.now());
  return `kade_platform_session=${token}`;
}

function setPlan(userId, planId) {
  database.prepare(`
    INSERT INTO subscriptions (user_id, plan_id, state, period_end, updated_at)
    VALUES (?, ?, ?, datetime('now', '+6 months'), CURRENT_TIMESTAMP)
    ON CONFLICT(user_id) DO UPDATE SET
      plan_id = excluded.plan_id,
      state = excluded.state,
      period_end = excluded.period_end,
      updated_at = CURRENT_TIMESTAMP
  `).run(userId, planId, planId === 'free' ? 'free' : 'active');
}

const existing = database.prepare('SELECT id FROM users WHERE email = ?').get(email);
const userId = existing?.id ?? database.prepare(`
  INSERT INTO users (email, display_name, password_hash, status, email_verified_at)
  VALUES (?, 'Plan QA', 'qa-not-a-login', 'active', CURRENT_TIMESTAMP)
`).run(email).lastInsertRowid;

// Clean slate: remove any portfolios from earlier runs.
const oldIds = database.prepare('SELECT id FROM portfolios WHERE owner_user_id = ?').all(userId)
  .map(({ id }) => id);
for (const id of oldIds) database.prepare('DELETE FROM portfolios WHERE id = ?').run(id);

try {
  for (const planId of ['free', 'standard', 'professional']) {
    console.log(`\n=== Plan: ${planId} ===`);
    // Reset so each plan starts from zero owned spaces.
    for (const { id } of database.prepare('SELECT id FROM portfolios WHERE owner_user_id = ?').all(userId)) {
      database.prepare('DELETE FROM portfolios WHERE id = ?').run(id);
    }
    setPlan(userId, planId);
    const cookie = sessionCookieFor(userId);

    const me = await api('/platform-auth/me', { cookie });
    record(`${planId}: /me reports subscriptionPlan`, me.json.user?.subscriptionPlan === planId, `got ${me.json.user?.subscriptionPlan}`);

    const maxSpaces = planId === 'free' ? 1 : planId === 'standard' ? 3 : Infinity;
    let lastPortfolio = null;
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const created = await api('/portfolios', {
        method: 'POST',
        cookie,
        body: { slug: `plan-qa-${planId}-${attempt}`, title: `QA ${planId} ${attempt}` }
      });
      if (created.status === 201) {
        lastPortfolio = created.json.portfolio;
        record(`${planId}: space #${attempt} created`, attempt <= maxSpaces);
      } else if (created.status === 403) {
        record(`${planId}: space #${attempt} blocked at cap`, attempt > maxSpaces, created.json.error);
      } else {
        record(`${planId}: space #${attempt} unexpected`, false, `status ${created.status}`);
      }
    }

    if (!lastPortfolio) continue;

    const sectionChecks = [
      ['about', planId !== 'none', 200],
      ['projects', planId !== 'free', planId === 'free' ? 403 : 200],
      ['certificates', planId === 'professional', planId === 'professional' ? 200 : 403]
    ];
    for (const [type, , expected] of sectionChecks) {
      const saved = await api(`/portfolios/${lastPortfolio.id}/sections`, {
        method: 'PUT',
        cookie,
        body: { sections: [{ type, sortOrder: 5, data: { title: 'QA' } }] }
      });
      record(`${planId}: section "${type}" -> ${expected}`, saved.status === expected, `got ${saved.status}${saved.json.upgradeTo ? ` upgradeTo=${saved.json.upgradeTo}` : ''}`);
    }

    const privateSaved = await api(`/portfolios/${lastPortfolio.id}/sections`, {
      method: 'PUT',
      cookie,
      body: { sections: [{ type: 'about', sortOrder: 1, isPrivate: true, data: { description: 'qa' } }] }
    });
    record(
      `${planId}: private section -> ${planId === 'free' ? 403 : 200}`,
      privateSaved.status === (planId === 'free' ? 403 : 200),
      `got ${privateSaved.status}`
    );

    const published = await api(`/portfolios/${lastPortfolio.id}/publish`, { method: 'PUT', cookie, body: {} });
    record(`${planId}: publish works`, published.status === 200);

    const publicPage = await api(`/public/${lastPortfolio.slug}`);
    record(
      `${planId}: watermark=${planId === 'free'}`,
      publicPage.json.portfolio?.watermark === (planId === 'free'),
      `got ${publicPage.json.portfolio?.watermark}`
    );
  }
} finally {
  // Remove the QA user entirely (cascades to portfolios, sessions, subscription).
  database.prepare('DELETE FROM users WHERE id = ?').run(userId);
  console.log('\nQA user removed.');
}

const failed = results.filter((item) => !item.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
process.exit(failed.length ? 1 : 0);
