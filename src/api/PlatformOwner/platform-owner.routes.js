import { randomBytes, scryptSync } from 'node:crypto';
import express from 'express';
import database from '../../database/database.js';
import { requirePlatformOwner } from '../../verification/admin-auth.js';
import { sendAdminPasswordLink } from '../../services/admin-password-links.js';
import { resolveSupportRequestsForAdmin } from '../../services/support-request-resolution.js';
import { getMailFromAddress, getTransporter } from '../../config/mailer.js';

const router = express.Router();
const ADMIN_ROLES = new Set(['platform_owner', 'portfolio_owner', 'content_manager', 'document_manager', 'download_manager', 'profile_manager']);
const ALL_SUPER_ADMIN_ROLES = [...ADMIN_ROLES];
const adminSelect = `SELECT id, display_name AS displayName, email, phone, role, roles_json AS rolesJson, status, created_at AS createdAt FROM admin_users`;
function presentAdmin(admin) {
  if (!admin) return admin;
  let roles = [];
  try { roles = JSON.parse(admin.rolesJson || '[]'); } catch { roles = []; }
  if (admin.role === 'platform_owner' || roles.includes('platform_owner')) roles = ALL_SUPER_ADMIN_ROLES;
  const result = { ...admin, roles: Array.isArray(roles) && roles.length ? roles : [admin.role] };
  delete result.rolesJson;
  return result;
}

router.use(...requirePlatformOwner);

function audit(actorId, targetId, action, details = {}) {
  database.prepare('INSERT INTO platform_admin_audit (actor_id, target_id, action, details_json) VALUES (?, ?, ?, ?)')
    .run(actorId, targetId, action, JSON.stringify(details));
}

function validDateRange(from, to) {
  const isDate = (value) => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
  };
  return isDate(from) && isDate(to) && from <= to;
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

router.get('/admins/deleted', (req, res) => {
  const admins = database.prepare(`SELECT id, display_name AS displayName, email, phone, role, roles_json AS rolesJson,
    COALESCE(deleted_status, status) AS status, created_at AS createdAt, deleted_at AS deletedAt
    FROM admin_users WHERE deleted_at IS NOT NULL AND role <> 'platform_owner' ORDER BY deleted_at DESC, id DESC LIMIT 500`).all().map(presentAdmin);
  return res.json({ success: true, admins });
});

router.post('/admins/restore', (req, res) => {
  const ids = [...new Set(Array.isArray(req.body?.ids) ? req.body.ids.map(Number) : [])];
  if (!ids.length || ids.length > 500 || ids.some((id) => !Number.isSafeInteger(id) || id < 1)) return res.status(400).json({ success: false, error: 'Choose valid deleted administrator accounts to restore.' });
  const result = database.transaction(() => {
    const placeholders = ids.map(() => '?').join(', ');
    const rows = database.prepare(`SELECT id, email, deleted_status FROM admin_users WHERE deleted_at IS NOT NULL AND role <> 'platform_owner' AND id IN (${placeholders})`).all(...ids);
    if (rows.length) {
      database.prepare(`UPDATE admin_users SET status = COALESCE(deleted_status, 'inactive'), deleted_status = NULL, deleted_at = NULL WHERE id IN (${rows.map(() => '?').join(', ')})`).run(...rows.map((row) => row.id));
      audit(req.adminUser.id, null, 'admins_restored', { adminIds: rows.map((row) => row.id), emails: rows.map((row) => row.email) });
    }
    return rows.length;
  })();
  return res.json({ success: true, affected: result, message: `${result} administrator account${result === 1 ? '' : 's'} restored.` });
});

router.get('/admins', (req, res) => {
  const requestedPage = Number(req.query.page);
  const requestedPageNumber = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
  const pageSize = 50;
  const search = typeof req.query.search === 'string' ? req.query.search.trim().slice(0, 120) : '';
  const status = ['active', 'inactive', 'pending'].includes(req.query.status) ? req.query.status : '';
  const conditions = [];
  const parameters = [];
  if (search) {
    conditions.push('(display_name LIKE ? COLLATE NOCASE OR email LIKE ? COLLATE NOCASE)');
    parameters.push(`%${search}%`, `%${search}%`);
  }
  if (status) { conditions.push('status = ?'); parameters.push(status); }
  const total = database.prepare(`SELECT COUNT(*) AS total FROM admin_users WHERE deleted_at IS NULL${conditions.length ? ` AND ${conditions.join(' AND ')}` : ''}`).get(...parameters).total;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(requestedPageNumber, totalPages);
  const counts = database.prepare(`SELECT
    COUNT(*) AS total,
    COALESCE(SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END), 0) AS active,
    COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) AS pending,
    COALESCE(SUM(CASE WHEN status = 'inactive' THEN 1 ELSE 0 END), 0) AS inactive,
    (SELECT COUNT(*) FROM admin_users WHERE deleted_at IS NOT NULL) AS deleted
    FROM admin_users WHERE deleted_at IS NULL`).get();
  const admins = database.prepare(`${adminSelect} WHERE deleted_at IS NULL${conditions.length ? ` AND ${conditions.join(' AND ')}` : ''} ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END, display_name COLLATE NOCASE, id LIMIT ? OFFSET ?`)
    .all(...parameters, pageSize, (page - 1) * pageSize).map(presentAdmin);
  return res.json({ success: true, admins, page, pageSize, total, totalPages, counts });
});

router.get('/audit', (req, res) => {
  const events = database.prepare(`
    SELECT platform_admin_audit.id, platform_admin_audit.action, platform_admin_audit.details_json AS details,
      platform_admin_audit.created_at AS createdAt,
      actor.email AS actorEmail, target.email AS targetEmail
    FROM platform_admin_audit
    LEFT JOIN admin_users actor ON actor.id = platform_admin_audit.actor_id
    LEFT JOIN admin_users target ON target.id = platform_admin_audit.target_id
    WHERE platform_admin_audit.deleted_at IS NULL
    ORDER BY platform_admin_audit.created_at DESC, platform_admin_audit.id DESC LIMIT 100
  `).all().map((event) => {
    const details = JSON.parse(event.details || '{}');
    return { ...event, targetEmail: event.targetEmail || details.email || null, details };
  });
  const deletedCount = database.prepare('SELECT COUNT(*) AS count FROM platform_admin_audit WHERE deleted_at IS NOT NULL').get().count;
  return res.json({ success: true, events, deletedCount });
});

router.get('/inbox-counts', (req, res) => {
  const requestCounts = database.prepare(`SELECT
    COALESCE(SUM(CASE WHEN status = 'open' AND deleted_at IS NULL THEN 1 ELSE 0 END), 0) AS open,
    COALESCE(SUM(CASE WHEN status = 'resolved' AND deleted_at IS NULL THEN 1 ELSE 0 END), 0) AS resolved,
    COALESCE(SUM(CASE WHEN deleted_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS deleted
    FROM admin_support_requests`).get();
  const incoming = database.prepare(`SELECT COUNT(*) AS count FROM platform_messages message
    JOIN platform_message_threads thread ON thread.id = message.thread_id
    JOIN admin_users sender ON sender.id = message.sender_id
    WHERE sender.id <> ? AND message.deleted_at IS NULL
      AND (message.recipient_owner_id = ? OR (message.recipient_owner_id IS NULL AND sender.role <> 'platform_owner'))`).get(req.adminUser.id, req.adminUser.id).count;
  const outgoing = database.prepare(`SELECT COUNT(*) AS count
    FROM platform_messages message JOIN admin_users sender ON sender.id = message.sender_id
    JOIN platform_message_threads thread ON thread.id = message.thread_id
    WHERE sender.id = ? AND message.deleted_at IS NULL
      AND COALESCE(message.recipient_owner_id, thread.admin_user_id) <> ?`).get(req.adminUser.id, req.adminUser.id).count;
  const unreadMessages = database.prepare(`SELECT COUNT(*) AS count FROM platform_messages message
    JOIN platform_message_threads thread ON thread.id = message.thread_id
    JOIN admin_users sender ON sender.id = message.sender_id
    WHERE sender.id <> ? AND message.deleted_at IS NULL
      AND (message.recipient_owner_id = ? OR (message.recipient_owner_id IS NULL AND sender.role <> 'platform_owner')) AND NOT EXISTS (
      SELECT 1 FROM platform_message_reads state WHERE state.message_id = message.id AND state.reader_id = ?
    ) AND NOT EXISTS (
      SELECT 1 FROM platform_message_hidden hidden WHERE hidden.message_id = message.id AND hidden.admin_user_id = ?
    ) AND NOT EXISTS (
      SELECT 1 FROM platform_message_permanent_hidden hidden WHERE hidden.message_id = message.id AND hidden.admin_user_id = ?
    )`).get(req.adminUser.id, req.adminUser.id, req.adminUser.id, req.adminUser.id, req.adminUser.id).count;
  return res.json({ success: true, requests: requestCounts.open, resolvedRequests: requestCounts.resolved, deletedRequests: requestCounts.deleted, messages: unreadMessages, messagesIncoming: incoming, messagesOutgoing: outgoing });
});

router.get('/support-requests', (req, res) => {
  const status = req.query.status === 'deleted' ? 'WHERE request.deleted_at IS NOT NULL'
    : ['open', 'resolved'].includes(req.query.status) ? 'WHERE request.deleted_at IS NULL AND request.status = ?'
      : req.query.status === 'all' ? 'WHERE request.deleted_at IS NULL' : "WHERE request.deleted_at IS NULL AND request.status = 'open'";
  const requests = database.prepare(`SELECT request.id, request.name, request.email,
    request.category, request.message, request.requested_roles_json AS requestedRolesJson, request.status, request.deleted_at AS deletedAt, request.created_at AS createdAt, request.resolved_at AS resolvedAt,
    (SELECT COUNT(*) FROM admin_support_request_responses response WHERE response.request_id = request.id) AS responseCount,
    admin.status AS adminStatus, COALESCE(request.admin_user_id, admin.id) AS adminId,
    admin.role AS adminRole, admin.roles_json AS adminRolesJson
    FROM admin_support_requests request LEFT JOIN admin_users admin ON admin.email = request.email COLLATE NOCASE
    ${status} ORDER BY COALESCE(request.resolved_at, request.created_at) DESC, request.id DESC LIMIT 500`)
    .all(...(['open', 'resolved'].includes(req.query.status) ? [req.query.status] : [])).map((request) => {
      let adminRoles = [];
      try { adminRoles = JSON.parse(request.adminRolesJson || '[]'); } catch { adminRoles = []; }
      let requestedRoles = [];
      try { requestedRoles = JSON.parse(request.requestedRolesJson || '[]'); } catch { requestedRoles = []; }
      if (!adminRoles.length && request.adminRole) adminRoles = [request.adminRole];
      delete request.adminRolesJson;
      delete request.requestedRolesJson;
      delete request.adminRole;
      return { ...request, adminRoles, requestedRoles };
    });
  return res.json({ success: true, requests });
});

router.patch('/support-requests/:requestId', (req, res) => {
  const id = Number(req.params.requestId);
  const status = req.body?.status;
  if (!Number.isSafeInteger(id) || id < 1 || !['open', 'resolved'].includes(status)) {
    return res.status(400).json({ success: false, error: 'Choose a valid support request and status.' });
  }
  const request = database.prepare('SELECT category, email FROM admin_support_requests WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!request) return res.status(404).json({ success: false, error: 'Support request not found.' });
  if (status === 'resolved' && ['admin_invitation', 'setup_link'].includes(request.category)) {
    const account = database.prepare('SELECT status FROM admin_users WHERE email = ? COLLATE NOCASE').get(request.email);
    if (account?.status !== 'active') {
      return res.status(409).json({ success: false, error: 'This request can be resolved after the administrator completes setup and the account is active.' });
    }
  }
  const result = database.prepare(`UPDATE admin_support_requests SET status = ?, resolved_at = ? WHERE id = ? AND deleted_at IS NULL`)
    .run(status, status === 'resolved' ? new Date().toISOString() : null, id);
  if (!result.changes) return res.status(404).json({ success: false, error: 'Support request not found.' });
  database.prepare('INSERT INTO platform_admin_audit (actor_id, action, details_json) VALUES (?, ?, ?)')
    .run(req.adminUser.id, status === 'resolved' ? 'support_request_resolved' : 'support_request_reopened', JSON.stringify({ requestId: id }));
  return res.json({ success: true, message: status === 'resolved' ? 'Support request marked resolved.' : 'Support request reopened.' });
});

router.post('/support-requests/respond', async (req, res, next) => {
  try {
    const ids = [...new Set(Array.isArray(req.body?.ids) ? req.body.ids.map(Number) : [])];
    const body = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
    if (!ids.length || ids.length > 50 || ids.some((id) => !Number.isSafeInteger(id) || id < 1)) {
      return res.status(400).json({ success: false, error: 'Select between 1 and 50 valid open tickets.' });
    }
    if (body.length < 3 || body.length > 5000) return res.status(400).json({ success: false, error: 'Write a response between 3 and 5,000 characters.' });
    const requests = database.prepare(`SELECT id, name, email FROM admin_support_requests WHERE status = 'open' AND deleted_at IS NULL AND id IN (${ids.map(() => '?').join(',')})`).all(...ids);
    if (!requests.length) return res.status(409).json({ success: false, error: 'None of the selected tickets are still open.' });
    const transporter = getTransporter('contact');
    if (!transporter) return res.status(503).json({ success: false, error: 'Support email is not configured. Set the contact email credentials before sending responses.' });
    const sent = [];
    const failed = [];
    for (const request of requests) {
      try {
        await transporter.sendMail({
          from: getMailFromAddress('contact'), to: request.email, replyTo: req.adminUser.email,
          subject: 'Update on your administrator support ticket',
          text: `Hello ${request.name},\n\n${body}\n\nReply to this email to continue the conversation.\n\nPlatform support`,
          html: `<div style="font-family:Arial,sans-serif;color:#24324a;line-height:1.6"><p>Hello ${escapeHtml(request.name)},</p><p>${escapeHtml(body).replace(/\r?\n/g, '<br>')}</p><p>Reply to this email to continue the conversation.</p><p>Platform support</p></div>`
        });
        database.prepare('INSERT INTO admin_support_request_responses (request_id, responder_id, body) VALUES (?, ?, ?)')
          .run(request.id, req.adminUser.id, body);
        sent.push(request.id);
      } catch (mailError) {
        failed.push({ id: request.id, email: request.email, error: mailError.message });
      }
    }
    if (sent.length) audit(req.adminUser.id, null, 'support_request_response_sent', { requestIds: sent, failedCount: failed.length });
    return res.json({
      success: sent.length > 0, sent: sent.length, failed: failed.length,
      message: `${sent.length} response${sent.length === 1 ? '' : 's'} sent${failed.length ? `; ${failed.length} could not be delivered` : ''}.`,
      failures: failed.map(({ id, email }) => ({ id, email }))
    });
  } catch (error) { return next(error); }
});

router.post('/support-requests/bulk-action', (req, res) => {
  const action = req.body?.action;
  const ids = [...new Set(Array.isArray(req.body?.ids) ? req.body.ids.map(Number) : [])];
  if (!['resolve', 'delete', 'restore'].includes(action) || !ids.length || ids.length > 500 || ids.some((id) => !Number.isSafeInteger(id) || id < 1)) {
    return res.status(400).json({ success: false, error: 'Choose valid support requests and a supported bulk action.' });
  }
  if (action === 'delete') {
    const result = database.transaction(() => {
      const placeholders = ids.map(() => '?').join(', ');
      const rows = database.prepare(`SELECT id, status FROM admin_support_requests WHERE id IN (${placeholders})`).all(...ids);
      if (rows.length) {
        database.prepare(`UPDATE admin_support_requests SET deleted_at = ? WHERE deleted_at IS NULL AND id IN (${placeholders})`).run(new Date().toISOString(), ...ids);
        database.prepare('INSERT INTO platform_admin_audit (actor_id, action, details_json) VALUES (?, ?, ?)')
        .run(req.adminUser.id, 'support_requests_bulk_deleted', JSON.stringify({ requestIds: rows.map((row) => row.id), statuses: rows.map((row) => row.status) }));
      }
      return rows.length;
    })();
    return res.json({ success: true, affected: result, message: `${result} request${result === 1 ? '' : 's'} deleted.` });
  }
  if (action === 'restore') {
    const result = database.transaction(() => {
      const placeholders = ids.map(() => '?').join(', ');
      const rows = database.prepare(`SELECT id FROM admin_support_requests WHERE deleted_at IS NOT NULL AND id IN (${placeholders})`).all(...ids);
      if (rows.length) {
        database.prepare(`UPDATE admin_support_requests SET deleted_at = NULL WHERE id IN (${rows.map(() => '?').join(', ')})`).run(...rows.map((row) => row.id));
        audit(req.adminUser.id, null, 'support_requests_restored', { requestIds: rows.map((row) => row.id) });
      }
      return rows.length;
    })();
    return res.json({ success: true, affected: result, message: `${result} support request${result === 1 ? '' : 's'} restored.` });
  }
  const now = new Date().toISOString();
  const result = database.transaction(() => {
    const placeholders = ids.map(() => '?').join(', ');
    const canResolveWhenActive = `AND (category NOT IN ('admin_invitation', 'setup_link') OR EXISTS (
      SELECT 1 FROM admin_users admin WHERE admin.email = admin_support_requests.email COLLATE NOCASE AND admin.status = 'active'
    ))`;
    const rows = database.prepare(`SELECT id FROM admin_support_requests WHERE deleted_at IS NULL AND status = 'open' AND category <> 'admin_invitation' ${canResolveWhenActive} AND id IN (${placeholders})`).all(...ids);
    const update = database.prepare(`UPDATE admin_support_requests SET status = 'resolved', resolved_at = ? WHERE deleted_at IS NULL AND status = 'open' AND category <> 'admin_invitation' ${canResolveWhenActive} AND id IN (${placeholders})`);
    const changed = update.run(now, ...ids).changes;
    if (changed) database.prepare('INSERT INTO platform_admin_audit (actor_id, action, details_json) VALUES (?, ?, ?)')
      .run(req.adminUser.id, 'support_requests_bulk_resolved', JSON.stringify({ requestIds: rows.map((row) => row.id) }));
    return changed;
  })();
  return res.json({ success: true, affected: result, message: `${result} request${result === 1 ? '' : 's'} marked resolved.` });
});

router.delete('/support-requests/:requestId', (req, res) => {
  const id = Number(req.params.requestId);
  if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ success: false, error: 'Invalid support request.' });
  const request = database.prepare('SELECT id, email, category, status FROM admin_support_requests WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!request) return res.status(404).json({ success: false, error: 'Support request not found.' });
  database.transaction(() => {
    database.prepare('UPDATE admin_support_requests SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL').run(new Date().toISOString(), id);
    database.prepare('INSERT INTO platform_admin_audit (actor_id, action, details_json) VALUES (?, ?, ?)')
      .run(req.adminUser.id, 'support_request_deleted', JSON.stringify({ requestId: id, email: request.email, category: request.category, status: request.status }));
  })();
  return res.json({ success: true, message: 'Support request deleted.' });
});

router.post('/support-requests/:requestId/invite', async (req, res, next) => {
  const requestId = Number(req.params.requestId);
  if (!Number.isSafeInteger(requestId) || requestId < 1) return res.status(400).json({ success: false, error: 'Choose a valid request.' });
  const request = database.prepare("SELECT id, name, email, category, requested_roles_json, status FROM admin_support_requests WHERE id = ? AND deleted_at IS NULL").get(requestId);
  if (!request) return res.status(404).json({ success: false, error: 'Request not found.' });
  if (!['admin_invitation', 'setup_link'].includes(request.category)) return res.status(400).json({ success: false, error: 'Only invitation and setup-link requests can receive setup links.' });
  if (request.status !== 'open') return res.status(409).json({ success: false, error: 'This request is already closed.' });

  const isInvitationRequest = request.category === 'admin_invitation';
  const willCreateAccount = !database.prepare('SELECT id FROM admin_users WHERE email = ? COLLATE NOCASE').get(request.email);
  const requiresRoleSelection = isInvitationRequest || willCreateAccount;
  let requestedRoles = [];
  try { requestedRoles = JSON.parse(request.requested_roles_json || '[]'); } catch { requestedRoles = []; }
  const roles = [...new Set(isInvitationRequest && requestedRoles.length ? requestedRoles : Array.isArray(req.body?.roles) ? req.body.roles : [])];
  const standardRoles = new Set(['portfolio_owner', 'content_manager', 'document_manager', 'download_manager', 'profile_manager']);
  if (requiresRoleSelection && (!roles.length || roles.some((role) => !standardRoles.has(role)))) {
    return res.status(400).json({ success: false, error: 'Choose one or more standard admin roles. Super-admin access cannot be assigned from an invitation request.' });
  }

  let admin = database.prepare('SELECT id, email, display_name, status FROM admin_users WHERE email = ?').get(request.email);
  let createdAdmin = false;
  const reactivatingAdmin = ['admin_invitation', 'setup_link'].includes(request.category) && admin?.status === 'inactive';
  try {
    if (isInvitationRequest && admin?.status === 'active') return res.status(409).json({ success: false, error: 'An active admin account with this email already exists. Resolve the request after confirming with the requester.' });
    if (request.category === 'setup_link' && admin && !['pending', 'inactive'].includes(admin.status)) {
      return res.status(409).json({ success: false, error: 'No pending admin account was found for this email. Ask the platform owner to review the invitation request.' });
    }
    if (!admin) {
      const salt = randomBytes(16).toString('hex');
      const hash = scryptSync(randomBytes(32).toString('hex'), salt, 64).toString('hex');
      const result = database.prepare(`INSERT INTO admin_users (email, display_name, password_hash, role, roles_json, status)
        VALUES (?, ?, ?, ?, ?, 'pending')`).run(request.email, request.name, `${salt}:${hash}`, roles[0], JSON.stringify(roles));
      admin = { id: result.lastInsertRowid, email: request.email, display_name: request.name, status: 'pending' };
      createdAdmin = true;
    }

    await sendAdminPasswordLink(admin, { setup: !reactivatingAdmin, force: true });
    if (reactivatingAdmin) {
      if (isInvitationRequest) {
        database.prepare('UPDATE admin_users SET role = ?, roles_json = ?, status = \'active\' WHERE id = ? AND status = \'inactive\'')
          .run(roles[0], JSON.stringify(roles), admin.id);
      } else {
        database.prepare("UPDATE admin_users SET status = 'active' WHERE id = ? AND status = 'inactive'").run(admin.id);
      }
      database.prepare('DELETE FROM admin_sessions WHERE user_id = ?').run(admin.id);
      resolveSupportRequestsForAdmin(admin.email, ['inactive_account'], req.adminUser.id, 'admin_reactivated_from_invitation_request');
    } else if (requiresRoleSelection && !createdAdmin && !reactivatingAdmin) {
      database.prepare('UPDATE admin_users SET role = ?, roles_json = ? WHERE id = ? AND status = \'pending\'')
        .run(roles[0], JSON.stringify(roles), admin.id);
    }
    database.prepare('UPDATE admin_support_requests SET admin_user_id = ? WHERE id = ? AND status = \'open\'').run(admin.id, request.id);
    audit(req.adminUser.id, admin.id, reactivatingAdmin ? 'inactive_admin_reactivated_from_request' : 'admin_setup_link_sent_from_request', { requestId: request.id, email: admin.email, ...(requiresRoleSelection ? { roles } : {}) });
    const action = reactivatingAdmin ? 'Password reset link sent' : 'Setup link sent';
    return res.json({ success: true, message: `${action} to ${admin.email}. This request stays open until the account issue is completed. The link expires in 30 minutes; resend it from this request if needed.` });
  } catch (error) {
    if (createdAdmin) {
      database.prepare('DELETE FROM admin_password_resets WHERE user_id = ?').run(admin.id);
      database.prepare('DELETE FROM admin_users WHERE id = ?').run(admin.id);
    }
    return next(error);
  }
});

router.delete('/audit', (req, res) => {
  const now = new Date().toISOString();
  const result = database.prepare('UPDATE platform_admin_audit SET deleted_at = ? WHERE deleted_at IS NULL').run(now);
  audit(req.adminUser.id, null, 'audit_history_deleted', { deletedCount: result.changes, deletedAt: now });
  return res.json({ success: true, deleted: result.changes, message: `Moved ${result.changes} activity records to recoverable history.` });
});

router.delete('/audit/:eventId', (req, res) => {
  const id = Number(req.params.eventId);
  if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ success: false, error: 'Invalid activity record.' });
  const result = database.prepare('UPDATE platform_admin_audit SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL').run(new Date().toISOString(), id);
  if (!result.changes) return res.status(404).json({ success: false, error: 'Activity record not found.' });
  audit(req.adminUser.id, null, 'audit_activity_deleted', { eventId: id });
  return res.json({ success: true, deleted: result.changes, message: 'Activity record deleted.' });
});

router.post('/audit/restore', (req, res) => {
  const { from, to } = req.body || {};
  const timezoneOffset = Number(req.body?.timezoneOffset);
  if (!validDateRange(from, to) || !Number.isInteger(timezoneOffset) || Math.abs(timezoneOffset) > 840) {
    return res.status(400).json({ success: false, error: 'Choose valid dates with the start date on or before the end date.' });
  }
  const restored = database.prepare(`UPDATE platform_admin_audit SET deleted_at = NULL
    WHERE deleted_at IS NOT NULL AND date(deleted_at, ?) BETWEEN date(?) AND date(?)`)
    .run(`${-timezoneOffset} minutes`, from, to).changes;
  audit(req.adminUser.id, null, 'audit_activity_restored', { from, to, restoredCount: restored });
  return res.json({ success: true, restored, message: `${restored} activity record${restored === 1 ? '' : 's'} restored from ${from} through ${to}.` });
});

router.post('/admins', async (req, res, next) => {
  let id;
  try {
    const displayName = typeof req.body?.displayName === 'string' ? req.body.displayName.trim() : '';
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const phone = typeof req.body?.phone === 'string' ? req.body.phone.trim() : '';
    let roles = [...new Set(Array.isArray(req.body?.roles) ? req.body.roles : (typeof req.body?.role === 'string' ? [req.body.role] : []))];
    if (!displayName || displayName.length > 120) return res.status(400).json({ success: false, error: 'Enter a name from 1 to 120 characters.' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return res.status(400).json({ success: false, error: 'Enter a valid email address.' });
    if (phone.length > 40) return res.status(400).json({ success: false, error: 'Phone number must be 40 characters or less.' });
    if (!roles.length || roles.some((role) => !ADMIN_ROLES.has(role))) return res.status(400).json({ success: false, error: 'Choose at least one valid administrator role.' });
    if (roles.includes('platform_owner')) roles = ALL_SUPER_ADMIN_ROLES;
    if (database.prepare('SELECT id FROM admin_users WHERE email = ?').get(email)) return res.status(409).json({ success: false, error: 'An admin with this email already exists.' });
    const salt = randomBytes(16).toString('hex');
    const hash = scryptSync(randomBytes(32).toString('hex'), salt, 64).toString('hex');
    const role = roles.includes('platform_owner') ? 'platform_owner' : roles[0];
    const result = database.prepare(`INSERT INTO admin_users (email, display_name, password_hash, phone, role, roles_json, status)
      VALUES (?, ?, ?, ?, ?, ?, 'pending')`).run(email, displayName, `${salt}:${hash}`, phone || null, role, JSON.stringify(roles));
    id = result.lastInsertRowid;
    await sendAdminPasswordLink({ id, email, display_name: displayName }, { setup: true });
    audit(req.adminUser.id, id, 'admin_invited', { email, roles });
    return res.status(201).json({ success: true, admin: presentAdmin(database.prepare(`${adminSelect} WHERE id = ?`).get(id)), message: `Setup link sent to ${email}.` });
  } catch (error) {
    if (id) {
      database.prepare('DELETE FROM admin_password_resets WHERE user_id = ?').run(id);
      database.prepare('DELETE FROM admin_users WHERE id = ?').run(id);
    }
    return next(error);
  }
});

router.post('/admins/bulk-action', async (req, res, next) => {
  const action = typeof req.body?.action === 'string' ? req.body.action : '';
  if (!['delete_all', 'activate_all', 'deactivate_all', 'reset_passwords', 'assign_roles_all'].includes(action)) {
    return res.status(400).json({ success: false, error: 'Choose a valid bulk administrator action.' });
  }

  try {
    const targets = database.prepare("SELECT id, email, display_name, status FROM admin_users WHERE role <> 'platform_owner' AND deleted_at IS NULL ORDER BY id").all();
    if (action === 'assign_roles_all') {
      let roles = [...new Set(Array.isArray(req.body?.roles) ? req.body.roles : [])];
      if (!roles.length || roles.some((role) => !ADMIN_ROLES.has(role))) {
        return res.status(400).json({ success: false, error: 'Choose at least one valid role to assign.' });
      }
      if (roles.includes('platform_owner')) roles = ALL_SUPER_ADMIN_ROLES;
      const primaryRole = roles.includes('platform_owner') ? 'platform_owner' : roles[0];
      const changed = database.transaction(() => {
        const update = database.prepare("UPDATE admin_users SET role = ?, roles_json = ? WHERE role <> 'platform_owner' AND deleted_at IS NULL");
        const result = update.run(primaryRole, JSON.stringify(roles));
        database.prepare('INSERT INTO platform_admin_audit (actor_id, action, details_json) VALUES (?, ?, ?)')
          .run(req.adminUser.id, 'admins_bulk_roles_changed', JSON.stringify({ count: result.changes, roles }));
        return result.changes;
      })();
      return res.json({ success: true, affected: changed, skipped: 0, roles, message: `Roles assigned to ${changed} customer admin account${changed === 1 ? '' : 's'}. Super-admin accounts were not changed.` });
    }
    if (action === 'delete_all') {
      const result = database.transaction(() => {
        database.prepare('INSERT INTO platform_admin_audit (actor_id, action, details_json) VALUES (?, ?, ?)')
          .run(req.adminUser.id, 'admins_bulk_deleted', JSON.stringify({ count: targets.length, adminIds: targets.map((admin) => admin.id) }));
        database.prepare("UPDATE admin_users SET deleted_at = ?, deleted_status = status, status = 'inactive' WHERE role <> 'platform_owner' AND deleted_at IS NULL").run(new Date().toISOString());
        database.prepare("DELETE FROM admin_sessions WHERE user_id IN (SELECT id FROM admin_users WHERE role <> 'platform_owner' AND deleted_at IS NOT NULL)").run();
        database.prepare("DELETE FROM admin_password_resets WHERE user_id IN (SELECT id FROM admin_users WHERE role <> 'platform_owner' AND deleted_at IS NOT NULL)").run();
        return targets.length;
      })();
      return res.json({ success: true, affected: result, skipped: 0, message: `${result} customer admin account${result === 1 ? '' : 's'} deleted. Super-admin accounts were protected.` });
    }

    if (action === 'activate_all' || action === 'deactivate_all') {
      const nextStatus = action === 'activate_all' ? 'active' : 'inactive';
      const fromStatus = action === 'activate_all' ? 'inactive' : 'active';
      const result = database.transaction(() => {
        const changed = database.prepare("UPDATE admin_users SET status = ? WHERE role <> 'platform_owner' AND deleted_at IS NULL AND status = ?").run(nextStatus, fromStatus);
        if (action === 'deactivate_all') {
          database.prepare("DELETE FROM admin_sessions WHERE user_id IN (SELECT id FROM admin_users WHERE role <> 'platform_owner' AND status = 'inactive')").run();
          database.prepare("DELETE FROM admin_password_resets WHERE user_id IN (SELECT id FROM admin_users WHERE role <> 'platform_owner' AND status = 'inactive')").run();
        }
        database.prepare('INSERT INTO platform_admin_audit (actor_id, action, details_json) VALUES (?, ?, ?)')
          .run(req.adminUser.id, action === 'activate_all' ? 'admins_bulk_activated' : 'admins_bulk_deactivated', JSON.stringify({ count: changed.changes }));
        return changed.changes;
      })();
      const skipped = targets.length - result;
      if (action === 'activate_all') {
        for (const admin of targets.filter((account) => account.status === 'inactive')) {
          resolveSupportRequestsForAdmin(admin.email, ['inactive_account'], req.adminUser.id, 'admins_bulk_activated');
        }
      }
      return res.json({ success: true, affected: result, skipped, message: `${result} customer admin account${result === 1 ? '' : 's'} ${nextStatus === 'active' ? 'activated' : 'deactivated'}; ${skipped} unchanged. Pending invitations and super-admin accounts were protected.` });
    }

    const eligible = targets.filter((admin) => ['active', 'pending'].includes(admin.status));
    let sent = 0;
    const failures = [];
    for (const admin of eligible) {
      try {
        await sendAdminPasswordLink(admin, { setup: admin.status === 'pending', force: true });
        sent += 1;
      } catch (mailError) {
        failures.push({ id: admin.id, email: admin.email, reason: typeof mailError.code === 'string' ? mailError.code.slice(0, 80) : 'delivery_failed' });
      }
    }
    database.prepare('INSERT INTO platform_admin_audit (actor_id, action, details_json) VALUES (?, ?, ?)')
      .run(req.adminUser.id, 'admins_bulk_password_links_sent', JSON.stringify({ sent, failed: failures.length, skipped: targets.length - eligible.length, failures }));
    const skipped = targets.length - eligible.length;
    return res.json({
      success: true,
      affected: sent,
      skipped,
      failed: failures.length,
      message: `Password or setup links sent to ${sent} admin${sent === 1 ? '' : 's'}; ${failures.length} failed and ${skipped} inactive or super-admin account${skipped === 1 ? '' : 's'} skipped.`
    });
  } catch (error) {
    return next(error);
  }
});

router.patch('/admins/:adminId/role', (req, res) => {
  const id = Number(req.params.adminId);
  if (id === Number(req.adminUser.id)) return res.status(403).json({ success: false, error: 'You cannot change roles for the super-admin account in your active session.' });
  const role = typeof req.body?.role === 'string' ? req.body.role : '';
  if (!Number.isSafeInteger(id) || id < 1 || !ADMIN_ROLES.has(role) || role === 'platform_owner') return res.status(400).json({ success: false, error: 'Choose a valid administrator role.' });
  const target = database.prepare('SELECT id, role FROM admin_users WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!target) return res.status(404).json({ success: false, error: 'Admin account not found.' });
  if (target.role === 'platform_owner') return res.status(403).json({ success: false, error: 'Use the role selection control to manage this super-admin.' });
  database.prepare('UPDATE admin_users SET role = ?, roles_json = ? WHERE id = ?').run(role, JSON.stringify([role]), id);
  audit(req.adminUser.id, id, 'admin_role_changed', { from: target.role, to: role });
  return res.json({ success: true, admin: presentAdmin(database.prepare(`${adminSelect} WHERE id = ?`).get(id)) });
});

router.patch('/admins/:adminId/roles', (req, res) => {
  const id = Number(req.params.adminId);
  let roles = [...new Set(Array.isArray(req.body?.roles) ? req.body.roles : [])];
  if (!Number.isSafeInteger(id) || id < 1 || !roles.length || roles.some((role) => !ADMIN_ROLES.has(role))) {
    return res.status(400).json({ success: false, error: 'Choose at least one valid administrator role.' });
  }
  if (id === Number(req.adminUser.id)) return res.status(403).json({ success: false, error: 'You cannot change roles for the super-admin account in your active session.' });
  const target = database.prepare('SELECT id, email, role, roles_json FROM admin_users WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!target) return res.status(404).json({ success: false, error: 'Admin account not found.' });
  const oldRoles = JSON.parse(target.roles_json || JSON.stringify([target.role]));
  if (roles.includes('platform_owner')) roles = ALL_SUPER_ADMIN_ROLES;
  const removesOwner = oldRoles.includes('platform_owner') && !roles.includes('platform_owner');
  if (removesOwner) {
    const ownerCount = database.prepare("SELECT COUNT(*) AS count FROM admin_users WHERE role = 'platform_owner' AND status = 'active'").get().count;
    if (ownerCount <= 1) return res.status(409).json({ success: false, error: 'At least one active super-admin must remain.' });
  }
  const primaryRole = roles.includes('platform_owner') ? 'platform_owner' : roles[0];
  database.prepare('UPDATE admin_users SET role = ?, roles_json = ? WHERE id = ?').run(primaryRole, JSON.stringify(roles), id);
  audit(req.adminUser.id, id, 'admin_roles_changed', { from: oldRoles, to: roles });
  return res.json({ success: true, admin: presentAdmin(database.prepare(`${adminSelect} WHERE id = ?`).get(id)) });
});

router.patch('/admins/:adminId/status', (req, res) => {
  const id = Number(req.params.adminId);
  const status = typeof req.body?.status === 'string' ? req.body.status : '';
  if (!Number.isSafeInteger(id) || id < 1 || !['active', 'inactive'].includes(status)) return res.status(400).json({ success: false, error: 'Choose a valid admin account status.' });
  const target = database.prepare('SELECT id, email, role, status FROM admin_users WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!target) return res.status(404).json({ success: false, error: 'Admin account not found.' });
  if (target.role === 'platform_owner') return res.status(403).json({ success: false, error: 'Platform-owner status cannot be changed here.' });
  if (target.status === 'pending') return res.status(409).json({ success: false, error: 'This admin must finish the emailed setup link before activation.' });
  database.transaction(() => {
    database.prepare('UPDATE admin_users SET status = ? WHERE id = ?').run(status, id);
    if (status === 'inactive') {
      database.prepare('DELETE FROM admin_sessions WHERE user_id = ?').run(id);
      database.prepare('DELETE FROM admin_password_resets WHERE user_id = ?').run(id);
    }
  })();
  audit(req.adminUser.id, id, status === 'active' ? 'admin_activated' : 'admin_deactivated');
  if (status === 'active') resolveSupportRequestsForAdmin(target.email, ['inactive_account'], req.adminUser.id, 'admin_activated');
  return res.json({ success: true, admin: presentAdmin(database.prepare(`${adminSelect} WHERE id = ?`).get(id)) });
});

router.delete('/admins/:adminId', (req, res) => {
  const id = Number(req.params.adminId);
  if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ success: false, error: 'Invalid admin account.' });
  if (id === req.adminUser.id) return res.status(403).json({ success: false, error: 'You cannot delete your own super-admin account.' });
  const target = database.prepare('SELECT id, email, display_name, role, status FROM admin_users WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!target) return res.status(404).json({ success: false, error: 'Admin account not found.' });
  if (target.role === 'platform_owner') return res.status(403).json({ success: false, error: 'The super-admin account cannot be deleted here.' });
  database.transaction(() => {
    database.prepare('INSERT INTO platform_admin_audit (actor_id, target_id, action, details_json) VALUES (?, ?, ?, ?)')
      .run(req.adminUser.id, target.id, 'admin_deleted', JSON.stringify({ email: target.email, displayName: target.display_name, role: target.role, status: target.status }));
    database.prepare('DELETE FROM admin_sessions WHERE user_id = ?').run(id);
    database.prepare('DELETE FROM admin_password_resets WHERE user_id = ?').run(id);
    database.prepare("UPDATE admin_users SET deleted_at = ?, deleted_status = status, status = 'inactive' WHERE id = ?").run(new Date().toISOString(), id);
  })();
  return res.json({ success: true, message: `Admin account ${target.email} was deleted.` });
});

router.post('/admins/:adminId/password-reset', async (req, res, next) => {
  try {
    const id = Number(req.params.adminId);
    if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ success: false, error: 'Invalid admin account.' });
    const user = database.prepare('SELECT id, email, display_name, status FROM admin_users WHERE id = ?').get(id);
    if (!user) return res.status(404).json({ success: false, error: 'Admin account not found.' });
    if (user.status === 'inactive') return res.status(409).json({ success: false, error: 'Activate this admin before sending a password reset.' });
    await sendAdminPasswordLink(user, { setup: user.status === 'pending', force: true });
    audit(req.adminUser.id, id, user.status === 'pending' ? 'admin_setup_link_resent' : 'admin_password_reset_sent');
    return res.json({ success: true, message: user.status === 'pending' ? 'A secure setup link was resent.' : 'A secure password reset link was sent.' });
  } catch (error) {
    return next(error);
  }
});

export default router;
