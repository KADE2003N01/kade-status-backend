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

  const ownerReply = await request(ownerToken, '', { method: 'POST', body: JSON.stringify({ body: 'Reply from the owner', adminId, allowMessageReplies: false }) });
  assert.equal(ownerReply.status, 201);
  await ownerReply.json();
  const adminInbox = await request(adminToken);
  const adminMessages = (await adminInbox.json()).messages;
  const ownerReplyMessage = adminMessages.find((message) => message.body === 'Reply from the owner');
  assert.equal(ownerReplyMessage?.replyAllowed, 0);

  const edited = await request(adminToken, `/${sentMessage.id}`, { method: 'PATCH', body: JSON.stringify({ body: 'Corrected message' }) });
  assert.equal(edited.status, 200);
  assert.equal((await edited.json()).message.body, 'Corrected message');

  const newMessage = await request(adminToken, '', { method: 'POST', body: JSON.stringify({ body: 'A new message to the owner', recipientOwnerId: ownerId }) });
  assert.equal(newMessage.status, 201, 'a message-level reply restriction should not block starting a new message');
  const blockedSpecificReply = await request(adminToken, '', { method: 'POST', body: JSON.stringify({ body: 'Reply to the restricted message', recipientOwnerId: ownerId, replyToMessageId: ownerReplyMessage.id }) });
  assert.equal(blockedSpecificReply.status, 403, 'the reply action must still respect the selected message permission');

  database.prepare('UPDATE platform_message_threads SET reply_allowed = 0 WHERE admin_user_id = ?').run(adminId);
  const denied = await request(adminToken, '', { method: 'POST', body: JSON.stringify({ body: 'This should be blocked', recipientOwnerId: ownerId }) });
  assert.equal(denied.status, 403);

  const cleared = await request(adminToken, `/${sentMessage.id}`, { method: 'DELETE' });
  assert.equal(cleared.status, 200);
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

  const resolved = await request(adminToken, `/visitors/${contactId}/status`, { method: 'PATCH', body: JSON.stringify({ status: 'resolved' }) });
  assert.equal(resolved.status, 200);
  assert.equal(database.prepare('SELECT status FROM contact_messages WHERE id = ?').get(contactId).status, 'resolved');

  const deleted = await request(adminToken, `/visitors/${contactId}`, { method: 'DELETE' });
  assert.equal(deleted.status, 200);
  assert.ok(database.prepare('SELECT deleted_at FROM contact_messages WHERE id = ?').get(contactId).deleted_at);
});
