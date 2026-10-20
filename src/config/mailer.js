import nodemailer from 'nodemailer';

export const getTransporter = () => {
  const user = process.env.EMAIL_USER;
  const pass = process.env.EMAIL_PASSWORD;
  const timeoutOptions = {
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000
  };

  if (!user || !pass) return null;

  const host = process.env.SMTP_HOST;
  if (host) {
    const port = Number(process.env.SMTP_PORT || 587);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('SMTP_PORT must be a valid TCP port.');
    }
    const secure = process.env.SMTP_SECURE === 'true' || (!process.env.SMTP_SECURE && port === 465);
    return nodemailer.createTransport({
      host,
      port,
      secure,
      auth: { user, pass },
      ...timeoutOptions
    });
  }

  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user, pass },
    ...timeoutOptions
  });
};

export const getMailFromAddress = () => process.env.SMTP_FROM || process.env.EMAIL_USER || '';