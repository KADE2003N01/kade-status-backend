import { getMailFromAddress } from '../config/mailer.js';

/** Deliver the owner notification and visitor confirmation for a contact form. */
export async function sendContactEmails({ transporter, name, email, message }) {
  const from = getMailFromAddress();

  await transporter.sendMail({
    from,
    to: process.env.EMAIL_USER,
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
