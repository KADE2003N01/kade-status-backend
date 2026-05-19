import { getTransporter } from '../../config/mailer.js';

export const getStatus = async (req, res) => {
  const transporter = getTransporter();
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
    email: process.env.EMAIL_USER || 'Not configured',
    hasPassword: !!process.env.EMAIL_PASSWORD
  });
};

export const sendContactEmail = async (req, res) => {
  try {
    const { name, email, message } = req.body;

    if (!name || !email || !message) {
      return res.status(400).json({ success: false, error: 'All fields are required' });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ success: false, error: 'Invalid email address' });
    }

    const transporter = getTransporter();
    if (!transporter) {
      return res.status(503).json({ success: false, error: 'Email service not configured' });
    }

    // Notify Owner
    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: process.env.EMAIL_USER,
      replyTo: email,
      subject: `Portfolio: Message from ${name}`,
      text: `From: ${name} (${email})\n\nMessage:\n${message}`,
    });

    // Auto-reply to Visitor
    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: email,
      subject: 'Message Received - Kade Portfolio',
      text: `Hi ${name},\n\nThanks for reaching out! I've received your message and will respond shortly.`,
    });

    return res.status(200).json({ success: true, message: 'Message sent!' });
  } catch (error) {
    console.error('❌ Contact API Error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
};