import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const databasePath = path.join(tmpdir(), `kade-messages-test-${process.pid}.sqlite`);
const storageDirectory = path.join(tmpdir(), `kade-messages-storage-${process.pid}`);
process.env.DATABASE_PATH = databasePath;
process.env.STORAGE_DIR = storageDirectory;
process.env.ADMIN_EMAIL = 'owner-messages@example.com';
process.env.ADMIN_PASSWORD = 'owner-test-password';
process.env.ADMIN_DISPLAY_NAME = 'Messages Owner';
process.env.FRONTEND_URL = 'http://localhost:5173';
process.env.NODE_ENV = 'test';
process.env.EMAIL_USER = '';
process.env.EMAIL_PASSWORD = '';
process.env.CONTACT_EMAIL_USER = '';
process.env.CONTACT_EMAIL_PASSWORD = '';

const [{ default: app }, { default: database }, { hashSessionToken }] = await Promise.all([
  import('../app.js'),
  import('../src/database/database.js'),
  import('../src/verification/admin-auth.js')
]);
const ownerId = database.prepare("SELECT id FROM admin_users WHERE email = 'owner-messages@example.com'").get().id;
database.prepare("UPDATE admin_users SET role = 'platform_owner', roles_json = '[\"platform_owner\"]', status = 'active' WHERE id = ?").run(ownerId);
const adminId = database.prepare(`INSERT INTO admin_users (email, display_name, password_hash, role, roles_json, status)
  VALUES ('customer-messages@example.com', 'Customer Admin', 'unused:unused', 'portfolio_owner', '[\"portfolio_owner\"]', 'active')`).run().lastInsertRowid;
const peerOwnerId = database.prepare(`INSERT INTO admin_users (email, display_name, password_hash, role, roles_json, status)
VALUES ('peer-owner@example.com', 'Peer Owner', 'unused:unused', 'platform_owner', '[\"platform_owner\"]', 'active')`).run().lastInsertRowid;
const ownerToken = 'messages-owner-session';
const adminToken = 'messages-customer-session';
const expiresAt = Date.now() + 60 * 60 * 1000;
const createSession = database.prepare('INSERT INTO admin_sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)');
createSession.run(hashSessionToken(ownerToken), ownerId, expiresAt, Date.now());
createSession.run(hashSessionToken(adminToken), adminId, expiresAt, Date.now());

const server = app.listen(0);
await new Promise((resolve) => server.once('listening', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}/api/messages`;
const request = (token, pathName = '', options = {}) => fetch(`${baseUrl}${pathName}`, {
  ...options,
  headers: { Authorization: `Bearer ${token}`, ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers }
});

const requestOwner = (pathName) => fetch(`${baseUrl.replace('/api/messages', '/api/platform-owner')}${pathName}`, {
  headers: { Authorization: `Bearer ${ownerToken}` }
});

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  database.close();
  for (const suffix of ['', '-shm', '-wal']) {
    const filePath = `${databasePath}${suffix}`;
    if (existsSync(filePath)) unlinkSync(filePath);
  }
});

test('admin inbox lists active super-admins and supports editable, clearable messages with reply permissions', async () => {
  const contacts = await request(adminToken, '/super-admins');
  assert.equal(contacts.status, 200);
  assert.equal((await contacts.json()).admins[0].email, 'owner-messages@example.com');

  const sent = await request(adminToken, '', { method: 'POST', body: JSON.stringify({ body: 'First message', recipientOwnerId: ownerId }) });
  assert.equal(sent.status, 201);
  const sentMessage = (await sent.json()).message;
  assert.equal(sentMessage.recipientOwnerId, ownerId);

  const ownerInbox = await request(ownerToken);
  const ownerMessages = (await ownerInbox.json()).messages;
  assert.ok(ownerMessages.some((message) => message.id === sentMessage.id && message.recipientOwnerId === ownerId));

  const peerThreadId = database.prepare('INSERT INTO platform_message_threads (admin_user_id) VALUES (?)').run(peerOwnerId).lastInsertRowid;
  const peerMessageId = database.prepare(`INSERT INTO platform_messages (thread_id, sender_id, body, recipient_owner_id)
    VALUES (?, ?, 'Peer owner message', ?)`).run(peerThreadId, peerOwnerId, ownerId).lastInsertRowid;
  const ownerCountsBeforePeerRead = (await (await requestOwner('/inbox-counts')).json()).messages;
  assert.equal(ownerCountsBeforePeerRead, 2, 'the owner chat icon includes unread messages from both admins and other super-admins');
  const ownerInboxWithPeer = await request(ownerToken);
  assert.equal((await ownerInboxWithPeer.json()).messages.find((message) => message.id === peerMessageId).isRead, 0);
  const peerRead = await request(ownerToken, `/threads/${peerThreadId}/read`, { method: 'POST', body: '{}' });
  assert.equal(peerRead.status, 200);
  const ownerInboxAfterPeerRead = await request(ownerToken);
  assert.equal((await ownerInboxAfterPeerRead.json()).messages.find((message) => message.id === peerMessageId).isRead, 1, 'opening a peer super-admin chat marks its messages as read');
  const ownerCountsAfterPeerRead = (await (await requestOwner('/inbox-counts')).json()).messages;
  assert.equal(ownerCountsAfterPeerRead, ownerCountsBeforePeerRead - 1, 'reading a peer super-admin message clears the owner chat icon badge');

  await request(ownerToken, `/threads/${sentMessage.threadId}/read`, { method: 'POST', body: '{}' });
  const legacyMessageId = database.prepare(`INSERT INTO platform_messages (thread_id, sender_id, body)
    VALUES (?, ?, 'Legacy private message without a recipient owner')`).run(sentMessage.threadId, adminId).lastInsertRowid;
  const ownerCountsBeforeLegacyRead = (await (await requestOwner('/inbox-counts')).json()).messages;
  const legacyRead = await request(ownerToken, `/threads/${sentMessage.threadId}/read`, { method: 'POST', body: '{}' });
  assert.equal(legacyRead.status, 200);
  const ownerInboxAfterLegacyRead = await request(ownerToken);
  assert.equal((await ownerInboxAfterLegacyRead.json()).messages.find((message) => message.id === legacyMessageId).isRead, 1, 'legacy private messages without a recipient owner are marked read by the opened owner');
  const ownerCountsAfterLegacyRead = (await (await requestOwner('/inbox-counts')).json()).messages;
  assert.equal(ownerCountsAfterLegacyRead, ownerCountsBeforeLegacyRead - 1, 'reading a legacy private message clears its unread badge');
  const ownerHiddenPeerMessage = await request(ownerToken, '/bulk-hide', { method: 'DELETE', body: JSON.stringify({ ids: [peerMessageId] }) });
  assert.equal(ownerHiddenPeerMessage.status, 200);
  assert.ok(!(await (await request(ownerToken)).json()).messages.some((message) => message.id === peerMessageId), 'Manage can remove a received message from only the current owner inbox');

  const ownerReply = await request(ownerToken, '', { method: 'POST', body: JSON.stringify({ body: 'Reply from the owner', adminId, allowMessageReplies: false }) });
  assert.equal(ownerReply.status, 201);
  await ownerReply.json();
  const ownerReplyCreated = database.prepare('SELECT id FROM platform_messages WHERE sender_id = ? AND body = ?').get(ownerId, 'Reply from the owner');
  assert.ok(ownerReplyCreated);
  const ownerEditedReply = await request(ownerToken, `/${ownerReplyCreated.id}`, { method: 'PATCH', body: JSON.stringify({ body: 'Edited reply from the owner' }) });
  assert.equal(ownerEditedReply.status, 200, 'a super-admin can edit their own sent message');
  const adminInbox = await request(adminToken);
  const adminMessages = (await adminInbox.json()).messages;
  const ownerReplyMessage = adminMessages.find((message) => message.body === 'Edited reply from the owner');
  assert.equal(ownerReplyMessage?.replyAllowed, 0);

  const edited = await request(adminToken, `/${sentMessage.id}`, { method: 'PATCH', body: JSON.stringify({ body: 'Corrected message' }) });
  assert.equal(edited.status, 200);
  assert.equal((await edited.json()).message.body, 'Corrected message');

  const newMessage = await request(adminToken, '', { method: 'POST', body: JSON.stringify({ body: 'A new message to the owner', recipientOwnerId: ownerId }) });
  assert.equal(newMessage.status, 201, 'a message-level reply restriction should not block starting a new message');
  const newMessageId = (await newMessage.json()).message.id;
  const react = await request(ownerToken, `/${newMessageId}/reactions`, { method: 'POST', body: JSON.stringify({ emoji: '👍' }) });
  assert.equal(react.status, 200);
  assert.deepEqual((await react.json()).reactions, [{ emoji: '👍', count: 1, reacted: true }]);
  const pinned = await request(ownerToken, `/${newMessageId}/flags`, {
    method: 'POST', body: JSON.stringify({ flag: 'pin', enabled: true })
  });
  assert.equal((await pinned.json()).isPinned, true);
  const reactionVisibleToAdmin = await request(adminToken);
  const reactedMessage = (await reactionVisibleToAdmin.json()).messages.find((message) => message.id === newMessageId);
  assert.deepEqual(reactedMessage.reactions, [{ emoji: '👍', count: 1, reacted: false }]);
  assert.equal(reactedMessage.isPinned, false, 'pin state is private to the admin who set it');
  const quotedOwnerReply = await request(ownerToken, '', { method: 'POST', body: JSON.stringify({ body: 'A quoted reply from the owner', adminId, replyToMessageId: newMessageId }) });
  assert.equal(quotedOwnerReply.status, 201);
  const quotedAdminInbox = await request(adminToken);
  assert.ok((await quotedAdminInbox.json()).messages.some((message) => message.body === 'A quoted reply from the owner' && message.replyToMessageId === newMessageId));
  const blockedSpecificReply = await request(adminToken, '', { method: 'POST', body: JSON.stringify({ body: 'Reply to the restricted message', recipientOwnerId: ownerId, replyToMessageId: ownerReplyMessage.id }) });
  assert.equal(blockedSpecificReply.status, 403, 'the reply action must still respect the selected message permission');
  const adminInboxRemoval = await request(adminToken, '/bulk-clear', {
    method: 'DELETE',
    body: JSON.stringify({ ids: [ownerReplyMessage.id], confirmation: 'DELETE' })
  });
  assert.equal(adminInboxRemoval.status, 200, 'the normal-admin Manage action removes selected received messages from that inbox');
  assert.equal((await (await request(adminToken)).json()).messages.find((message) => message.id === ownerReplyMessage.id).isHidden, 1, 'the received message is hidden in the admin inbox');
  assert.ok((await (await request(ownerToken)).json()).messages.some((message) => message.id === ownerReplyMessage.id), 'removing a received message does not delete it for its sender');
  const permanentlyRemovedFromInbox = await request(adminToken, `/${ownerReplyMessage.id}`, { method: 'DELETE' });
  assert.equal(permanentlyRemovedFromInbox.status, 200);
  assert.ok(!(await (await request(adminToken)).json()).messages.some((message) => message.id === ownerReplyMessage.id), 'a hidden message can be permanently removed from the current inbox');

  database.prepare('UPDATE platform_message_threads SET reply_allowed = 0 WHERE admin_user_id = ?').run(adminId);
  const denied = await request(adminToken, '', { method: 'POST', body: JSON.stringify({ body: 'This should be blocked', recipientOwnerId: ownerId }) });
  assert.equal(denied.status, 403);

  const cleared = await request(adminToken, `/${sentMessage.id}`, { method: 'DELETE' });
  assert.equal(cleared.status, 200);
  assert.equal((await cleared.json()).permanentlyDeleted, true);
  const ownerInboxAfterDelete = await request(ownerToken);
  assert.ok(!(await ownerInboxAfterDelete.json()).messages.some((message) => message.id === sentMessage.id), 'sender deletion removes the message from every participant inbox');
  database.prepare('UPDATE platform_message_threads SET reply_allowed = 1 WHERE admin_user_id = ?').run(adminId);
  const bulkSent = await request(adminToken, '', { method: 'POST', body: JSON.stringify({ body: 'Bulk delete this message', recipientOwnerId: ownerId }) });
  const bulkMessageId = (await bulkSent.json()).message.id;
  const bulkDeleted = await request(adminToken, '/bulk-clear-permanent', {
    method: 'DELETE', body: JSON.stringify({ ids: [bulkMessageId] })
  });
  assert.equal(bulkDeleted.status, 200, 'a normal admin can permanently delete their own sent message in bulk');
  assert.ok(!(await (await request(ownerToken)).json()).messages.some((message) => message.id === bulkMessageId));
});

test('public administrator chat is shared, records read state, and only lets senders edit or delete their messages', async () => {
  const sent = await request(adminToken, '/public', {
    method: 'POST',
    body: JSON.stringify({ body: 'Message for the shared admin room' })
  });
  assert.equal(sent.status, 201);
  const publicMessage = (await sent.json()).message;
  assert.equal(publicMessage.senderId, adminId);

  const ownerInbox = await request(ownerToken, '/public');
  assert.equal(ownerInbox.status, 200);
  const ownerMessage = (await ownerInbox.json()).messages.find((message) => message.id === publicMessage.id);
  assert.equal(ownerMessage.senderName, 'Customer Admin');
  assert.equal(ownerMessage.senderRole, 'portfolio_owner');
  assert.equal(Boolean(ownerMessage.isRead), false);

  const markedRead = await request(ownerToken, '/public/read', { method: 'POST', body: '{}' });
  assert.equal(markedRead.status, 200);
  const readInbox = await request(ownerToken, '/public');
  assert.equal(Boolean((await readInbox.json()).messages.find((message) => message.id === publicMessage.id).isRead), true);

  const deniedEdit = await request(ownerToken, `/public/${publicMessage.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ body: 'Not allowed to edit another admin message' })
  });
  assert.equal(deniedEdit.status, 404);

  const edited = await request(adminToken, `/public/${publicMessage.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ body: 'Edited shared-room message' })
  });
  assert.equal(edited.status, 200);
  assert.equal((await edited.json()).message.body, 'Edited shared-room message');

  const deniedDelete = await request(ownerToken, `/public/${publicMessage.id}`, { method: 'DELETE' });
  assert.equal(deniedDelete.status, 404);
  const deleted = await request(adminToken, `/public/${publicMessage.id}`, { method: 'DELETE' });
  assert.equal(deleted.status, 200);
  const finalInbox = await request(ownerToken, '/public');
  assert.ok((await finalInbox.json()).messages.find((message) => message.id === publicMessage.id).deletedAt);
});

test('visitor contact enquiries show in the inbox, can be resolved, and can be removed', async () => {
  const contactId = database.prepare(`INSERT INTO contact_messages (name, email, phone, message, created_at)
    VALUES ('Portfolio Visitor', 'visitor@example.com', '+15551234567', 'I would like to discuss a project.', ?)`).run(new Date().toISOString()).lastInsertRowid;
  const unread = await request(adminToken, '/unread-count');
  assert.equal((await unread.json()).visitorCount, 1);
  const inbox = await request(adminToken, '/visitors');
  assert.equal(inbox.status, 200);
  const inboxResult = await inbox.json();
  assert.equal(inboxResult.unreadCount, 1);
  assert.equal(inboxResult.conversations[0].id, contactId);
  assert.equal(Boolean(inboxResult.conversations[0].isRead), false);
  const ownerInbox = await request(ownerToken, '/visitors');
  assert.ok((await ownerInbox.json()).conversations.some((conversation) => conversation.id === contactId), 'contact conversations are shared across admin accounts');

  const reacted = await request(adminToken, `/visitors/${contactId}/reactions`, { method: 'POST', body: JSON.stringify({ emoji: '❤️' })   });

  assert.deepEqual((await reacted.json()).reactions, [{ emoji: '❤️', count: 1, reacted: true }]);
  const ownerView = await request(ownerToken, '/visitors');
  const ownerConversation = (await ownerView.json()).conversations.find((conversation) => conversation.id === contactId);
  assert.deepEqual(ownerConversation.reactions, [{ emoji: '❤️', count: 1, reacted: false }]);
  const markedRead = await request(adminToken, `/visitors/${contactId}/read`, { method: 'POST' });
  assert.equal(markedRead.status, 200);
  const readInbox = await request(adminToken, '/visitors');
  assert.equal((await readInbox.json()).unreadCount, 0);
  assert.equal((await request(ownerToken, '/visitors').then((response) => response.json())).unreadCount, 1, 'reading a visitor message does not clear another admin account unread badge');

  const ownedReplyId = database.prepare(`INSERT INTO contact_message_replies (contact_message_id, admin_user_id, body)
    VALUES (?, ?, 'Sent reply')`).run(contactId, adminId).lastInsertRowid;
  const otherReplyId = database.prepare(`INSERT INTO contact_message_replies (contact_message_id, admin_user_id, body)
    VALUES (?, ?, 'Another admin reply')`).run(contactId, ownerId).lastInsertRowid;
  const replyReaction = await request(adminToken, `/visitors/${contactId}/replies/${ownedReplyId}/reactions`, {
    method: 'POST', body: JSON.stringify({ emoji: '😂' })
  });
  assert.deepEqual((await replyReaction.json()).reactions, [{ emoji: '😂', count: 1, reacted: true }]);
  const editedReply = await request(adminToken, `/visitors/${contactId}/replies/${ownedReplyId}`, {
    method: 'PATCH', body: JSON.stringify({ body: 'Edited saved reply' })
  });
  assert.equal(editedReply.status, 200);
  const deniedReplyEdit = await request(adminToken, `/visitors/${contactId}/replies/${otherReplyId}`, {
    method: 'PATCH', body: JSON.stringify({ body: 'Must not change another admin reply' })
  });
  assert.equal(deniedReplyEdit.status, 404);
  const removedReply = await request(adminToken, `/visitors/${contactId}/replies/${ownedReplyId}`, { method: 'DELETE' });
  assert.equal(removedReply.status, 200);
  assert.match((await removedReply.json()).message, /cannot be recalled/);

  const resolved = await request(adminToken, `/visitors/${contactId}/status`, { method: 'PATCH', body: JSON.stringify({ status: 'resolved' }) });
  assert.equal(resolved.status, 200);
  assert.equal(database.prepare('SELECT status FROM contact_messages WHERE id = ?').get(contactId).status, 'resolved');

  const deleted = await request(adminToken, `/visitors/${contactId}`, { method: 'DELETE' });
  assert.equal(deleted.status, 200);
  assert.ok(database.prepare('SELECT deleted_at FROM contact_messages WHERE id = ?').get(contactId).deleted_at);
});

test('only a super-admin can permanently clear all admin chat history with explicit confirmation', async () => {
  const denied = await request(adminToken, '/clear-all', { method: 'DELETE', body: JSON.stringify({ confirmation: 'DELETE' }) });
  assert.equal(denied.status, 403);
  const unconfirmed = await request(ownerToken, '/clear-all', { method: 'DELETE', body: JSON.stringify({}) });
  assert.equal(unconfirmed.status, 400);
  assert.ok(database.prepare('SELECT COUNT(*) AS count FROM platform_messages').get().count > 0);
  assert.ok(database.prepare('SELECT COUNT(*) AS count FROM admin_public_messages').get().count > 0);

  const cleared = await request(ownerToken, '/clear-all', { method: 'DELETE', body: JSON.stringify({ confirmation: 'DELETE' }) });
  assert.equal(cleared.status, 200);
  assert.ok((await cleared.json()).cleared > 0);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM platform_messages').get().count, 0);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM admin_public_messages').get().count, 0);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM platform_message_attachments WHERE message_id IS NOT NULL OR message_group_id IS NOT NULL OR public_message_id IS NOT NULL').get().count, 0);
});
