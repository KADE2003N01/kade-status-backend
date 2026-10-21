import { getTransporter } from '../../config/mailer.js';
import database from '../../database/database.js';
import { sendContactEmails } from '../../services/contact.service.js';
import { parseEastAfricanPhone } from '../../utils/east-africa-phone.js';

export const getStatus = async (req, res) => {
  let transporter;
  try {
    transporter = getTransporter('contact');
  } catch {
    return res.json({ success: true, configured: false, smtp: 'configuration_error', hasPassword: false });
  }
  let smtpStatus = 'not_configured';
  if (transporter) {
    try {
      await transporter.verify();
      smtpStatus = 'connected';
    } catch (error) {
      smtpStatus = error.code === 'EAUTH' ? 'authentication_failed' : 'connection_failed';
    }
  }

  return res.json({
    success: true,
    configured: Boolean(transporter),
    smtp: smtpStatus,
    hasPassword: Boolean(process.env.CONTACT_EMAIL_PASSWORD || process.env.EMAIL_PASSWORD)
  });
};

export const sendContactEmail = async (req, res) => {
  try {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const phone = typeof req.body?.phone === 'string' ? req.body.phone.trim() : '';
    const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
    if (name.length < 2 || name.length > 100) {
      return res.status(400).json({ success: false, error: 'Enter your name (2 to 100 characters).' });
    }
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (email.length > 254 || !emailRegex.test(email)) {
      return res.status(400).json({ success: false, error: 'Enter a valid email address.' });
    }
    const parsedPhone = parseEastAfricanPhone(phone);
    if (phone.length > 30 || !parsedPhone) {
      return res.status(400).json({ success: false, error: 'Enter a valid East African phone number with its country calling code.' });
    }
    const normalizedPhone = parsedPhone.number;
    if (message.length < 10 || message.length > 3000) {
      return res.status(400).json({ success: false, error: 'Enter a message between 10 and 3,000 characters.' });
    }

    const transporter = getTransporter('contact');
    if (!transporter) {
      return res.status(503).json({
        success: false,
        error: 'Contact email is not configured. Set CONTACT_EMAIL_USER and CONTACT_EMAIL_PASSWORD, then restart the backend.'
      });
    }

    const delivery = await sendContactEmails({ transporter, name, email, phone: normalizedPhone, message });
    database.prepare(`
      INSERT INTO contact_messages (name, email, phone, message, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(name, email, normalizedPhone, message, new Date().toISOString());

    return res.status(200).json({
      success: true,
      message: delivery.confirmationSent
        ? 'Your message was sent. A confirmation email is on its way.'
        : 'Your message was sent, but the confirmation email could not be delivered.',
      confirmationSent: delivery.confirmationSent
    });
  } catch (error) {
    console.error('Contact API delivery failed:', error.code || error.message);
    if (error.message?.startsWith('CONTACT_EMAIL_USER') || error.message?.startsWith('Set CONTACT_NOTIFICATION_EMAIL')) {
      return res.status(503).json({ success: false, error: error.message });
    }
    if (error.code === 'EAUTH') {
      return res.status(503).json({
        success: false,
        error: 'Gmail rejected the contact mailbox credentials. Replace the example password with a current Google App Password in CONTACT_EMAIL_PASSWORD, then restart the backend.'
      });
    }
    if (['ETIMEDOUT', 'ESOCKET', 'ECONNECTION', 'EDNS'].includes(error.code)) {
      return res.status(503).json({ success: false, error: 'Could not reach the contact email server. Check CONTACT_SMTP_HOST and CONTACT_SMTP_PORT.' });
    }
    return res.status(503).json({ success: false, error: 'The message could not be delivered. Check the contact mail settings and backend log.' });
  }
};
