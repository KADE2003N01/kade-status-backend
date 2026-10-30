import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, test } from 'node:test';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { defaultHomepageContent, validateHomepageContent } from '../src/config/homepage-content.js';

const databasePath = path.join(tmpdir(), `kade-auth-test-${process.pid}.sqlite`);
const storageDirectory = path.join(tmpdir(), `kade-auth-storage-${process.pid}`);
const ebcFixturePath = path.join(storageDirectory, 'private-documents', 'AGENDA_EBC 2026.pdf');
mkdirSync(path.dirname(ebcFixturePath), { recursive: true });
const ebcFixture = Buffer.alloc(4_000_001, 0x20);
ebcFixture.write('%PDF-1.7\n');
writeFileSync(ebcFixturePath, ebcFixture);
process.env.DATABASE_PATH = databasePath;
process.env.STORAGE_DIR = storageDirectory;
process.env.ADMIN_EMAIL = 'admin-test@example.com';
process.env.ADMIN_PASSWORD = 'test5';
process.env.ADMIN_DISPLAY_NAME = 'Database Test Admin';
process.env.FRONTEND_URL = 'http://localhost:5500,https://david-portifolio.onrender.com';
process.env.NODE_ENV = 'test';
process.env.EMAIL_USER = '';
process.env.EMAIL_PASSWORD = '';
process.env.DOWNLOAD_VERIFICATION_TEST_CODE = '246810';
process.env.PUBLIC_API_URL = 'http://localhost:5000';

const [{ default: app }, { default: database }] = await Promise.all([
  import('../app.js'),
  import('../src/database/database.js')
]);
const server = app.listen(0);
await new Promise((resolve) => server.once('listening', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const requestOptions = {
  headers: { Origin: 'http://localhost:5500', 'Content-Type': 'application/json' }
};

async function startDownloadVerification(details) {
  const response = await fetch(`${baseUrl}/api/downloads/request`, {
    ...requestOptions,
    method: 'POST',
    body: JSON.stringify({ ...details, channel: details.channel || 'email' })
  });
  const result = await response.json();
  assert.equal(response.status, 201);
  assert.ok(result.challengeId);
  assert.equal(result.downloadToken, undefined);
  return result;
}

async function completeDownloadVerification(challengeId, code = process.env.DOWNLOAD_VERIFICATION_TEST_CODE) {
  return fetch(`${baseUrl}/api/downloads/verify`, {
    ...requestOptions,
    method: 'POST',
    body: JSON.stringify({ challengeId, code })
  });
}

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  const uploadedFiles = database.prepare(`
    SELECT stored_filename FROM portfolio_documents
    WHERE stored_filename LIKE 'cv-%' OR stored_filename LIKE 'certificate-%'
  `).all();
  for (const file of uploadedFiles) {
    const filePath = path.join(storageDirectory, 'private-documents', file.stored_filename);
    if (existsSync(filePath)) unlinkSync(filePath);
  }
  const homepageRow = database.prepare("SELECT value_json FROM portfolio_settings WHERE setting_key = 'homepage'").get();
  const imageFilename = homepageRow?.value_json.match(/profile-[0-9a-f-]{36}\.(?:jpg|png|webp)/)?.[0];
  if (imageFilename) {
    const imagePath = path.join(storageDirectory, 'profile-images', imageFilename);
    if (existsSync(imagePath)) unlinkSync(imagePath);
  }
  database.close();
  if (existsSync(ebcFixturePath)) unlinkSync(ebcFixturePath);
  for (const suffix of ['', '-shm', '-wal']) {
    const filePath = `${databasePath}${suffix}`;
    if (existsSync(filePath)) unlinkSync(filePath);
  }
});

test('Vite frontend origin can make credentialed API requests', async () => {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'OPTIONS',
    headers: {
      Origin: 'http://127.0.0.1:5173',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type'
    }
  });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-origin'), 'http://127.0.0.1:5173');
  assert.equal(response.headers.get('access-control-allow-credentials'), 'true');
});

test('configured deployed frontend origin can make credentialed API requests', async () => {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'OPTIONS',
    headers: {
      Origin: 'https://david-portifolio.onrender.com',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type'
    }
  });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://david-portifolio.onrender.com');
  assert.equal(response.headers.get('access-control-allow-credentials'), 'true');
});

test('remember me issues a persistent 30-day session without storing a password', async () => {
  const startedAt = Date.now();
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    ...requestOptions,
    method: 'POST',
    body: JSON.stringify({
      email: 'admin-test@example.com',
      password: 'test5',
      rememberMe: true
    })
  });
  assert.equal(login.status, 200);
  const setCookie = login.headers.get('set-cookie');
  assert.match(setCookie, /max-age=2592000/i);
  const token = setCookie.split(';', 1)[0].split('=').slice(1).join('=');
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const session = database.prepare('SELECT expires_at FROM admin_sessions WHERE token_hash = ?').get(tokenHash);
  assert.ok(session.expires_at >= startedAt + 30 * 24 * 60 * 60 * 1000 - 1000);

  const currentUser = await fetch(`${baseUrl}/api/auth/me`, {
    headers: { ...requestOptions.headers, Cookie: setCookie.split(';', 1)[0] }
  });
  assert.equal(currentUser.status, 200);

  const logout = await fetch(`${baseUrl}/api/auth/logout`, {
    ...requestOptions,
    method: 'POST',
    headers: { ...requestOptions.headers, Cookie: setCookie.split(';', 1)[0] }
  });
  assert.equal(logout.status, 200);
});

test('public document previews require email verification', async () => {
  const directPreview = await fetch(`${baseUrl}/api/downloads/preview/cv`, {
    headers: { Origin: 'http://localhost:5500' }
  });
  assert.equal(directPreview.status, 404);

  const challenge = await startDownloadVerification({
    documentId: 'cv',
    name: 'Preview Visitor',
    email: 'verified-preview@example.com',
    reason: 'I need to review this document for a portfolio application.',
    purpose: 'preview',
    consent: true
  });
  const invalidAttempt = await completeDownloadVerification(challenge.challengeId, '000000');
  assert.equal(invalidAttempt.status, 400);

  const verification = await completeDownloadVerification(challenge.challengeId);
  assert.equal(verification.status, 201);
  const authorization = await verification.json();
  const preview = await fetch(`${baseUrl}/api/downloads/preview`, {
    ...requestOptions,
    method: 'POST',
    body: JSON.stringify({ token: authorization.downloadToken })
  });
  assert.equal(preview.status, 200);
  assert.match(preview.headers.get('content-disposition'), /^inline;/);
  assert.ok((await preview.arrayBuffer()).byteLength > 100_000);

  const reusedAuthorization = await fetch(`${baseUrl}/api/downloads/preview`, {
    ...requestOptions,
    method: 'POST',
    body: JSON.stringify({ token: authorization.downloadToken })
  });
  assert.equal(reusedAuthorization.status, 403);
});

test('homepage content accepts optional fields and defaults omitted fields', () => {
  const customHomepage = structuredClone(defaultHomepageContent);
  customHomepage.adminName = 'Portfolio Owner';
  customHomepage.adminNameCustom = true;
  customHomepage.footer.tagline = '';
  customHomepage.footer.socialLinks = [{ label: 'GitHub', href: 'https://github.com/example' }];
  customHomepage.unrecognizedLegacyField = 'ignored';
  delete customHomepage.hero.intro;
  const validatedHomepage = validateHomepageContent(customHomepage);
  assert.equal(validatedHomepage.adminName, 'Portfolio Owner');
  assert.equal(validatedHomepage.footer.tagline, '');
  assert.equal(validatedHomepage.footer.socialLinks[0].label, 'GitHub');
  assert.equal(validatedHomepage.footer.socialLinks[0].icon, 'fab fa-github');
  assert.equal(validatedHomepage.hero.intro, defaultHomepageContent.hero.intro);
  assert.equal(Object.hasOwn(validatedHomepage, 'unrecognizedLegacyField'), false);

  const emptyNameHomepage = structuredClone(customHomepage);
  emptyNameHomepage.adminName = '';
  emptyNameHomepage.adminNameCustom = false;
  assert.equal(validateHomepageContent(emptyNameHomepage).adminName, '');
});

test('admin can publish checkbox changes with blank and omitted fields', async () => {
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    ...requestOptions,
    method: 'POST',
    body: JSON.stringify({ email: 'admin-test@example.com', password: 'test5' })
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';', 1)[0];
  const partialHomepage = structuredClone(defaultHomepageContent);
  partialHomepage.introduction.visible = false;
  partialHomepage.footer.tagline = '';
  delete partialHomepage.hero.intro;
  partialHomepage.unrecognizedLegacyField = 'discard this legacy value';

  const publish = await fetch(`${baseUrl}/api/homepage`, {
    ...requestOptions,
    method: 'PUT',
    headers: { ...requestOptions.headers, Cookie: cookie },
    body: JSON.stringify({ content: partialHomepage })
  });
  assert.equal(publish.status, 200);
  const publishedHomepage = (await publish.json()).content;
  assert.equal(publishedHomepage.introduction.visible, false);
  assert.equal(publishedHomepage.footer.tagline, '');
  assert.equal(publishedHomepage.hero.intro, defaultHomepageContent.hero.intro);
  assert.equal(Object.hasOwn(publishedHomepage, 'unrecognizedLegacyField'), false);

  const reset = await fetch(`${baseUrl}/api/homepage/reset`, {
    ...requestOptions,
    method: 'POST',
    headers: { ...requestOptions.headers, Cookie: cookie }
  });
  assert.equal(reset.status, 200);
});

test('admin credentials issue a revocable session and the admin name comes from SQLite', async () => {
  const anonymous = await fetch(`${baseUrl}/api/auth/me`, requestOptions);
  assert.equal(anonymous.status, 401);

  const invalidLogin = await fetch(`${baseUrl}/api/auth/login`, {
    ...requestOptions,
    method: 'POST',
    body: JSON.stringify({ email: 'admin-test@example.com', password: 'incorrect-password' })
  });
  assert.equal(invalidLogin.status, 401);

  const bootstrapCredentials = ['ADMIN_EMAIL', 'ADMIN_PASSWORD', 'ADMIN_DISPLAY_NAME']
    .map((key) => [key, process.env[key]]);
  for (const [key] of bootstrapCredentials) delete process.env[key];
  let login;
  try {
    login = await fetch(`${baseUrl}/api/auth/login`, {
      ...requestOptions,
      method: 'POST',
      body: JSON.stringify({ email: 'admin-test@example.com', password: 'test5' })
    });
  } finally {
    for (const [key, value] of bootstrapCredentials) process.env[key] = value;
  }
  assert.equal(login.status, 200);
  assert.deepEqual((await login.clone().json()).user, {
    email: 'admin-test@example.com',
    displayName: 'Database Test Admin'
  });
  const cookieHeader = login.headers.get('set-cookie');
  assert.match(cookieHeader, /HttpOnly/i);
  assert.match(cookieHeader, /SameSite=Lax/i);
  const cookie = cookieHeader.split(';', 1)[0];

  const publicHomepage = await fetch(`${baseUrl}/api/homepage`, requestOptions);
  assert.equal(publicHomepage.status, 200);
  assert.equal((await publicHomepage.json()).content.hero.title, defaultHomepageContent.hero.title);

  const anonymousHomepageUpdate = await fetch(`${baseUrl}/api/homepage`, {
    ...requestOptions,
    method: 'PUT',
    body: JSON.stringify({ content: defaultHomepageContent })
  });
  assert.equal(anonymousHomepageUpdate.status, 401);

  const changedHomepage = structuredClone(defaultHomepageContent);
  changedHomepage.hero.title = 'Published landing page headline';
  changedHomepage.introduction.visible = false;
  changedHomepage.adminName = 'Portfolio Owner';
  changedHomepage.adminNameCustom = true;
  const homepageUpdate = await fetch(`${baseUrl}/api/homepage`, {
    ...requestOptions,
    method: 'PUT',
    headers: { ...requestOptions.headers, Cookie: cookie },
    body: JSON.stringify({ content: changedHomepage })
  });
  assert.equal(homepageUpdate.status, 200);
  const sharedHomepage = await fetch(`${baseUrl}/api/homepage`, requestOptions);
  const sharedContent = (await sharedHomepage.json()).content;
  assert.equal(sharedContent.hero.title, changedHomepage.hero.title);
  assert.equal(sharedContent.introduction.visible, false);
  assert.equal(sharedContent.adminName, 'Portfolio Owner');

  const subsequentLogin = await fetch(`${baseUrl}/api/auth/login`, {
    ...requestOptions,
    method: 'POST',
    body: JSON.stringify({ email: 'admin-test@example.com', password: 'test5' })
  });
  assert.equal(subsequentLogin.status, 200);
  const retainedAdminName = await fetch(`${baseUrl}/api/homepage`, requestOptions);
  assert.equal((await retainedAdminName.json()).content.adminName, 'Portfolio Owner');

  const emptyAdminName = structuredClone(changedHomepage);
  emptyAdminName.adminName = '';
  emptyAdminName.adminNameCustom = false;
  const invalidAdminNameUpdate = await fetch(`${baseUrl}/api/homepage`, {
    ...requestOptions,
    method: 'PUT',
    headers: { ...requestOptions.headers, Cookie: cookie },
    body: JSON.stringify({ content: emptyAdminName })
  });
  assert.equal(invalidAdminNameUpdate.status, 200);
  assert.equal((await invalidAdminNameUpdate.json()).content.adminName, '');

  const automaticAdminNameLogin = await fetch(`${baseUrl}/api/auth/login`, {
    ...requestOptions,
    method: 'POST',
    body: JSON.stringify({ email: 'admin-test@example.com', password: 'test5' })
  });
  assert.equal(automaticAdminNameLogin.status, 200);
  const automaticAdminName = await fetch(`${baseUrl}/api/homepage`, requestOptions);
  assert.equal((await automaticAdminName.json()).content.adminName, 'Database Test Admin');

  const unsafeHomepageUpdate = await fetch(`${baseUrl}/api/homepage`, {
    ...requestOptions,
    method: 'PUT',
    headers: { ...requestOptions.headers, Cookie: cookie },
    body: JSON.stringify({ content: { ...changedHomepage, brand: { ...changedHomepage.brand, imageUrl: 'javascript:alert(1)' } } })
  });
  assert.equal(unsafeHomepageUpdate.status, 400);

  const homepageReset = await fetch(`${baseUrl}/api/homepage/reset`, {
    ...requestOptions,
    method: 'POST',
    headers: { ...requestOptions.headers, Cookie: cookie }
  });
  assert.equal(homepageReset.status, 200);
  assert.equal((await homepageReset.json()).content.hero.title, defaultHomepageContent.hero.title);

  const profileImageBytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
    'base64'
  );
  const profileImageUpload = await fetch(`${baseUrl}/api/homepage/profile-image`, {
    ...requestOptions,
    method: 'POST',
    headers: { ...requestOptions.headers, Cookie: cookie },
    body: JSON.stringify({ image: `data:image/png;base64,${profileImageBytes.toString('base64')}` })
  });
  assert.equal(profileImageUpload.status, 201);
  const profileImage = await profileImageUpload.json();
  assert.match(profileImage.imageUrl, /^\/api\/homepage\/profile-image\//);
  assert.match(profileImage.imageUrl, /\/api\/homepage\/profile-image\/profile-[0-9a-f-]{36}\.png$/);
  const profileImageUrl = new URL(profileImage.imageUrl, baseUrl);
  const homepageWithProfileImage = await fetch(`${baseUrl}/api/homepage`, requestOptions);
  assert.equal((await homepageWithProfileImage.json()).content.brand.imageUrl, profileImage.imageUrl);
  const uploadedProfileImage = await fetch(profileImageUrl);
  assert.equal(uploadedProfileImage.status, 200);
  assert.equal(uploadedProfileImage.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await uploadedProfileImage.arrayBuffer()), profileImageBytes);
  const invalidProfileImage = await fetch(`${baseUrl}/api/homepage/profile-image`, {
    ...requestOptions,
    method: 'POST',
    headers: { ...requestOptions.headers, Cookie: cookie },
    body: JSON.stringify({ image: 'data:image/png;base64,bm90YW5pbWFnZQ==' })
  });
  assert.equal(invalidProfileImage.status, 400);
  const replacementProfileImage = await fetch(`${baseUrl}/api/homepage/profile-image`, {
    ...requestOptions,
    method: 'POST',
    headers: { ...requestOptions.headers, Cookie: cookie },
    body: JSON.stringify({ image: `data:image/png;base64,${profileImageBytes.toString('base64')}` })
  });
  assert.equal(replacementProfileImage.status, 201);
  assert.equal((await fetch(profileImageUrl)).status, 404);

  const authenticated = await fetch(`${baseUrl}/api/auth/me`, {
    headers: { ...requestOptions.headers, Cookie: cookie }
  });
  assert.equal(authenticated.status, 200);
  assert.equal((await authenticated.json()).user.displayName, 'Database Test Admin');

  database.prepare('UPDATE admin_users SET display_name = ?').run('Updated From Database');
  const refreshedProfile = await fetch(`${baseUrl}/api/auth/me`, {
    headers: { ...requestOptions.headers, Cookie: cookie }
  });
  assert.equal((await refreshedProfile.json()).user.displayName, 'Updated From Database');

  const anonymousDownloads = await fetch(`${baseUrl}/api/downloads`, requestOptions);
  assert.equal(anonymousDownloads.status, 401);
  const anonymousDelete = await fetch(`${baseUrl}/api/downloads/1`, {
    ...requestOptions,
    method: 'DELETE'
  });
  assert.equal(anonymousDelete.status, 401);

  const publicDocuments = await fetch(`${baseUrl}/api/documents`, requestOptions);
  assert.equal(publicDocuments.status, 200);
  assert.deepEqual((await publicDocuments.json()).documents.map((document) => document.documentId), ['cv', 'ebc']);

  const anonymousCvUpload = await fetch(`${baseUrl}/api/documents/cv`, {
    ...requestOptions,
    method: 'POST',
    body: JSON.stringify({})
  });
  assert.equal(anonymousCvUpload.status, 401);

  const anonymousProfileImageUpload = await fetch(`${baseUrl}/api/homepage/profile-image`, {
    ...requestOptions,
    method: 'POST',
    body: JSON.stringify({})
  });
  assert.equal(anonymousProfileImageUpload.status, 401);

  const anonymousCertificateUpload = await fetch(`${baseUrl}/api/documents/certificates`, {
    ...requestOptions,
    method: 'POST',
    body: JSON.stringify({})
  });
  assert.equal(anonymousCertificateUpload.status, 401);

  const anonymousPreview = await fetch(`${baseUrl}/api/downloads/preview`, {
    ...requestOptions,
    method: 'POST',
    body: JSON.stringify({ token: 'no-visitor-authorization' })
  });
  assert.equal(anonymousPreview.status, 403);

  const publicPreview = await fetch(`${baseUrl}/api/downloads/preview/cv`, {
    headers: { Origin: 'http://localhost:5500' }
  });
  assert.equal(publicPreview.status, 404);
  assert.equal((await publicPreview.json()).success, false);

  const missingPublicPreview = await fetch(`${baseUrl}/api/downloads/preview/not-a-published-document`, {
    headers: { Origin: 'http://localhost:5500' }
  });
  assert.equal(missingPublicPreview.status, 404);

  const invalidRequest = await fetch(`${baseUrl}/api/downloads/request`, {
    ...requestOptions,
    method: 'POST',
    body: JSON.stringify({
      documentId: 'cv',
      name: 'Test Visitor',
      email: 'visitor@example.com',
      reason: 'I need this for a portfolio review.',
      consent: false
    })
  });
  assert.equal(invalidRequest.status, 400);

  const missingEmail = await fetch(`${baseUrl}/api/downloads/request`, {
    ...requestOptions,
    method: 'POST',
    body: JSON.stringify({
      documentId: 'cv',
      name: 'Test Visitor',
      phone: '',
      reason: 'I need this for a portfolio review.',
      consent: true
    })
  });
  assert.equal(missingEmail.status, 400);
  assert.match((await missingEmail.json()).error, /valid email address/);

  const emailWithPhone = await fetch(`${baseUrl}/api/downloads/request`, {
    ...requestOptions,
    method: 'POST',
    body: JSON.stringify({
      documentId: 'cv',
      name: 'Test Visitor',
      email: 'visitor@example.com',
      phone: '+250788123456',
      purpose: 'preview',
      reason: 'I need this for a portfolio review.',
      consent: true
    })
  });
  assert.equal(emailWithPhone.status, 201);
  const phoneContactChallenge = await emailWithPhone.json();
  assert.equal(phoneContactChallenge.channel, 'email');
  database.prepare('DELETE FROM download_email_verifications WHERE challenge_id = ?').run(phoneContactChallenge.challengeId);

  const failedEmailConfig = [
    'NODE_ENV', 'EMAIL_USER', 'EMAIL_PASSWORD', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE'
  ].map((key) => [key, process.env[key]]);
  process.env.NODE_ENV = 'development';
  process.env.EMAIL_USER = '';
  process.env.EMAIL_PASSWORD = '';
  let unavailableVerification;
  try {
    unavailableVerification = await fetch(`${baseUrl}/api/downloads/request`, {
      ...requestOptions,
      method: 'POST',
      body: JSON.stringify({
        documentId: 'cv',
        name: 'Test Visitor',
        email: 'mail-config@example.com',
        reason: 'I need this for a portfolio review.',
        channel: 'email',
        consent: true
      })
    });
  } finally {
    for (const [key, value] of failedEmailConfig) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  assert.equal(unavailableVerification.status, 503);
  assert.match((await unavailableVerification.json()).error, /Email code delivery is not configured/);

  process.env.NODE_ENV = 'development';
  process.env.EMAIL_USER = 'sender@example.com';
  process.env.EMAIL_PASSWORD = 'test-only-password';
  process.env.SMTP_HOST = '127.0.0.1';
  process.env.SMTP_PORT = '1';
  process.env.SMTP_SECURE = 'false';
  const attemptsBeforeFailedDelivery = database.prepare(`
    SELECT COALESCE(SUM(attempts), 0) AS attempts FROM download_verification_limits
  `).get().attempts;
  let failedDelivery;
  try {
    failedDelivery = await fetch(`${baseUrl}/api/downloads/request`, {
      ...requestOptions,
      method: 'POST',
      body: JSON.stringify({
        documentId: 'cv',
        name: 'Failed Delivery Visitor',
        email: 'smtp-failure@example.com',
        reason: 'I need this for a portfolio review.',
        channel: 'email',
        consent: true
      })
    });
  } finally {
    for (const [key, value] of failedEmailConfig) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  assert.equal(failedDelivery.status, 502);
  assert.match((await failedDelivery.json()).error, /email provider|No email code was sent/i);
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS count FROM download_email_verifications WHERE email = ?
  `).get('smtp-failure@example.com').count, 0);
  assert.equal(database.prepare(`
    SELECT COALESCE(SUM(attempts), 0) AS attempts FROM download_verification_limits
  `).get().attempts, attemptsBeforeFailedDelivery);

  const cvChallenge = await startDownloadVerification({
    documentId: 'cv',
    name: 'Test Visitor',
    email: 'visitor@example.com',
    phone: '',
    reason: 'I need this for a portfolio review.',
    consent: true
  });
  const incorrectCode = await completeDownloadVerification(cvChallenge.challengeId, '000000');
  assert.equal(incorrectCode.status, 400);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM download_enquiries').get().count, 0);
  const verifiedDownloadRequest = await completeDownloadVerification(cvChallenge.challengeId);
  assert.equal(verifiedDownloadRequest.status, 201);
  const { downloadToken, filename } = await verifiedDownloadRequest.json();
  assert.equal(filename, 'KWIZERA-David-CV.pdf');
  const verifiedEmailContact = database.prepare(`
    SELECT email, phone FROM download_enquiries WHERE name = ?
  `).get('Test Visitor');
  assert.equal(verifiedEmailContact.email, 'visitor@example.com');
  assert.equal(verifiedEmailContact.phone, '');

  const adminDownloads = await fetch(`${baseUrl}/api/downloads`, {
    headers: { ...requestOptions.headers, Cookie: cookie }
  });
  assert.equal(adminDownloads.status, 200);
  const downloadRows = (await adminDownloads.json()).downloads;
  assert.equal(downloadRows.length, 1);
  assert.equal(downloadRows[0].email, 'visitor@example.com');
  assert.equal(downloadRows[0].reason, 'I need this for a portfolio review.');
  assert.equal(downloadRows[0].downloadedAt, null);

  const previewResponse = await fetch(`${baseUrl}/api/downloads/preview`, {
    ...requestOptions,
    method: 'POST',
    body: JSON.stringify({ token: downloadToken })
  });
  assert.equal(previewResponse.status, 403);
  const previewedDownloads = await fetch(`${baseUrl}/api/downloads`, {
    headers: { ...requestOptions.headers, Cookie: cookie }
  });
  assert.equal((await previewedDownloads.json()).downloads[0].downloadedAt, null);

  const fileResponse = await fetch(`${baseUrl}/api/downloads/file`, {
    ...requestOptions,
    method: 'POST',
    body: JSON.stringify({ token: downloadToken })
  });
  assert.equal(fileResponse.status, 200);
  assert.match(fileResponse.headers.get('content-disposition'), /KWIZERA-David-CV\.pdf/);
  assert.ok((await fileResponse.arrayBuffer()).byteLength > 100_000);

  const reusedToken = await fetch(`${baseUrl}/api/downloads/file`, {
    ...requestOptions,
    method: 'POST',
    body: JSON.stringify({ token: downloadToken })
  });
  assert.equal(reusedToken.status, 403);

  const ebcChallenge = await startDownloadVerification({
    documentId: 'ebc',
    name: 'Test Visitor',
    email: 'ebc-visitor@example.com',
    reason: 'I need the event planning materials for my research.',
    consent: true
  });
  const ebcVerification = await completeDownloadVerification(ebcChallenge.challengeId);
  assert.equal(ebcVerification.status, 201);
  const ebcAuthorization = await ebcVerification.json();
  assert.equal(ebcAuthorization.filename, 'AGENDA_EBC-2026.pdf');
  const ebcFile = await fetch(`${baseUrl}/api/downloads/file`, {
    ...requestOptions,
    method: 'POST',
    body: JSON.stringify({ token: ebcAuthorization.downloadToken })
  });
  assert.equal(ebcFile.status, 200);
  assert.ok((await ebcFile.arrayBuffer()).byteLength > 4_000_000);

  const deliveredDownloads = await fetch(`${baseUrl}/api/downloads`, {
    headers: { ...requestOptions.headers, Cookie: cookie }
  });
  const finalRows = (await deliveredDownloads.json()).downloads;
  assert.equal(finalRows.length, 2);
  assert.ok(finalRows.every((item) => item.downloadedAt));

  const certificatePdf = Buffer.from('%PDF-1.4\nPortfolio test certificate').toString('base64');
  const certificateResponse = await fetch(`${baseUrl}/api/documents/certificates`, {
    ...requestOptions,
    method: 'POST',
    headers: { ...requestOptions.headers, Cookie: cookie },
    body: JSON.stringify({
      title: 'Secure Web Development',
      description: 'Completed an advanced course in secure web development.',
      issuedAt: '2025-04-15',
      institution: 'Test Training Institute',
      filename: 'secure-web-development.pdf',
      file: certificatePdf
    })
  });
  assert.equal(certificateResponse.status, 201);
  const certificate = (await certificateResponse.json()).document;
  assert.equal(certificate.type, 'certificate');
  assert.equal(certificate.title, 'Secure Web Development');
  assert.equal(certificate.description, 'Completed an advanced course in secure web development.');
  assert.equal(certificate.issuedAt, '2025-04-15');
  assert.equal(certificate.institution, 'Test Training Institute');

  const anonymousCertificateUpdate = await fetch(`${baseUrl}/api/documents/certificates/${certificate.documentId}`, {
    ...requestOptions,
    method: 'PUT',
    body: JSON.stringify({})
  });
  assert.equal(anonymousCertificateUpdate.status, 401);

  const updatedCertificate = await fetch(`${baseUrl}/api/documents/certificates/${certificate.documentId}`, {
    ...requestOptions,
    method: 'PUT',
    headers: { ...requestOptions.headers, Cookie: cookie },
    body: JSON.stringify({
      title: 'Secure Web Development Certificate',
      description: 'Updated certificate details.',
      issuedAt: '2025-04-15',
      institution: 'Test Training Institute'
    })
  });
  assert.equal(updatedCertificate.status, 200);
  assert.equal((await updatedCertificate.json()).document.title, 'Secure Web Development Certificate');

  const certificateChallenge = await startDownloadVerification({
    documentId: certificate.documentId,
    name: 'Certificate Visitor',
    email: 'certificate-visitor@example.com',
    reason: 'I need to confirm this qualification for a job application.',
    consent: true
  });
  const certificateVerification = await completeDownloadVerification(certificateChallenge.challengeId);
  assert.equal(certificateVerification.status, 201);
  const certificateAuthorization = await certificateVerification.json();
  assert.equal(certificateAuthorization.filename, 'secure-web-development.pdf');
  const certificateDownload = await fetch(`${baseUrl}/api/downloads/file`, {
    ...requestOptions,
    method: 'POST',
    body: JSON.stringify({ token: certificateAuthorization.downloadToken })
  });
  assert.equal(certificateDownload.status, 200);
  assert.equal(Buffer.from(await certificateDownload.arrayBuffer()).toString(), '%PDF-1.4\nPortfolio test certificate');

  const updatedCv = await fetch(`${baseUrl}/api/documents/cv`, {
    ...requestOptions,
    method: 'POST',
    headers: { ...requestOptions.headers, Cookie: cookie },
    body: JSON.stringify({
      title: 'David Kwizera CV',
      description: 'Updated career history and technical experience.',
      issuedAt: '2026-02-01',
      institution: 'University of Rwanda',
      filename: 'Latest CV.pdf',
      file: certificatePdf
    })
  });
  assert.equal(updatedCv.status, 201);
  const updatedCvDetails = (await updatedCv.json()).document;
  assert.equal(updatedCvDetails.type, 'cv');
  assert.ok(updatedCvDetails.documentId.startsWith('cv-'));
  assert.equal(updatedCvDetails.filename, 'Latest CV.pdf');
  assert.equal(updatedCvDetails.title, 'David Kwizera CV');
  assert.equal(updatedCvDetails.description, 'Updated career history and technical experience.');
  assert.equal(updatedCvDetails.issuedAt, '2026-02-01');
  assert.equal(updatedCvDetails.institution, 'University of Rwanda');

  const latestCvChallenge = await startDownloadVerification({
    documentId: updatedCvDetails.documentId,
    name: 'Latest CV Visitor',
    email: 'latest-cv-visitor@example.com',
    reason: 'I need the updated CV for a recruitment application.',
    consent: true
  });
  const latestCvVerification = await completeDownloadVerification(latestCvChallenge.challengeId);
  assert.equal(latestCvVerification.status, 201);
  const latestCvAuthorization = await latestCvVerification.json();
  assert.equal(latestCvAuthorization.filename, 'Latest CV.pdf');
  const latestCvDownload = await fetch(`${baseUrl}/api/downloads/file`, {
    ...requestOptions,
    method: 'POST',
    body: JSON.stringify({ token: latestCvAuthorization.downloadToken })
  });
  assert.equal(latestCvDownload.status, 200);
  assert.equal(Buffer.from(await latestCvDownload.arrayBuffer()).toString(), '%PDF-1.4\nPortfolio test certificate');

  const allDownloadRowsResponse = await fetch(`${baseUrl}/api/downloads`, {
    headers: { ...requestOptions.headers, Cookie: cookie }
  });
  const allDownloadRows = (await allDownloadRowsResponse.json()).downloads;
  assert.equal(allDownloadRows.length, 4);
  const deletedRequestId = allDownloadRows.find((item) => item.email === 'visitor@example.com').id;
  database.prepare('INSERT INTO download_access_tokens (token_hash, download_id, expires_at) VALUES (?, ?, ?)')
    .run('delete-cascade-test-token', deletedRequestId, Date.now() + 60_000);
  const deletedRequest = await fetch(`${baseUrl}/api/downloads/${deletedRequestId}`, {
    ...requestOptions,
    method: 'DELETE',
    headers: { ...requestOptions.headers, Cookie: cookie }
  });
  assert.equal(deletedRequest.status, 200);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM download_access_tokens WHERE download_id = ?').get(deletedRequestId).count, 0);
  const remainingRows = await fetch(`${baseUrl}/api/downloads`, {
    headers: { ...requestOptions.headers, Cookie: cookie }
  });
  assert.equal((await remainingRows.json()).downloads.length, 3);

  const lockedChallenge = await startDownloadVerification({
    documentId: 'cv',
    name: 'Locked Visitor',
    email: 'locked-visitor@example.com',
    reason: 'I need this document for independent review.',
    consent: true
  });
  for (let attempt = 0; attempt < 4; attempt += 1) {
    assert.equal((await completeDownloadVerification(lockedChallenge.challengeId, '000000')).status, 400);
  }
  assert.equal((await completeDownloadVerification(lockedChallenge.challengeId, '000000')).status, 429);

  const expiredChallenge = await startDownloadVerification({
    documentId: 'cv',
    name: 'Expired Visitor',
    email: 'expired-visitor@example.com',
    reason: 'I need this document for independent review.',
    consent: true
  });
  database.prepare('UPDATE download_email_verifications SET expires_at = 0 WHERE challenge_id = ?')
    .run(expiredChallenge.challengeId);
  assert.equal((await completeDownloadVerification(expiredChallenge.challengeId)).status, 410);

  const logout = await fetch(`${baseUrl}/api/auth/logout`, {
    ...requestOptions,
    method: 'POST',
    headers: { ...requestOptions.headers, Cookie: cookie }
  });
  assert.equal(logout.status, 200);

  const revoked = await fetch(`${baseUrl}/api/auth/me`, {
    headers: { ...requestOptions.headers, Cookie: cookie }
  });
  assert.equal(revoked.status, 401);
});

test('admin login allows retries and rejects invalid credentials without a lockout', async () => {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const response = await fetch(`${baseUrl}/api/auth/login`, {
      ...requestOptions,
      method: 'POST',
      body: JSON.stringify({ email: 'admin-test@example.com', password: 'incorrect-password' })
    });
    assert.equal(response.status, 401);
  }
});
