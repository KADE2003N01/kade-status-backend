import { getMailFromAddress } from '../config/mailer.js';

/** Deliver the owner notification and visitor confirmation for a contact form. */
export async function sendContactEmails({ transporter, name, email, message }) {
  const from = getMailFromAddress('contact');
  const ownerEmail = process.env.CONTACT_NOTIFICATION_EMAIL || process.env.CONTACT_EMAIL_USER || process.env.EMAIL_USER;
  if (!ownerEmail) throw new Error('Set CONTACT_NOTIFICATION_EMAIL or CONTACT_EMAIL_USER to receive contact messages.');

  await transporter.sendMail({
    from,
    to: ownerEmail,
    replyTo: email,
    subject: `Portfolio: Message from ${name}`,
    text: `From: ${name} (${email})\n\nMessage:\n${message}`
  });

  await transporter.sendMail({
    from,
    to: email,
    subject: 'Message Received - Kade Portfolio',
    text: `Hi ${name},\n\nThanks for reaching out! I've received your message and will respond shortly.`
  });
}
