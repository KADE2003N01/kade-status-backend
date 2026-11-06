import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { unlink, writeFile } from 'node:fs/promises';
import bcrypt from 'bcryptjs';
import express from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import database from '../../database/platform-database.js';
import { getMailFromAddress, getTransporter } from '../../config/mailer.js';
import { getUserPlanId } from '../../services/space-plan-limits.js';
import { getPlanAccountPages } from '../../services/account-page-access.js';
import { validateRequest } from '../../middleware/validate-request.js';
import { resolveWritablePath } from '../../config/storage.js';
import {
  getPlatformSessionCookieOptions,
  getPlatformSessionUser,
  hashPlatformToken,
  PLATFORM_SESSION_COOKIE,
  PLATFORM_SESSION_DURATION_MS,
  requirePlatformUser
} from '../../verification/platform-auth.js';

const router = express.Router();
const emailSchema = z.string().trim().toLowerCase().email().max(254);
const passwordSchema = z.string().min(12).max(64)
  .refine((password) => Buffer.byteLength(password, 'utf8') <= 72, 'Password must be at most 72 bytes.');
const emptyObject = z.object({});
const requestSchema = (body) => z.object({
  body,
  params: emptyObject,
  query: emptyObject
});
const signupSchema = requestSchema(z.object({
  email: emailSchema,
  displayName: z.string().trim().min(2).max(100),
  password: passwordSchema,
  templateId: z.enum(['free', 'standard', 'professional']).default('free'),
  currency: z.enum(['RWF', 'USD']).default('RWF')
}));
const loginSchema = requestSchema(z.object({
  email: emailSchema,
  password: z.string().min(1).max(1024)
}));
const tokenSchema = requestSchema(z.object({
  token: z.string().regex(/^[a-f\d]{64}$/i)
}));
const resetSchema = requestSchema(z.object({
  token: z.string().regex(/^[a-f\d]{64}$/i),
  password: passwordSchema
}));
const emailOnlySchema = requestSchema(z.object({ email: emailSchema }));
const profileSchema = requestSchema(z.object({
  displayName: z.string().trim().min(2).max(100),
  phone: z.string().trim().max(40).default(''),
  professionalRole: z.string().trim().max(120).default(''),
  location: z.string().trim().max(160).default(''),
  streetAddress: z.string().trim().max(200).default(''),
  city: z.string().trim().max(100).default(''),
  region: z.string().trim().max(100).default(''),
  postalCode: z.string().trim().max(30).default(''),
  country: z.string().trim().max(100).default(''),
  website: z.string().trim().max(240).refine((value) => !value || /^https?:\/\//i.test(value), 'Website must start with http:// or https://.').default(''),
  bio: z.string().trim().max(2000).default('')
}));
const passwordChangeSchema = requestSchema(z.object({ currentPassword: z.string().min(1).max(1024), password: passwordSchema }));
const MAX_PROFILE_PHOTO_SIZE = 5 * 1024 * 1024;
const profilePhotoTypes = {
  'image/jpeg': (buffer) => buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff,
  'image/png': (buffer) => buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
  'image/webp': (buffer) => buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP',
  'image/gif': (buffer) => buffer.subarray(0, 4).toString('ascii') === 'GIF8'
};
const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler: (req, res) => res.status(429).json({
    success: false,
    error: 'Too many account requests. Please try again later.'
  })
});

function createToken() {
  const token = randomBytes(32).toString('hex');
  return { token, tokenHash: hashPlatformToken(token) };
}

function createFrontendLink(page, token) {
  const frontendOrigin = process.env.FRONTEND_URL?.split(',')[0]?.trim();
  if (!frontendOrigin) {
    const error = new Error('FRONTEND_URL must be configured to send account links.');
    error.status = 503;
    throw error;
  }
  const link = new URL(page, `${frontendOrigin}/`);
  link.searchParams.set('token', token);
  return link.toString();
}

function requireMailer() {
  const transporter = getTransporter();
  if (!transporter) {
    const error = new Error('Account email is not configured. Contact the site administrator.');
    error.status = 503;
    throw error;
  }
  return transporter;
}

async function sendAccountEmail(transporter, email, subject, text) {
  await transporter.sendMail({
    from: getMailFromAddress(),
    to: email,
    subject,
    text
  });
}

function publicUser(user) {
  const profile = database.prepare(`SELECT phone, professional_role AS professionalRole, location, street_address AS streetAddress,
    city, region, postal_code AS postalCode, country, website, bio FROM users WHERE id = ?`).get(user.id) || {};
  const subscription = database.prepare(`
    SELECT plan_id AS planId, state AS state, period_end AS periodEnd
    FROM subscriptions WHERE user_id = ?
  `).get(user.id) || {};
  const subscriptionPlan = getUserPlanId(database, user.id);
  return {
    id: user.id,
    email: user.email,
    displayName: user.display_name,
    role: user.role,
    subscriptionPlan,
    accountPages: getPlanAccountPages(database, subscriptionPlan),
    subscriptionState: subscription.state || 'free',
    subscriptionEndsAt: subscription.periodEnd || null,
    ...profile
  };
}

function publicOnboarding(userId) {
  const onboarding = database.prepare(`
    SELECT selected_template_id AS templateId, currency, stage, payment_status AS paymentStatus
    FROM platform_onboarding WHERE user_id = ?
  `).get(userId);
  return onboarding || null;
}

router.post('/signup', authRateLimit, validateRequest(signupSchema), async (req, res, next) => {
  try {
    const { email, displayName, password, templateId, currency } = req.validated.body;
    const transporter = requireMailer();
    const existing = database.prepare('SELECT id, status FROM users WHERE email = ?').get(email);
    if (existing && existing.status !== 'pending_verification') {
      return res.status(409).json({ success: false, error: 'An account with this email already exists.' });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const userId = existing?.id ?? database.prepare(`
      INSERT INTO users (email, display_name, password_hash)
      VALUES (?, ?, ?)
    `).run(email, displayName, passwordHash).lastInsertRowid;
    const token = createToken();
    database.transaction(() => {
      if (existing) {
        database.prepare('UPDATE users SET display_name = ?, password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
          .run(displayName, passwordHash, userId);
      }
      const isFreePlan = templateId === 'free';
      // Payment is not connected yet: until a billing provider is wired up, every
      // new account is granted an active Professional subscription so signup is a
      // genuine bypass with full privileges instead of a stalled paid checkout.
      const grantedPlan = 'professional';
      database.prepare(`
        INSERT INTO platform_onboarding (user_id, selected_template_id, currency, stage, payment_status)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET
          selected_template_id = excluded.selected_template_id,
          currency = excluded.currency,
          stage = excluded.stage,
          payment_status = excluded.payment_status,
          updated_at = CURRENT_TIMESTAMP
      `).run(
        userId,
        templateId,
        currency,
        'space_setup',
        'not_required'
      );
      database.prepare(`
        INSERT INTO subscriptions (user_id, plan_id, state, updated_at)
        VALUES (?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(user_id) DO UPDATE SET
          plan_id = excluded.plan_id,
          state = excluded.state,
          updated_at = CURRENT_TIMESTAMP
      `).run(userId, grantedPlan, 'active');
      database.prepare('DELETE FROM email_verifications WHERE user_id = ?').run(userId);
      database.prepare(`
        INSERT INTO email_verifications (token_hash, user_id, expires_at, created_at)
        VALUES (?, ?, ?, ?)
      `).run(token.tokenHash, userId, Date.now() + 24 * 60 * 60 * 1000, Date.now());
    })();

    const link = createFrontendLink('platform-verify-email.html', token.token);
    await sendAccountEmail(
      transporter,
      email,
      'Verify your Digital Status account',
      `Hello ${displayName},\n\nVerify your email address to activate your account:\n${link}\n\nThis link expires in 24 hours. If you did not request this account, you can ignore this message.`
    );
    return res.status(201).json({
      success: true,
      message: 'Check your email for a verification link.',
      onboarding: publicOnboarding(userId)
    });
  } catch (error) {
    return next(error);
  }
});

router.post('/verify-email', authRateLimit, validateRequest(tokenSchema), (req, res) => {
  const { token } = req.validated.body;
  const verification = database.prepare(`
    SELECT user_id AS userId FROM email_verifications
    WHERE token_hash = ? AND expires_at > ?
  `).get(hashPlatformToken(token), Date.now());
  if (!verification) {
    return res.status(400).json({ success: false, error: 'This verification link is invalid or expired.' });
  }

  database.transaction(() => {
    database.prepare(`
      UPDATE users
      SET status = 'active', email_verified_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'pending_verification'
    `).run(verification.userId);
    database.prepare('DELETE FROM email_verifications WHERE user_id = ?').run(verification.userId);
  })();
  return res.json({ success: true, message: 'Email verified. You can now sign in.' });
});

router.post('/login', authRateLimit, validateRequest(loginSchema), async (req, res, next) => {
  try {
    const { email, password } = req.validated.body;
    const user = database.prepare(`
      SELECT id, email, display_name, password_hash, role, status, email_verified_at
      FROM users WHERE email = ?
    `).get(email);
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ success: false, error: 'Email or password is incorrect.' });
    }
    if (user.status === 'pending_verification' || !user.email_verified_at) {
      return res.status(403).json({ success: false, error: 'Verify your email before signing in.' });
    }
    if (user.status !== 'active') {
      return res.status(403).json({ success: false, error: 'This account is unavailable.' });
    }

    const token = randomBytes(32).toString('hex');
    const expiresAt = Date.now() + PLATFORM_SESSION_DURATION_MS;
    database.transaction(() => {
      database.prepare('DELETE FROM sessions WHERE user_id = ? AND expires_at <= ?').run(user.id, Date.now());
      database.prepare(`
        INSERT INTO sessions (token_hash, user_id, expires_at, created_at)
        VALUES (?, ?, ?, ?)
      `).run(hashPlatformToken(token), user.id, expiresAt, Date.now());
    })();
    res.cookie(PLATFORM_SESSION_COOKIE, token, getPlatformSessionCookieOptions());
    return res.json({ success: true, user: publicUser(user), onboarding: publicOnboarding(user.id) });
  } catch (error) {
    return next(error);
  }
});

router.post('/logout', (req, res) => {
  const user = getPlatformSessionUser(req);
  const token = req.cookies?.[PLATFORM_SESSION_COOKIE];
  if (token) database.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashPlatformToken(token));
  const { maxAge, ...cookieOptions } = getPlatformSessionCookieOptions();
  res.clearCookie(PLATFORM_SESSION_COOKIE, cookieOptions);
  return res.json({ success: true, userId: user?.id ?? null });
});

// Confirm a pending password change sent by email (public: link carries the token).
const confirmSchema = requestSchema(z.object({ token: z.string().regex(/^[a-f\d]{64}$/i) }));
router.post('/confirm-password-change', authRateLimit, validateRequest(confirmSchema), (req, res) => {
  const { token } = req.validated.body;
  const request = database.prepare(`
    SELECT request.id, request.user_id AS userId, request.expires_at AS expiresAt, request.used_at, users.email
    FROM customer_password_change_requests request
    JOIN users ON users.id = request.user_id
    WHERE request.token_hash = ?
  `).get(hashPlatformToken(token));
  if (!request) return res.status(400).json({ success: false, error: 'This confirmation link is not valid.' });
  if (request.used_at) return res.status(400).json({ success: false, error: 'This link has already been used.' });
  if (request.expires_at < Date.now()) {
    database.prepare('DELETE FROM customer_password_change_requests WHERE id = ?').run(request.id);
    return res.status(400).json({ success: false, error: 'This link has expired. Request a new password change.' });
  }
  // Apply the stored new password and clear the request in one transaction.
  const pending = database.prepare('SELECT new_password_hash FROM customer_password_change_requests WHERE id = ?').get(request.id);
  database.transaction(() => {
    database.prepare('UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(pending.new_password_hash, request.userId);
    database.prepare('UPDATE customer_password_change_requests SET used_at = CURRENT_TIMESTAMP WHERE id = ?').run(request.id);
    database.prepare('DELETE FROM sessions WHERE user_id = ?').run(request.userId);
  })();
  return res.json({ success: true, message: 'Your new password is active. Sign in with it now.' });
});

router.post('/forgot-password', authRateLimit, validateRequest(emailOnlySchema), async (req, res, next) => {
  try {
    const transporter = requireMailer();
    const { email } = req.validated.body;
    const user = database.prepare(`
      SELECT id, email, display_name FROM users
      WHERE email = ? AND status = 'active' AND email_verified_at IS NOT NULL
    `).get(email);

    if (user) {
      const token = createToken();
      database.transaction(() => {
        database.prepare('DELETE FROM password_resets WHERE user_id = ?').run(user.id);
        database.prepare(`
          INSERT INTO password_resets (token_hash, user_id, expires_at, created_at)
          VALUES (?, ?, ?, ?)
        `).run(token.tokenHash, user.id, Date.now() + 60 * 60 * 1000, Date.now());
      })();
      const link = createFrontendLink('platform-reset-password.html', token.token);
      await sendAccountEmail(
        transporter,
        user.email,
        'Reset your Digital Status password',
        `Hello ${user.display_name},\n\nUse this link to reset your password:\n${link}\n\nThis link expires in one hour. If you did not request a reset, you can ignore this message.`
      );
    }

    return res.json({
      success: true,
      message: 'If an active account uses that email, a password reset link has been sent.'
    });
  } catch (error) {
    return next(error);
  }
});

router.post('/reset-password', authRateLimit, validateRequest(resetSchema), async (req, res, next) => {
  try {
    const { token, password } = req.validated.body;
    const reset = database.prepare(`
      SELECT user_id AS userId FROM password_resets
      WHERE token_hash = ? AND expires_at > ?
    `).get(hashPlatformToken(token), Date.now());
    if (!reset) {
      return res.status(400).json({ success: false, error: 'This password reset link is invalid or expired.' });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    database.transaction(() => {
      database.prepare('UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run(passwordHash, reset.userId);
      database.prepare('DELETE FROM password_resets WHERE user_id = ?').run(reset.userId);
      database.prepare('DELETE FROM sessions WHERE user_id = ?').run(reset.userId);
    })();
    return res.json({ success: true, message: 'Password updated. Sign in with your new password.' });
  } catch (error) {
    return next(error);
  }
});

router.get('/me', requirePlatformUser, (req, res) => {
  return res.json({
    success: true,
    user: publicUser(req.platformUser),
    onboarding: publicOnboarding(req.platformUser.id)
  });
});

router.put('/profile', requirePlatformUser, validateRequest(profileSchema), (req, res) => {
  const profile = req.validated.body;
  // Basic info (registration name) stays locked except during an approved
  // 24-hour editing window granted by the platform owner.
  const current = database.prepare('SELECT display_name, email FROM users WHERE id = ?').get(req.platformUser.id);
  const ahead = database.prepare(`
    SELECT ahead_until FROM customer_profile_change_requests
    WHERE user_id = ? AND status = 'approved' AND ahead_until IS NOT NULL AND deleted_at IS NULL
    ORDER BY id DESC LIMIT 1
  `).get(req.platformUser.id);
  const aheadActive = ahead?.ahead_until && new Date(ahead.ahead_until).getTime() > Date.now();
  const displayName = aheadActive ? profile.displayName : current.display_name;
  database.prepare(`UPDATE users SET display_name = ?, phone = ?, professional_role = ?, location = ?, street_address = ?,
    city = ?, region = ?, postal_code = ?, country = ?, website = ?, bio = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .run(displayName, profile.phone, profile.professionalRole, profile.location, profile.streetAddress,
      profile.city, profile.region, profile.postalCode, profile.country, profile.website, profile.bio, req.platformUser.id);
  const updated = database.prepare('SELECT id, email, display_name, role FROM users WHERE id = ?').get(req.platformUser.id);
  return res.json({ success: true, user: publicUser(updated) });
});

router.get('/profile-photo', requirePlatformUser, (req, res, next) => {
  const stored = database.prepare('SELECT profile_image FROM users WHERE id = ?').get(req.platformUser.id)?.profile_image;
  if (!stored) return res.status(404).json({ success: false, error: 'No profile photo set.' });
  try {
    const { filename, mimeType } = JSON.parse(stored);
    if (!filename) return res.status(404).json({ success: false, error: 'No profile photo set.' });
    res.type(mimeType || 'application/octet-stream');
    return createReadStream(resolveWritablePath('profile-images', filename)).on('error', next).pipe(res);
  } catch (error) { return next(error); }
});

router.put('/profile-photo', requirePlatformUser, express.raw({ type: '*/*', limit: MAX_PROFILE_PHOTO_SIZE }), async (req, res, next) => {
  try {
    const buffer = req.body;
    const mimeType = String(req.headers['content-type'] || '').split(';')[0].toLowerCase();
    if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > MAX_PROFILE_PHOTO_SIZE) {
      return res.status(400).json({ success: false, error: 'Choose a photo up to 5 MB.' });
    }
    const validator = profilePhotoTypes[mimeType];
    if (!validator || !validator(buffer)) {
      return res.status(400).json({ success: false, error: 'Profile photo accepts JPG, PNG, WebP, or GIF images.' });
    }
    const id = randomBytes(16).toString('hex');
    const extension = mimeType === 'image/jpeg' ? '.jpg' : mimeType === 'image/png' ? '.png' : mimeType === 'image/webp' ? '.webp' : '.gif';
    const storedName = `customer-profile-${id}${extension}`;
    await writeFile(resolveWritablePath('profile-images', storedName), buffer, { flag: 'wx' });
    const previous = database.prepare('SELECT profile_image FROM users WHERE id = ?').get(req.platformUser.id)?.profile_image;
    database.prepare('UPDATE users SET profile_image = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(JSON.stringify({ filename: storedName, mimeType }), req.platformUser.id);
    if (previous) {
      try {
        const { filename: previousFile } = JSON.parse(previous);
        if (previousFile) await unlink(resolveWritablePath('profile-images', previousFile));
      } catch { /* The previous photo may already be gone; keep the new one. */ }
    }
    return res.status(201).json({ success: true, filename: storedName, mimeType });
  } catch (error) { return next(error); }
});

router.delete('/profile-photo', requirePlatformUser, async (req, res, next) => {
  try {
    const stored = database.prepare('SELECT profile_image FROM users WHERE id = ?').get(req.platformUser.id)?.profile_image;
    if (stored) {
      try {
        const { filename } = JSON.parse(stored);
        if (filename) await unlink(resolveWritablePath('profile-images', filename));
      } catch { /* Missing file is fine when clearing the photo. */ }
    }
    database.prepare('UPDATE users SET profile_image = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run('', req.platformUser.id);
    return res.json({ success: true });
  } catch (error) { return next(error); }
});

// ── Basic-info change request (owner approval required) ──────────────────
const profileChangeSchema = requestSchema(z.object({
  newName: z.string().trim().min(2).max(100),
  newEmail: emailSchema,
  fields: z.array(z.enum(['name', 'email'])).min(1),
  reason: z.string().trim().min(10).max(2000)
}));

router.get('/profile-change-request', requirePlatformUser, (req, res) => {
  const latest = database.prepare(`
    SELECT id, new_name AS newName, new_email AS newEmail, fields_json AS fieldsJson, reason,
      status, owner_note AS ownerNote, created_at AS createdAt, ahead_until AS aheadUntil,
      user_acknowledged_at AS userAcknowledgedAt
    FROM customer_profile_change_requests WHERE user_id = ? AND deleted_at IS NULL
    ORDER BY id DESC LIMIT 1
  `).get(req.platformUser.id);
  if (!latest) return res.json({ success: true, request: null });
  let fields = [];
  try { fields = JSON.parse(latest.fieldsJson || '[]'); } catch { fields = []; }
  return res.json({ success: true, request: { ...latest, fields } });
});

router.post('/profile-change-request', requirePlatformUser, authRateLimit, validateRequest(profileChangeSchema), (req, res) => {
  const { newName, newEmail, fields, reason } = req.validated.body;
  const open = database.prepare("SELECT id FROM customer_profile_change_requests WHERE user_id = ? AND status = 'pending' AND deleted_at IS NULL").get(req.platformUser.id);
  if (open) {
    return res.status(409).json({ success: false, error: 'You already have a pending change request. The platform owner will review it soon.' });
  }
  const current = database.prepare('SELECT display_name, email FROM users WHERE id = ?').get(req.platformUser.id);
  const fieldsLabel = fields.map((field) => field === 'name' ? 'Name' : 'Email').join(' & ');
  const requestId = database.transaction(() => {
    // Register the request in the owner support portal so it shows up in the
    // incoming requests list alongside every other request type.
    const support = database.prepare(`
      INSERT INTO admin_support_requests (name, email, category, message, status, customer_user_id)
      VALUES (?, ?, 'basic_info_change', ?, 'open', ?)
    `).run(
      current.display_name,
      current.email,
      `[Basic info change request]\nFields: ${fieldsLabel}\nCurrent: ${current.display_name} <${current.email}>\nRequested: ${newName} <${newEmail}>\n\nReason from the customer:\n${reason}`,
      req.platformUser.id
    );
    const change = database.prepare(`
      INSERT INTO customer_profile_change_requests
        (user_id, current_name, current_email, new_name, new_email, fields_json, reason, support_request_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(req.platformUser.id, current.display_name, current.email, newName, newEmail, JSON.stringify(fields), reason, support.lastInsertRowid);
    return change.lastInsertRowid;
  })();
  return res.status(201).json({
    success: true,
    message: 'Your change request has been sent to the platform owner.',
    requestId,
    request: {
      id: requestId,
      status: 'pending',
      newName,
      newEmail,
      fields,
      reason,
      aheadUntil: null,
      userAcknowledgedAt: null
    }
  });
});

// Customer acknowledges a cancelled/denied request: the pen returns to its
// resting state so a fresh ticket can be raised.
router.post('/profile-change-request/acknowledge', requirePlatformUser, (req, res) => {
  const latest = database.prepare(`
    SELECT id FROM customer_profile_change_requests
    WHERE user_id = ? AND deleted_at IS NULL AND status IN ('denied', 'cancelled') AND user_acknowledged_at IS NULL
    ORDER BY id DESC LIMIT 1
  `).get(req.platformUser.id);
  if (!latest) return res.status(404).json({ success: false, error: 'Nothing to acknowledge.' });
  database.prepare('UPDATE customer_profile_change_requests SET user_acknowledged_at = CURRENT_TIMESTAMP WHERE id = ?').run(latest.id);
  return res.json({ success: true });
});
router.delete('/profile-change-request/:requestId', requirePlatformUser, (req, res) => {
  const id = Number(req.params.requestId);
  if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ success: false, error: 'Invalid request.' });
  const request = database.prepare('SELECT id, support_request_id, status FROM customer_profile_change_requests WHERE id = ? AND user_id = ? AND deleted_at IS NULL').get(id, req.platformUser.id);
  if (!request) return res.status(404).json({ success: false, error: 'Request not found.' });
  database.transaction(() => {
    database.prepare('UPDATE customer_profile_change_requests SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);
    if (request.support_request_id && request.status === 'pending') {
      database.prepare('UPDATE admin_support_requests SET deleted_at = CURRENT_TIMESTAMP, status = \'resolved\', resolved_at = CURRENT_TIMESTAMP WHERE id = ? AND status = \'open\'').run(request.support_request_id);
    }
  })();
  return res.json({ success: true, message: 'Your request has been withdrawn.' });
});

// All non-deleted requests of this customer with the owner's responses, newest first.
router.get('/profile-change-requests', requirePlatformUser, (req, res) => {
  const requests = database.prepare(`
    SELECT request.id, request.current_name AS currentName, request.current_email AS currentEmail,
      request.new_name AS newName, request.new_email AS newEmail, request.fields_json AS fieldsJson,
      request.reason, request.status, request.owner_note AS ownerNote,
      request.created_at AS createdAt, request.reviewed_at AS reviewedAt, request.support_request_id AS supportRequestId
    FROM customer_profile_change_requests request
    WHERE request.user_id = ? AND request.deleted_at IS NULL
    ORDER BY request.id DESC LIMIT 100
  `).all(req.platformUser.id).map((row) => {
    let fields = [];
    try { fields = JSON.parse(row.fieldsJson || '[]'); } catch { fields = []; }
    const responses = database.prepare(`
      SELECT response.body, response.sent_at AS sentAt, admin.display_name AS responderName
      FROM admin_support_request_responses response
      LEFT JOIN admin_users admin ON admin.id = response.responder_id
      WHERE response.request_id = ?
      ORDER BY response.id
    `).all(row.support_request_id || 0);
    return { ...row, fields, responses };
  });
  return res.json({ success: true, requests });
});

// ── Password change with email confirmation ──────────────────────────────
const passwordRequestSchema = requestSchema(z.object({
  currentPassword: z.string().min(1).max(1024),
  password: passwordSchema
}));

router.post('/request-password-change', requirePlatformUser, authRateLimit, validateRequest(passwordRequestSchema), async (req, res, next) => {
  try {
    const { currentPassword, password } = req.validated.body;
    const user = database.prepare('SELECT email, password_hash FROM users WHERE id = ?').get(req.platformUser.id);
    if (!user || !(await bcrypt.compare(currentPassword, user.password_hash))) {
      return res.status(400).json({ success: false, error: 'Current password is incorrect.' });
    }
    if (password === currentPassword) {
      return res.status(400).json({ success: false, error: 'The new password must be different from the current one.' });
    }
    // Store the requested NEW password hash directly; it is applied only after
    // the email link is confirmed within 1 hour.
    const passwordHash = await bcrypt.hash(password, 12);
    const token = createToken();
    database.prepare('DELETE FROM customer_password_change_requests WHERE user_id = ?').run(req.platformUser.id);
    database.prepare(`
      INSERT INTO customer_password_change_requests (user_id, token_hash, new_password_hash, expires_at)
      VALUES (?, ?, ?, ?)
    `).run(req.platformUser.id, token.tokenHash, passwordHash, Date.now() + 60 * 60 * 1000);
    const transporter = requireMailer();
    const link = createFrontendLink('platform-confirm-password.html', token.token);
    await sendAccountEmail(
      transporter,
      user.email,
      'Confirm your new FolioSpace password',
      `Hello ${req.platformUser.display_name},\n\nYou requested a password change. Click the link below within 1 hour to confirm it:\n${link}\n\nIf you did not request this change, ignore this message and your password stays unchanged.`
    );
    return res.status(201).json({ success: true, message: 'Confirmation link sent. Check your email to finish the change.' });
  } catch (error) { return next(error); }
});

router.post('/change-password', requirePlatformUser, validateRequest(passwordChangeSchema), async (req, res, next) => {
  try {
    const { currentPassword, password } = req.validated.body;
    const user = database.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.platformUser.id);
    if (!user || !(await bcrypt.compare(currentPassword, user.password_hash))) {
      return res.status(400).json({ success: false, error: 'Current password is incorrect.' });
    }
    const passwordHash = await bcrypt.hash(password, 12);
    database.transaction(() => {
      database.prepare('UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(passwordHash, req.platformUser.id);
      database.prepare('DELETE FROM sessions WHERE user_id = ?').run(req.platformUser.id);
    })();
    const { maxAge, ...cookieOptions } = getPlatformSessionCookieOptions();
    res.clearCookie(PLATFORM_SESSION_COOKIE, cookieOptions);
    return res.json({ success: true, message: 'Password updated. Sign in again with your new password.' });
  } catch (error) { return next(error); }
});

export default router;
