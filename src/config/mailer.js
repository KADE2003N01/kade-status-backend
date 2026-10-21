import nodemailer from 'nodemailer';

export const getTransporter = (purpose = 'otp') => {
  const isContact = purpose === 'contact';
  const user = ((isContact ? process.env.CONTACT_EMAIL_USER : process.env.EMAIL_USER)
    || (isContact ? process.env.EMAIL_USER : '') || '').trim();
  // Gmail formats App Passwords with spaces for display; remove separators for SMTP auth.
  const pass = ((isContact ? process.env.CONTACT_EMAIL_PASSWORD : process.env.EMAIL_PASSWORD)
    || (isContact ? process.env.EMAIL_PASSWORD : '') || '').replace(/\s+/g, '');
  const timeoutOptions = {
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000
  };

  if (!user || !pass) return null;

  const host = (isContact ? process.env.CONTACT_SMTP_HOST : process.env.SMTP_HOST) || process.env.SMTP_HOST;
  if (host) {
    const port = Number((isContact ? process.env.CONTACT_SMTP_PORT : process.env.SMTP_PORT) || process.env.SMTP_PORT || 587);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('SMTP_PORT must be a valid TCP port.');
    }
    const secureSetting = (isContact ? process.env.CONTACT_SMTP_SECURE : process.env.SMTP_SECURE) || process.env.SMTP_SECURE;
    const secure = secureSetting === 'true' || (!secureSetting && port === 465);
    return nodemailer.createTransport({
      host,
      port,
      secure,
      auth: { user, pass },
      ...timeoutOptions
    });
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(user)) {
    throw new Error(`${isContact ? 'CONTACT_EMAIL_USER' : 'EMAIL_USER'} must be a valid email address when using Gmail SMTP.`);
  }

  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user, pass },
    ...timeoutOptions
  });
};

export const getMailFromAddress = (purpose = 'otp') => purpose === 'contact'
  ? process.env.CONTACT_SMTP_FROM || process.env.CONTACT_EMAIL_USER || process.env.EMAIL_USER || ''
  : process.env.SMTP_FROM || process.env.EMAIL_USER || '';
