import { createHash } from 'node:crypto';
import database from '../database/database.js';

export const PLATFORM_SESSION_COOKIE = 'kade_platform_session';
export const PLATFORM_SESSION_DURATION_MS = 12 * 60 * 60 * 1000;

export function hashPlatformToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

export function getPlatformSessionUser(req) {
  const token = req.cookies?.[PLATFORM_SESSION_COOKIE];
  if (!token) return null;

  return database.prepare(`
    SELECT users.id, users.email, users.display_name, users.role, users.status
    FROM sessions
    JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ? AND sessions.expires_at > ? AND users.status = 'active'
      AND users.email_verified_at IS NOT NULL
  `).get(hashPlatformToken(token), Date.now()) || null;
}

export function requirePlatformUser(req, res, next) {
  const user = getPlatformSessionUser(req);
  if (!user) {
    return res.status(401).json({ success: false, error: 'Authentication required.' });
  }
  req.platformUser = user;
  return next();
}

export function requirePlatformRole(role) {
  return (req, res, next) => {
    if (req.platformUser?.role !== role) {
      return res.status(403).json({ success: false, error: 'Your account cannot access this section.' });
    }
    return next();
  };
}

export function getPlatformSessionCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/api',
    maxAge: PLATFORM_SESSION_DURATION_MS
  };
}
