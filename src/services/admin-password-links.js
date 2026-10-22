import { createHash, randomBytes } from 'node:crypto';
import database from '../database/database.js';
import { getMailFromAddress, getTransporter } from '../config/mailer.js';

const PASSWORD_RESET_DURATION_MS = 30 * 60 * 1000;
const SELF_SERVICE_RESEND_COOLDOWN_MS = 60 * 1000;

export async function sendAdminPasswordLink(user, { setup = false, force = false } = {}) {
  const transporter = getTransporter('otp');
  if (!transporter) throw Object.assign(new Error('Account recovery email is not configured.'), { status: 503 });
  const token = randomBytes(32).toString('base64url');
  const now = Date.now();
  if (!force) {
    const latest = database.prepare('SELECT created_at FROM admin_password_resets WHERE user_id = ? ORDER BY created_at DESC LIMIT 1').get(user.id);
    if (latest && now - latest.created_at < SELF_SERVICE_RESEND_COOLDOWN_MS) return false;
  }
  database.prepare('DELETE FROM admin_password_resets WHERE expires_at <= ?').run(now);
  database.prepare('DELETE FROM admin_password_resets WHERE user_id = ?').run(user.id);
  database.prepare('INSERT INTO admin_password_resets (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .run(createHash('sha256').update(token).digest('hex'), user.id, now + PASSWORD_RESET_DURATION_MS, now);
  const frontendUrl = (process.env.FRONTEND_URL || (process.env.NODE_ENV === 'production'
    ? 'https://david-portifolio.onrender.com'
    : 'http://localhost:5173')).split(',')[0].trim().replace(/\/$/, '');
  const link = `${frontendUrl}/admin-reset-password.html?token=${encodeURIComponent(token)}`;
  const greetingName = String(user.display_name || 'Administrator').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  const action = setup ? 'set up your password and activate your admin account' : 'reset your admin password';
  try {
    await transporter.sendMail({
      from: getMailFromAddress('otp'),
      to: user.email,
      subject: setup ? 'Set up your portfolio admin account' : 'Reset your portfolio admin password',
      text: `Hi ${user.display_name},\n\nUse this one-time link within 30 minutes to ${action}:\n${link}\n\nIf the button does not work, copy and paste the link into your browser. If you did not request this, ignore this email.`,
      html: `<div style="margin:0;padding:32px 12px;background:#f3f6fb;font-family:Arial,sans-serif;color:#1d2b45"><div style="max-width:520px;margin:0 auto;padding:32px;background:#fff;border:1px solid #e2e8f2;border-radius:16px"><p style="margin:0 0 10px;color:#315ce8;font-size:12px;font-weight:700;letter-spacing:1px">KADETECH ADMIN</p><h1 style="margin:0 0 14px;font-size:24px">${setup ? 'Finish setting up your account' : 'Reset your password'}</h1><p style="font-size:15px;line-height:1.6">Hi ${greetingName},</p><p style="font-size:15px;line-height:1.6">Use the secure link below to ${action}. It expires in 30 minutes and can only be used once.</p><p style="margin:26px 0"><a href="${link}" style="display:inline-block;padding:13px 20px;border-radius:9px;background:#315ce8;color:#fff;text-decoration:none;font-weight:700">${setup ? 'Set up my password' : 'Reset my password'}</a></p><p style="font-size:12px;line-height:1.6;color:#718098">If the button does not open, copy this address into your browser:<br><a href="${link}" style="color:#315ce8;overflow-wrap:anywhere">${link}</a></p><hr style="margin:24px 0;border:0;border-top:1px solid #e8edf4"><p style="font-size:12px;color:#718098">If you did not request this email, you can ignore it. Your account remains secure.</p></div></div>`
    });
    return true;
  } catch (error) {
    database.prepare('DELETE FROM admin_password_resets WHERE user_id = ?').run(user.id);
    throw error;
  }
}
