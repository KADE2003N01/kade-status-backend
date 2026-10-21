import { getMailFromAddress } from '../config/mailer.js';

/** Deliver the owner notification and visitor confirmation for a contact form. */
export async function sendContactEmails({ transporter, name, email, phone, message }) {
  const from = getMailFromAddress('contact');
  const ownerEmail = (process.env.CONTACT_NOTIFICATION_EMAIL || process.env.CONTACT_EMAIL_USER || process.env.EMAIL_USER || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail)) {
    throw new Error('Set CONTACT_NOTIFICATION_EMAIL to a valid email address so contact messages have a recipient.');
  }

  await transporter.sendMail({
    from,
    to: ownerEmail,
    replyTo: email,
    subject: `Portfolio: Message from ${name}`,
    text: `From: ${name} (${email})\nPhone: ${phone}\n\nMessage:\n${message}`
  });

  try {
    await transporter.sendMail({
      from,
      to: email,
      subject: 'Message Received - Kade Portfolio',
      text: `Hi ${name},\n\nThanks for reaching out! I've received your message and will respond shortly.`
    });
    return { confirmationSent: true };
  } catch (error) {
    console.warn('Contact message reached the owner, but the visitor confirmation email failed:', error.code || error.message);
    return { confirmationSent: false };
  }
}
