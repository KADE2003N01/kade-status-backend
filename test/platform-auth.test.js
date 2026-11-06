import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { after, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import bcrypt from 'bcryptjs';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'kade-platform-auth-test-'));
process.env.DATABASE_PATH = path.join(temporaryDirectory, 'portfolio.sqlite');
process.env.STORAGE_DIR = path.join(temporaryDirectory, 'storage');
process.env.ADMIN_EMAIL = '';
process.env.ADMIN_PASSWORD = '';
process.env.ADMIN_DISPLAY_NAME = '';
process.env.ADMIN_EMAIL_2 = '';
process.env.ADMIN_PASSWORD_2 = '';
process.env.ADMIN_DISPLAY_NAME_2 = '';
process.env.SUPER_ADMIN_EMAIL = '';
process.env.SUPER_ADMIN_PASSWORD = '';
process.env.SUPER_ADMIN_DISPLAY_NAME = '';
process.env.FRONTEND_URL = 'http://localhost:5173';
process.env.NODE_ENV = 'test';
process.env.EMAIL_USER = '';
process.env.EMAIL_PASSWORD = '';

const [{ default: app }, { default: database }] = await Promise.all([
  import('../app.js'),
  import('../src/database/platform-database.js')
]);
const server = app.listen(0);
await new Promise((resolve) => server.once('listening', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const headers = {
  Origin: 'http://localhost:5173',
  'Content-Type': 'application/json'
};
const password = 'Correct-Horse-Battery-1';
let sessionCookie;

async function post(pathname, body, cookie) {
  return fetch(`${baseUrl}/api/platform-auth/${pathname}`, {
    method: 'POST',
    headers: { ...headers, ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body)
  });
}

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  database.close();
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

test('signup validates account input and reports missing email configuration', async () => {
  const invalid = await post('signup', {
    email: 'not-an-email',
    displayName: 'Test User',
    password
  });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error, 'Request validation failed.');

  const unavailable = await post('signup', {
    email: 'new-user@example.com',
    displayName: 'Test User',
    password
  });
  assert.equal(unavailable.status, 503);
  assert.equal(database.prepare('SELECT id FROM users WHERE email = ?').get('new-user@example.com'), undefined);
});

test('email verification, login, protected account access, and logout work', async () => {
  const passwordHash = await bcrypt.hash(password, 4);
  const userId = database.prepare(`
    INSERT INTO users (email, display_name, password_hash)
    VALUES (?, ?, ?)
  `).run('customer@example.com', 'Test Customer', passwordHash).lastInsertRowid;
  const token = randomBytes(32).toString('hex');
  const tokenHash = createHash('sha256').update(token).digest('hex');
  database.prepare(`
    INSERT INTO email_verifications (token_hash, user_id, expires_at, created_at)
    VALUES (?, ?, ?, ?)
  `).run(tokenHash, userId, Date.now() + 60_000, Date.now());

  const verified = await post('verify-email', { token });
  assert.equal(verified.status, 200);
  assert.equal(database.prepare('SELECT status FROM users WHERE id = ?').get(userId).status, 'active');
  assert.equal(database.prepare('SELECT token_hash FROM email_verifications WHERE user_id = ?').get(userId), undefined);

  const login = await post('login', { email: 'CUSTOMER@example.com', password });
  assert.equal(login.status, 200);
  sessionCookie = login.headers.get('set-cookie').split(';', 1)[0];
  assert.match(sessionCookie, /^kade_platform_session=/);

  const me = await fetch(`${baseUrl}/api/platform-auth/me`, {
    headers: { Origin: headers.Origin, Cookie: sessionCookie }
  });
  assert.equal(me.status, 200);
  const accountUser = (await me.json()).user;
  assert.deepEqual({
    id: accountUser.id,
    email: accountUser.email,
    displayName: accountUser.displayName,
    role: accountUser.role,
    subscriptionPlan: accountUser.subscriptionPlan,
    accountPages: accountUser.accountPages
  }, {
    id: userId,
    email: 'customer@example.com',
    displayName: 'Test Customer',
    role: 'customer',
    subscriptionPlan: 'free',
    accountPages: ['overview', 'profile', 'security', 'subscription', 'benefits', 'settings', 'support']
  });

  const openRequestId = database.prepare(`INSERT INTO admin_support_requests (name, email, category, message)
    VALUES (?, ?, ?, ?)`).run('Test Customer', 'customer@example.com', 'platform_other', 'An open support request').lastInsertRowid;
  database.prepare(`INSERT INTO admin_support_requests (name, email, category, message, status, resolved_at)
    VALUES (?, ?, ?, ?, 'resolved', CURRENT_TIMESTAMP)`).run('Test Customer', 'customer@example.com', 'platform_subscription', 'A resolved support request');
  database.prepare(`INSERT INTO admin_support_requests (name, email, category, message, deleted_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)`).run('Test Customer', 'customer@example.com', 'platform_other', 'A deleted support request');
  database.prepare(`INSERT INTO admin_support_requests (name, email, category, message)
    VALUES (?, ?, ?, ?)`).run('Another Customer', 'other@example.com', 'platform_other', 'Another customer request');
  database.prepare(`INSERT INTO admin_support_request_responses (request_id, body)
    VALUES (?, ?)`).run(openRequestId, 'We are looking into this.');

  const supportHistory = await fetch(`${baseUrl}/api/support-requests`, {
    headers: { Origin: headers.Origin, Cookie: sessionCookie }
  });
  assert.equal(supportHistory.status, 200);
  const historyRequests = (await supportHistory.json()).requests;
  assert.equal(historyRequests.length, 2);
  assert.deepEqual(historyRequests.find((request) => request.id === openRequestId).responses.map((response) => response.body), ['We are looking into this.']);

  const ownerId = database.prepare(`INSERT INTO admin_users (email, display_name, password_hash, role, roles_json, status)
    VALUES (?, ?, ?, 'platform_owner', '["platform_owner"]', 'active')`).run('owner@example.com', 'Platform Owner', 'test-hash').lastInsertRowid;
  const ownerToken = randomBytes(32).toString('hex');
  database.prepare('INSERT INTO admin_sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .run(createHash('sha256').update(ownerToken).digest('hex'), ownerId, Date.now() + 60_000, Date.now());
  const ownerHeaders = { Origin: headers.Origin, Cookie: `kade_admin_session=${ownerToken}`, 'Content-Type': 'application/json' };
  const defaultPlans = {
    free: ['overview', 'profile', 'security', 'subscription', 'benefits', 'settings', 'support'],
    standard: ['overview', 'profile', 'security', 'subscription', 'benefits', 'settings', 'support', 'gallery'],
    professional: ['overview', 'profile', 'security', 'subscription', 'benefits', 'chat', 'settings', 'support', 'support-chat', 'gallery']
  };
  const planAccessResponse = await fetch(`${baseUrl}/api/platform-owner/account-page-access`, { headers: ownerHeaders });
  assert.equal(planAccessResponse.status, 200);
  assert.deepEqual((await planAccessResponse.json()).plans, defaultPlans);
  const customerWorkspaceUrl = `${baseUrl}/api/customer-workspace`;
  const customerHeaders = { Origin: headers.Origin, Cookie: sessionCookie };
  const restrictedSupportChat = await fetch(`${customerWorkspaceUrl}/support-chat`, { headers: customerHeaders });
  assert.equal(restrictedSupportChat.status, 403);
  const supportChatEnabledPlans = {
    ...defaultPlans,
    free: [...defaultPlans.free, 'support-chat']
  };
  const enableSupportChat = await fetch(`${baseUrl}/api/platform-owner/account-page-access`, {
    method: 'PUT',
    headers: ownerHeaders,
    body: JSON.stringify({ plans: supportChatEnabledPlans })
  });
  assert.equal(enableSupportChat.status, 200);
  const sendSupportChatMessage = await fetch(`${customerWorkspaceUrl}/support-chat`, {
    method: 'POST',
    headers: { ...customerHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: 'Hello from the dedicated support room.' })
  });
  assert.equal(sendSupportChatMessage.status, 201);
  const firstChatMessage = (await sendSupportChatMessage.json()).message;
  assert.equal(firstChatMessage.senderRole, 'customer');
  const supportChatHistory = await fetch(`${customerWorkspaceUrl}/support-chat`, { headers: customerHeaders });
  assert.equal(supportChatHistory.status, 200);
  assert.equal((await supportChatHistory.json()).messages[0].body, 'Hello from the dedicated support room.');
  const customerReaction = await fetch(`${customerWorkspaceUrl}/support-chat/${firstChatMessage.id}/reactions`, {
    method: 'POST',
    headers: { ...customerHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ emoji: '❤️' })
  });
  assert.equal(customerReaction.status, 200);
  assert.equal((await customerReaction.json()).reactions[0].reacted, true);
  const customerPin = await fetch(`${customerWorkspaceUrl}/support-chat/${firstChatMessage.id}/flags`, {
    method: 'POST',
    headers: { ...customerHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ flag: 'pin', enabled: true })
  });
  assert.equal(customerPin.status, 200);
  assert.equal((await customerPin.json()).isPinned, true);
  const ownerChat = await fetch(`${baseUrl}/api/platform-owner/customer-chat/${userId}`, { headers: ownerHeaders });
  assert.equal(ownerChat.status, 200);
  const ownerMessages = (await ownerChat.json()).messages;
  assert.equal(ownerMessages[0].reactions[0].reacted, false);
  assert.equal(ownerMessages[0].isPinned, false);
  assert.equal(ownerMessages[0].isRead, true);
  const ownerStar = await fetch(`${baseUrl}/api/platform-owner/customer-chat/${userId}/${firstChatMessage.id}/flags`, {
    method: 'POST',
    headers: ownerHeaders,
    body: JSON.stringify({ flag: 'star', enabled: true })
  });
  assert.equal(ownerStar.status, 200);
  assert.equal((await ownerStar.json()).isStarred, true);
  const ownerReplyResponse = await fetch(`${baseUrl}/api/platform-owner/customer-chat/${userId}`, {
    method: 'POST',
    headers: ownerHeaders,
    body: JSON.stringify({ body: 'We are here to help.', replyToMessageId: firstChatMessage.id })
  });
  assert.equal(ownerReplyResponse.status, 201);
  const ownerReply = (await ownerReplyResponse.json()).message;
  assert.equal(ownerReply.replyToMessageId, firstChatMessage.id);
  const ownerReactionResponse = await fetch(`${baseUrl}/api/platform-owner/customer-chat/${userId}/${firstChatMessage.id}/reactions`, {
    method: 'POST',
    headers: ownerHeaders,
    body: JSON.stringify({ emoji: '👍' })
  });
  assert.equal(ownerReactionResponse.status, 200);
  assert.equal((await ownerReactionResponse.json()).reactions.length, 2);
  const customerChatWithReply = await fetch(`${customerWorkspaceUrl}/support-chat`, { headers: customerHeaders });
  const customerMessages = (await customerChatWithReply.json()).messages;
  assert.equal(customerMessages[1].isRead, true);
  assert.equal(customerMessages[1].replyToBody, 'Hello from the dedicated support room.');
  assert.equal(customerMessages[0].reactions.some((reaction) => reaction.reacted), true);
  assert.equal(customerMessages[0].isPinned, true);
  assert.equal(customerMessages[0].isStarred, false);
  const editedCustomerMessage = await fetch(`${customerWorkspaceUrl}/support-chat/${firstChatMessage.id}`, {
    method: 'PATCH',
    headers: { ...customerHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: 'Updated: I need help with my account.' })
  });
  assert.equal(editedCustomerMessage.status, 200);
  assert.ok((await editedCustomerMessage.json()).message.editedAt);
  const ownerCantEditCustomerMessage = await fetch(`${baseUrl}/api/platform-owner/customer-chat/${userId}/${firstChatMessage.id}`, {
    method: 'PATCH',
    headers: ownerHeaders,
    body: JSON.stringify({ body: 'Not an owner message.' })
  });
  assert.equal(ownerCantEditCustomerMessage.status, 404);
  const customerAttachmentUpload = await fetch(`${customerWorkspaceUrl}/support-chat/attachments`, {
    method: 'POST',
    headers: { ...customerHeaders, 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent('test.png'), 'X-File-Type': 'image/png' },
    body: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0])
  });
  assert.equal(customerAttachmentUpload.status, 201);
  const uploadedAttachment = (await customerAttachmentUpload.json()).attachment;
  const attachmentMessageResponse = await fetch(`${customerWorkspaceUrl}/support-chat`, {
    method: 'POST',
    headers: { ...customerHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: '', attachmentIds: [uploadedAttachment.id] })
  });
  assert.equal(attachmentMessageResponse.status, 201);
  const ownerAttachmentHistory = await fetch(`${baseUrl}/api/platform-owner/customer-chat/${userId}`, { headers: ownerHeaders });
  const ownerAttachmentMessage = (await ownerAttachmentHistory.json()).messages.at(-1);
  assert.equal(ownerAttachmentMessage.attachments[0].name, 'test.png');
  const readCustomerAttachment = await fetch(`${baseUrl}/api${ownerAttachmentMessage.attachments[0].url}`, { headers: ownerHeaders });
  assert.equal(readCustomerAttachment.status, 200);
  assert.equal(readCustomerAttachment.headers.get('content-type'), 'image/png');
  const ownerAttachmentUpload = await fetch(`${baseUrl}/api/platform-owner/customer-chat/${userId}/attachments`, {
    method: 'POST',
    headers: { ...ownerHeaders, 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent('owner.png'), 'X-File-Type': 'image/png' },
    body: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0])
  });
  assert.equal(ownerAttachmentUpload.status, 201);
  const ownerAttachment = (await ownerAttachmentUpload.json()).attachment;
  const ownerAttachmentMessageResponse = await fetch(`${baseUrl}/api/platform-owner/customer-chat/${userId}`, {
    method: 'POST',
    headers: ownerHeaders,
    body: JSON.stringify({ body: '', attachmentIds: [ownerAttachment.id] })
  });
  assert.equal(ownerAttachmentMessageResponse.status, 201);
  const customerAttachmentHistory = await fetch(`${customerWorkspaceUrl}/support-chat`, { headers: customerHeaders });
  const customerAttachmentMessage = (await customerAttachmentHistory.json()).messages.at(-1);
  assert.equal(customerAttachmentMessage.senderRole, 'platform_owner');
  assert.equal(customerAttachmentMessage.attachments[0].name, 'owner.png');
  const readOwnerAttachment = await fetch(`${baseUrl}/api${customerAttachmentMessage.attachments[0].url}`, { headers: customerHeaders });
  assert.equal(readOwnerAttachment.status, 200);
  const editOwnerReply = await fetch(`${baseUrl}/api/platform-owner/customer-chat/${userId}/${ownerReply.id}`, {
    method: 'PATCH',
    headers: ownerHeaders,
    body: JSON.stringify({ body: 'We are here to help and have updated the reply.' })
  });
  assert.equal(editOwnerReply.status, 200);
  const customerCannotEditOwnerReply = await fetch(`${customerWorkspaceUrl}/support-chat/${ownerReply.id}`, {
    method: 'PATCH',
    headers: { ...customerHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: 'Not a customer message.' })
  });
  assert.equal(customerCannotEditOwnerReply.status, 404);
  const deleteOwnerReply = await fetch(`${baseUrl}/api/platform-owner/customer-chat/${userId}/${ownerReply.id}`, {
    method: 'DELETE',
    headers: ownerHeaders
  });
  assert.equal(deleteOwnerReply.status, 200);
  assert.ok((await deleteOwnerReply.json()).message.deletedAt);
  const removeCustomerMessage = await fetch(`${customerWorkspaceUrl}/support-chat/${firstChatMessage.id}`, {
    method: 'DELETE',
    headers: customerHeaders
  });
  assert.equal(removeCustomerMessage.status, 200);
  assert.ok((await removeCustomerMessage.json()).message.deletedAt);
  const disabledGeneralChat = await fetch(`${customerWorkspaceUrl}/chat`, { headers: customerHeaders });
  assert.equal(disabledGeneralChat.status, 403);
  const invalidPlanAccess = await fetch(`${baseUrl}/api/platform-owner/account-page-access`, {
    method: 'PUT',
    headers: ownerHeaders,
    body: JSON.stringify({ plans: { ...defaultPlans, free: ['profile'] } })
  });
  assert.equal(invalidPlanAccess.status, 400);
  const updatedPlans = { ...defaultPlans, free: defaultPlans.free.filter((page) => page !== 'support') };
  const savePlanAccess = await fetch(`${baseUrl}/api/platform-owner/account-page-access`, {
    method: 'PUT',
    headers: ownerHeaders,
    body: JSON.stringify({ plans: updatedPlans })
  });
  assert.equal(savePlanAccess.status, 200);
  assert.deepEqual((await savePlanAccess.json()).plans, updatedPlans);
  assert.equal(database.prepare("SELECT action FROM platform_admin_audit WHERE action = 'account_page_access_updated'").get()?.action, 'account_page_access_updated');
  const disabledSupportHistory = await fetch(`${baseUrl}/api/support-requests`, {
    headers: { Origin: headers.Origin, Cookie: sessionCookie }
  });
  assert.equal(disabledSupportHistory.status, 403);

  const adminRoute = await fetch(`${baseUrl}/api/auth/admin-users`, {
    headers: { Origin: headers.Origin, Cookie: sessionCookie }
  });
  assert.equal(adminRoute.status, 403);

  const logout = await post('logout', {}, sessionCookie);
  assert.equal(logout.status, 200);
  assert.equal(database.prepare('SELECT token_hash FROM sessions WHERE user_id = ?').get(userId), undefined);
  const expiredSession = await fetch(`${baseUrl}/api/platform-auth/me`, {
    headers: { Origin: headers.Origin, Cookie: sessionCookie }
  });
  assert.equal(expiredSession.status, 401);
});

test('password reset is one-use and revokes existing sessions', async () => {
  const user = database.prepare('SELECT id FROM users WHERE email = ?').get('customer@example.com');
  const token = randomBytes(32).toString('hex');
  database.prepare(`
    INSERT INTO password_resets (token_hash, user_id, expires_at, created_at)
    VALUES (?, ?, ?, ?)
  `).run(createHash('sha256').update(token).digest('hex'), user.id, Date.now() + 60_000, Date.now());
  database.prepare(`
    INSERT INTO sessions (token_hash, user_id, expires_at, created_at)
    VALUES (?, ?, ?, ?)
  `).run('existing-session-hash', user.id, Date.now() + 60_000, Date.now());

  const reset = await post('reset-password', {
    token,
    password: 'New-Correct-Horse-Battery-2'
  });
  assert.equal(reset.status, 200);
  assert.equal(database.prepare('SELECT token_hash FROM sessions WHERE user_id = ?').get(user.id), undefined);
  assert.equal(database.prepare('SELECT token_hash FROM password_resets WHERE user_id = ?').get(user.id), undefined);

  const oldPassword = await post('login', { email: 'customer@example.com', password });
  assert.equal(oldPassword.status, 401);
  const newPassword = await post('login', {
    email: 'customer@example.com',
    password: 'New-Correct-Horse-Battery-2'
  });
  assert.equal(newPassword.status, 200);
});

test('forgot-password does not falsely succeed when email delivery is unavailable', async () => {
  const response = await post('forgot-password', { email: 'customer@example.com' });
  assert.equal(response.status, 503);
});
