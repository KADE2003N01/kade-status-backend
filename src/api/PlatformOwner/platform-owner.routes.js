import { randomBytes, scryptSync } from 'node:crypto';
import express from 'express';
import database from '../../database/database.js';
import { requirePlatformOwner } from '../../verification/admin-auth.js';
import { sendAdminPasswordLink } from '../../services/admin-password-links.js';

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
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const total = database.prepare(`SELECT COUNT(*) AS total FROM admin_users ${where}`).get(...parameters).total;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(requestedPageNumber, totalPages);
  const counts = database.prepare(`SELECT
    COUNT(*) AS total,
    COALESCE(SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END), 0) AS active,
    COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) AS pending,
    COALESCE(SUM(CASE WHEN status = 'inactive' THEN 1 ELSE 0 END), 0) AS inactive
    FROM admin_users`).get();
  const admins = database.prepare(`${adminSelect} ${where} ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END, display_name COLLATE NOCASE, id LIMIT ? OFFSET ?`)
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
    ORDER BY platform_admin_audit.created_at DESC, platform_admin_audit.id DESC LIMIT 100
  `).all().map((event) => {
    const details = JSON.parse(event.details || '{}');
    return { ...event, targetEmail: event.targetEmail || details.email || null, details };
  });
  return res.json({ success: true, events });
});

router.get('/inbox-counts', (req, res) => {
  const requests = database.prepare("SELECT COUNT(*) AS count FROM admin_support_requests WHERE status = 'open'").get().count;
  const incoming = database.prepare(`SELECT COUNT(*) AS count FROM platform_messages message
    JOIN platform_message_threads thread ON thread.id = message.thread_id
    JOIN admin_users sender ON sender.id = message.sender_id
    WHERE sender.role <> 'platform_owner'`).get().count;
  const outgoing = database.prepare(`SELECT COUNT(*) AS count
    FROM platform_messages message JOIN admin_users sender ON sender.id = message.sender_id
    WHERE sender.role = 'platform_owner'`).get().count;
  const unreadMessages = database.prepare(`SELECT COUNT(*) AS count FROM platform_messages message
    JOIN platform_message_threads thread ON thread.id = message.thread_id
    JOIN admin_users sender ON sender.id = message.sender_id
    WHERE sender.role <> 'platform_owner' AND NOT EXISTS (
      SELECT 1 FROM platform_message_reads state WHERE state.message_id = message.id AND state.reader_id = ?
    )`).get(req.adminUser.id).count;
  return res.json({ success: true, requests, messages: unreadMessages, messagesIncoming: incoming, messagesOutgoing: outgoing });
});

router.get('/support-requests', (req, res) => {
  const status = req.query.status === 'all' ? '' : "WHERE request.status = 'open'";
  const requests = database.prepare(`SELECT request.id, request.admin_user_id AS adminId, request.name, request.email,
    request.category, request.message, request.status, request.created_at AS createdAt, request.resolved_at AS resolvedAt
    FROM admin_support_requests request ${status} ORDER BY request.created_at DESC, request.id DESC LIMIT 250`).all();
  return res.json({ success: true, requests });
});

router.patch('/support-requests/:requestId', (req, res) => {
  const id = Number(req.params.requestId);
  const status = req.body?.status;
  if (!Number.isSafeInteger(id) || id < 1 || !['open', 'resolved'].includes(status)) {
    return res.status(400).json({ success: false, error: 'Choose a valid support request and status.' });
  }
  const result = database.prepare(`UPDATE admin_support_requests SET status = ?, resolved_at = ? WHERE id = ?`)
    .run(status, status === 'resolved' ? new Date().toISOString() : null, id);
  if (!result.changes) return res.status(404).json({ success: false, error: 'Support request not found.' });
  database.prepare('INSERT INTO platform_admin_audit (actor_id, action, details_json) VALUES (?, ?, ?)')
    .run(req.adminUser.id, status === 'resolved' ? 'support_request_resolved' : 'support_request_reopened', JSON.stringify({ requestId: id }));
  return res.json({ success: true, message: status === 'resolved' ? 'Support request marked resolved.' : 'Support request reopened.' });
});

router.delete('/audit', (req, res) => {
  const result = database.prepare('DELETE FROM platform_admin_audit').run();
  return res.json({ success: true, deleted: result.changes, message: `Deleted ${result.changes} activity records.` });
});

router.delete('/audit/:eventId', (req, res) => {
  const id = Number(req.params.eventId);
  if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ success: false, error: 'Invalid activity record.' });
  const result = database.prepare('DELETE FROM platform_admin_audit WHERE id = ?').run(id);
  if (!result.changes) return res.status(404).json({ success: false, error: 'Activity record not found.' });
  return res.json({ success: true, deleted: result.changes, message: 'Activity record deleted.' });
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
    const targets = database.prepare("SELECT id, email, display_name, status FROM admin_users WHERE role <> 'platform_owner' ORDER BY id").all();
    if (action === 'assign_roles_all') {
      let roles = [...new Set(Array.isArray(req.body?.roles) ? req.body.roles : [])];
      if (!roles.length || roles.some((role) => !ADMIN_ROLES.has(role))) {
        return res.status(400).json({ success: false, error: 'Choose at least one valid role to assign.' });
      }
      if (roles.includes('platform_owner')) roles = ALL_SUPER_ADMIN_ROLES;
      const primaryRole = roles.includes('platform_owner') ? 'platform_owner' : roles[0];
      const changed = database.transaction(() => {
        const update = database.prepare("UPDATE admin_users SET role = ?, roles_json = ? WHERE role <> 'platform_owner'");
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
          .run(req.adminUser.id, 'admins_bulk_deleted', JSON.stringify({ count: targets.length }));
        database.prepare("DELETE FROM admin_users WHERE role <> 'platform_owner'").run();
        return targets.length;
      })();
      return res.json({ success: true, affected: result, skipped: 0, message: `${result} customer admin account${result === 1 ? '' : 's'} deleted. Super-admin accounts were protected.` });
    }

    if (action === 'activate_all' || action === 'deactivate_all') {
      const nextStatus = action === 'activate_all' ? 'active' : 'inactive';
      const fromStatus = action === 'activate_all' ? 'inactive' : 'active';
      const result = database.transaction(() => {
        const changed = database.prepare("UPDATE admin_users SET status = ? WHERE role <> 'platform_owner' AND status = ?").run(nextStatus, fromStatus);
        if (action === 'deactivate_all') {
          database.prepare("DELETE FROM admin_sessions WHERE user_id IN (SELECT id FROM admin_users WHERE role <> 'platform_owner' AND status = 'inactive')").run();
          database.prepare("DELETE FROM admin_password_resets WHERE user_id IN (SELECT id FROM admin_users WHERE role <> 'platform_owner' AND status = 'inactive')").run();
        }
        database.prepare('INSERT INTO platform_admin_audit (actor_id, action, details_json) VALUES (?, ?, ?)')
          .run(req.adminUser.id, action === 'activate_all' ? 'admins_bulk_activated' : 'admins_bulk_deactivated', JSON.stringify({ count: changed.changes }));
        return changed.changes;
      })();
      const skipped = targets.length - result;
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
  const target = database.prepare('SELECT id, role FROM admin_users WHERE id = ?').get(id);
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
  const target = database.prepare('SELECT id, email, role, roles_json FROM admin_users WHERE id = ?').get(id);
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
  const target = database.prepare('SELECT id, role, status FROM admin_users WHERE id = ?').get(id);
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
  return res.json({ success: true, admin: presentAdmin(database.prepare(`${adminSelect} WHERE id = ?`).get(id)) });
});

router.delete('/admins/:adminId', (req, res) => {
  const id = Number(req.params.adminId);
  if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ success: false, error: 'Invalid admin account.' });
  if (id === req.adminUser.id) return res.status(403).json({ success: false, error: 'You cannot delete your own super-admin account.' });
  const target = database.prepare('SELECT id, email, display_name, role, status FROM admin_users WHERE id = ?').get(id);
  if (!target) return res.status(404).json({ success: false, error: 'Admin account not found.' });
  if (target.role === 'platform_owner') return res.status(403).json({ success: false, error: 'The super-admin account cannot be deleted here.' });
  database.transaction(() => {
    database.prepare('INSERT INTO platform_admin_audit (actor_id, target_id, action, details_json) VALUES (?, ?, ?, ?)')
      .run(req.adminUser.id, target.id, 'admin_deleted', JSON.stringify({ email: target.email, displayName: target.display_name, role: target.role, status: target.status }));
    database.prepare('DELETE FROM admin_sessions WHERE user_id = ?').run(id);
    database.prepare('DELETE FROM admin_password_resets WHERE user_id = ?').run(id);
    database.prepare('DELETE FROM admin_users WHERE id = ?').run(id);
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
