import { getTransporter } from '../../config/mailer.js';
import { sendContactEmails } from '../../services/contact.service.js';

export const getStatus = async (req, res) => {
  const transporter = getTransporter('contact');
  let smtpStatus = 'Unknown';
  
  if (transporter) {
    try {
      await transporter.verify();
      smtpStatus = '✅ Connected to Gmail';
    } catch (err) {
      smtpStatus = `❌ Gmail Auth Failed: ${err.message}`;
    }
  }

  res.json({
    success: true,
    configured: !!transporter,
    smtp: smtpStatus,
    email: process.env.CONTACT_EMAIL_USER || process.env.CONTACT_NOTIFICATION_EMAIL || 'Not configured',
    hasPassword: !!(process.env.CONTACT_EMAIL_PASSWORD || process.env.EMAIL_PASSWORD)
  });
};

export const sendContactEmail = async (req, res) => {
  try {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
    if (name.length < 2 || name.length > 100) {
      return res.status(400).json({ success: false, error: 'Enter your name (2 to 100 characters).' });
    }
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (email.length > 254 || !emailRegex.test(email)) {
      return res.status(400).json({ success: false, error: 'Enter a valid email address.' });
    }
    if (message.length < 10 || message.length > 3000) {
      return res.status(400).json({ success: false, error: 'Enter a message between 10 and 3,000 characters.' });
    }

    const transporter = getTransporter('contact');
    if (!transporter) {
      return res.status(503).json({ success: false, error: 'Email service not configured' });
    }

    await sendContactEmails({ transporter, name, email, message });

    return res.status(200).json({ success: true, message: 'Message sent!' });
  } catch (error) {
    console.error('❌ Contact API Error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
};
