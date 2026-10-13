import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const databasePath = path.join(tmpdir(), `kade-auth-test-${process.pid}.sqlite`);
process.env.DATABASE_PATH = databasePath;
process.env.ADMIN_EMAIL = 'admin-test@example.com';
process.env.ADMIN_PASSWORD = 'a-unique-test-password-123';
process.env.ADMIN_DISPLAY_NAME = 'Database Test Admin';
process.env.FRONTEND_URL = 'http://localhost:5500';
process.env.NODE_ENV = 'test';
process.env.EMAIL_USER = '';
process.env.EMAIL_PASSWORD = '';

const [{ default: app }, { default: database }] = await Promise.all([
  import('../app.js'),
  import('../config/database.js')
]);
const server = app.listen(0);
await new Promise((resolve) => server.once('listening', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const requestOptions = {
  headers: { Origin: 'http://localhost:5500', 'Content-Type': 'application/json' }
};

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  const uploadedFiles = database.prepare(`
    SELECT stored_filename FROM portfolio_documents
    WHERE stored_filename LIKE 'cv-%' OR stored_filename LIKE 'certificate-%'
  `).all();
  const backendDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  for (const file of uploadedFiles) {
    const filePath = path.join(backendDirectory, 'private-documents', file.stored_filename);
    if (existsSync(filePath)) unlinkSync(filePath);
  }
  database.close();
  for (const suffix of ['', '-shm', '-wal']) {
    const filePath = `${databasePath}${suffix}`;
    if (existsSync(filePath)) unlinkSync(filePath);
  }
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
      body: JSON.stringify({ email: 'admin-test@example.com', password: 'a-unique-test-password-123' })
    });
  } finally {
    for (const [key, value] of bootstrapCredentials) process.env[key] = value;
  }
  assert.equal(login.status, 200);
  const cookieHeader = login.headers.get('set-cookie');
  assert.match(cookieHeader, /HttpOnly/i);
  assert.match(cookieHeader, /SameSite=Lax/i);
  const cookie = cookieHeader.split(';', 1)[0];

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

  const publicDocuments = await fetch(`${baseUrl}/api/documents`, requestOptions);
  assert.equal(publicDocuments.status, 200);
  assert.deepEqual((await publicDocuments.json()).documents.map((document) => document.documentId), ['cv', 'ebc']);

  const anonymousCvUpload = await fetch(`${baseUrl}/api/documents/cv`, {
    ...requestOptions,
    method: 'POST',
    body: JSON.stringify({})
  });
  assert.equal(anonymousCvUpload.status, 401);

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

  const invalidRequest = await fetch(`${baseUrl}/api/downloads/request`, {
    ...requestOptions,
    method: 'POST',
    body: JSON.stringify({
      documentId: 'cv',
      name: 'Test Visitor',
      email: 'visitor@example.com',
      consent: false
    })
  });
  assert.equal(invalidRequest.status, 400);

  const downloadRequest = await fetch(`${baseUrl}/api/downloads/request`, {
    ...requestOptions,
    method: 'POST',
    body: JSON.stringify({
      documentId: 'cv',
      name: 'Test Visitor',
      email: 'visitor@example.com',
      phone: '',
      consent: true
    })
  });
  assert.equal(downloadRequest.status, 201);
  const { downloadToken, filename } = await downloadRequest.json();
  assert.equal(filename, 'KWIZERA-David-CV.pdf');

  const adminDownloads = await fetch(`${baseUrl}/api/downloads`, {
    headers: { ...requestOptions.headers, Cookie: cookie }
  });
  assert.equal(adminDownloads.status, 200);
  const downloadRows = (await adminDownloads.json()).downloads;
  assert.equal(downloadRows.length, 1);
  assert.equal(downloadRows[0].email, 'visitor@example.com');
  assert.equal(downloadRows[0].downloadedAt, null);

  const previewResponse = await fetch(`${baseUrl}/api/downloads/preview`, {
    ...requestOptions,
    method: 'POST',
    body: JSON.stringify({ token: downloadToken })
  });
  assert.equal(previewResponse.status, 200);
  assert.match(previewResponse.headers.get('content-disposition'), /^inline;/);
  assert.ok((await previewResponse.arrayBuffer()).byteLength > 100_000);
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

  const ebcRequest = await fetch(`${baseUrl}/api/downloads/request`, {
    ...requestOptions,
    method: 'POST',
    body: JSON.stringify({
      documentId: 'ebc',
      name: 'Test Visitor',
      phone: '+250 788 000 000',
      consent: true
    })
  });
  assert.equal(ebcRequest.status, 201);
  const ebcAuthorization = await ebcRequest.json();
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

  const certificateRequest = await fetch(`${baseUrl}/api/downloads/request`, {
    ...requestOptions,
    method: 'POST',
    body: JSON.stringify({
      documentId: certificate.documentId,
      name: 'Certificate Visitor',
      email: 'certificate-visitor@example.com',
      consent: true
    })
  });
  assert.equal(certificateRequest.status, 201);
  const certificateAuthorization = await certificateRequest.json();
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
    body: JSON.stringify({ filename: 'Latest CV.pdf', file: certificatePdf })
  });
  assert.equal(updatedCv.status, 200);
  assert.equal((await updatedCv.json()).document.filename, 'Latest CV.pdf');

  const latestCvRequest = await fetch(`${baseUrl}/api/downloads/request`, {
    ...requestOptions,
    method: 'POST',
    body: JSON.stringify({
      documentId: 'cv',
      name: 'Latest CV Visitor',
      email: 'latest-cv-visitor@example.com',
      consent: true
    })
  });
  assert.equal(latestCvRequest.status, 201);
  const latestCvAuthorization = await latestCvRequest.json();
  assert.equal(latestCvAuthorization.filename, 'Latest CV.pdf');
  const latestCvDownload = await fetch(`${baseUrl}/api/downloads/file`, {
    ...requestOptions,
    method: 'POST',
    body: JSON.stringify({ token: latestCvAuthorization.downloadToken })
  });
  assert.equal(latestCvDownload.status, 200);
  assert.equal(Buffer.from(await latestCvDownload.arrayBuffer()).toString(), '%PDF-1.4\nPortfolio test certificate');

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

test('admin login rate limits repeated invalid credentials', async () => {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await fetch(`${baseUrl}/api/auth/login`, {
      ...requestOptions,
      method: 'POST',
      body: JSON.stringify({ email: 'admin-test@example.com', password: 'incorrect-password' })
    });
    assert.equal(response.status, 401);
  }

  const limited = await fetch(`${baseUrl}/api/auth/login`, {
    ...requestOptions,
    method: 'POST',
    body: JSON.stringify({ email: 'admin-test@example.com', password: 'incorrect-password' })
  });
  assert.equal(limited.status, 429);
});
