import { createHash } from 'node:crypto';
import database from '../database/database.js';
import { getPlatformSessionUser } from './platform-auth.js';

export const SESSION_COOKIE = 'kade_admin_session';
export const SESSION_DURATION_MS = 8 * 60 * 60 * 1000;
export const REMEMBERED_SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000;

export function hashSessionToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

export function getSessionCookieOptions(maxAge = SESSION_DURATION_MS) {
  const configuredSameSite = (process.env.COOKIE_SAME_SITE || '').toLowerCase();
  const isProduction = process.env.NODE_ENV === 'production';
  const sameSite = ['strict', 'lax', 'none'].includes(configuredSameSite)
    ? configuredSameSite
    : (isProduction ? 'none' : 'lax');
  return {
    httpOnly: true,
    secure: sameSite === 'none' || isProduction,
    sameSite,
    path: '/api',
    maxAge
  };
}

export function clearSessionCookie(res) {
  const { maxAge, ...options } = getSessionCookieOptions();
  res.clearCookie(SESSION_COOKIE, options);
}

function getSessionUser(req) {
  let token = req.cookies?.[SESSION_COOKIE];
  if (!token) {
    const header = req.headers?.authorization || '';
    if (header.startsWith('Bearer ')) token = header.slice(7).trim() || null;
  }
  if (!token) return null;

  const session = database.prepare(`
    SELECT admin_users.id, admin_users.email, admin_users.display_name, admin_users.role, admin_users.roles_json, admin_users.status
    FROM admin_sessions
    JOIN admin_users ON admin_users.id = admin_sessions.user_id
    WHERE admin_sessions.token_hash = ? AND admin_sessions.expires_at > ? AND admin_users.status = 'active'
  `).get(hashSessionToken(token), Date.now());

  if (!session) return null;
  let roles = [];
  try { roles = JSON.parse(session.roles_json || '[]'); } catch { roles = []; }
  session.roles = Array.isArray(roles) && roles.length ? roles : [session.role];
  delete session.roles_json;
  return session;
}

export function requireAdmin(req, res, next) {
  const user = getSessionUser(req);
  if (!user) {
    if (getPlatformSessionUser(req)) {
      return res.status(403).json({ success: false, error: 'A platform customer account cannot access administrator routes.' });
    }
    clearSessionCookie(res);
    return res.status(401).json({ success: false, error: 'Authentication required.' });
  }
  req.adminUser = user;
  return next();
}

export function requireAdminRole(...allowedRoles) {
  return (req, res, next) => {
    const roles = req.adminUser?.roles || [req.adminUser?.role];
    if (roles.includes('platform_owner') || allowedRoles.some((role) => roles.includes(role))) return next();
    return res.status(403).json({ success: false, error: 'Your administrator role cannot access this section.' });
  };
}

export const requirePlatformOwner = [requireAdmin, requireAdminRole('platform_owner')];
