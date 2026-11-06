export const CUSTOMER_SUPPORT_ATTACHMENT_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'video/mp4', 'video/webm', 'video/quicktime',
  'audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/wav', 'audio/x-wav', 'audio/ogg', 'audio/webm', 'audio/flac',
  'application/pdf', 'text/plain', 'text/csv', 'application/zip', 'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation'
]);

export const CUSTOMER_SUPPORT_REACTIONS = new Set(['👍', '❤️', '😂', '😮', '🙏', '😢', '😡', '🎉', '🔥', '👏', '👀', '✅']);

export function isValidCustomerSupportFile(mimeType, buffer) {
  if (mimeType.startsWith('text/')) return !buffer.includes(0);
  if (mimeType === 'image/jpeg') return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (mimeType === 'image/png') return buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mimeType === 'image/gif') return buffer.subarray(0, 4).toString('ascii') === 'GIF8';
  if (mimeType === 'image/webp') return buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
  if (mimeType.startsWith('video/') || mimeType === 'audio/mp4') return buffer.subarray(4, 8).toString('ascii') === 'ftyp' || (mimeType === 'video/webm' && buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])));
  if (mimeType === 'audio/webm') return buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  if (mimeType === 'audio/ogg') return buffer.subarray(0, 4).toString('ascii') === 'OggS';
  if (mimeType === 'audio/wav' || mimeType === 'audio/x-wav') return buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WAVE';
  if (mimeType === 'audio/flac') return buffer.subarray(0, 4).toString('ascii') === 'fLaC';
  if (mimeType === 'audio/aac') return buffer[0] === 0xff && (buffer[1] & 0xf6) === 0xf0;
  if (mimeType === 'audio/mpeg') return buffer.subarray(0, 3).toString('ascii') === 'ID3' || (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0);
  if (mimeType === 'application/pdf') return buffer.subarray(0, 5).toString('ascii') === '%PDF-';
  if (mimeType === 'application/zip' || mimeType.includes('openxmlformats')) return buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  if (mimeType.startsWith('application/ms') || mimeType === 'application/vnd.ms-excel' || mimeType === 'application/vnd.ms-powerpoint') return buffer.subarray(0, 4).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0]));
  return false;
}

export function getCustomerSupportMessages(database, userId, actorRole, actorId, attachmentBasePath) {
  const messages = database.prepare(`SELECT message.id, message.user_id AS userId,
    message.sender_role AS senderRole, message.body, message.created_at AS createdAt,
    message.read_at AS readAt, message.edited_at AS editedAt, message.deleted_at AS deletedAt,
    message.reply_to_message_id AS replyToMessageId,
    reply.body AS replyToBody, reply.sender_role AS replyToSenderRole
    FROM customer_support_messages message
    LEFT JOIN customer_support_messages reply ON reply.id = message.reply_to_message_id
    WHERE message.user_id = ? ORDER BY message.id LIMIT 2000`).all(userId);
  if (!messages.length) return [];

  const placeholders = messages.map(() => '?').join(', ');
  const attachmentsByMessage = new Map();
  for (const attachment of database.prepare(`SELECT id, message_id AS messageId, original_name AS name,
    mime_type AS mimeType, size_bytes AS size FROM customer_support_message_attachments
    WHERE user_id = ? AND message_id IN (${placeholders}) ORDER BY created_at, id`).all(userId, ...messages.map((message) => message.id))) {
    const attachments = attachmentsByMessage.get(attachment.messageId) || [];
    attachments.push({
      ...attachment,
      url: `${attachmentBasePath}/attachments/${encodeURIComponent(attachment.id)}`
    });
    attachmentsByMessage.set(attachment.messageId, attachments);
  }

  const reactionsByMessage = new Map();
  for (const reaction of database.prepare(`SELECT message_id AS messageId, actor_role AS actorRole,
    actor_id AS actorId, emoji FROM customer_support_message_reactions
    WHERE message_id IN (${placeholders}) ORDER BY created_at`).all(...messages.map((message) => message.id))) {
    const reactions = reactionsByMessage.get(reaction.messageId) || new Map();
    const existing = reactions.get(reaction.emoji) || { emoji: reaction.emoji, count: 0, reacted: false };
    existing.count += 1;
    if (reaction.actorRole === actorRole && Number(reaction.actorId) === Number(actorId)) existing.reacted = true;
    reactions.set(reaction.emoji, existing);
    reactionsByMessage.set(reaction.messageId, reactions);
  }

  const flagsByMessage = new Map();
  for (const flag of database.prepare(`SELECT message_id AS messageId, flag
    FROM customer_support_message_flags WHERE actor_role = ? AND actor_id = ?
      AND message_id IN (${placeholders})`).all(actorRole, actorId, ...messages.map((message) => message.id))) {
    const flags = flagsByMessage.get(flag.messageId) || new Set();
    flags.add(flag.flag);
    flagsByMessage.set(flag.messageId, flags);
  }

  return messages.map((message) => ({
    ...message,
    body: message.deletedAt ? '' : message.body,
    isRead: message.readAt !== null,
    attachments: attachmentsByMessage.get(message.id) || [],
    reactions: [...(reactionsByMessage.get(message.id)?.values() || [])],
    isPinned: flagsByMessage.get(message.id)?.has('pin') || false,
    isStarred: flagsByMessage.get(message.id)?.has('star') || false
  }));
}
