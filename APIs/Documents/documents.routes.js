import { randomUUID } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import database from '../../config/database.js';
import { resolveWritableDirectory, resolveWritablePath } from '../../config/storage.js';
import { requireAdmin } from '../Auth/auth.routes.js';

const router = express.Router();
const privateDocumentsDirectory = resolveWritableDirectory('private-documents');
const MAX_FILE_SIZE = 10 * 1024 * 1024;

function toPublicDocument(row) {
  return {
    documentId: row.document_id,
    type: row.document_type,
    title: row.title,
    description: row.description,
    issuedAt: row.issued_at,
    institution: row.institution,
    filename: row.filename,
    updatedAt: row.updated_at,
    createdAt: row.created_at ?? null
  };
}

function parseDocumentFile(body) {
  const filename = typeof body?.filename === 'string' ? body.filename.trim() : '';
  const encoded = typeof body?.file === 'string' ? body.file : '';
  const base64 = encoded.startsWith('data:application/pdf;base64,')
    ? encoded.slice('data:application/pdf;base64,'.length)
    : encoded;

  if (!filename || filename.length > 255 || !filename.toLowerCase().endsWith('.pdf')) {
    throw Object.assign(new Error('Choose a PDF file.'), { status: 400 });
  }
  if (!base64 || base64.length > Math.ceil(MAX_FILE_SIZE * 4 / 3) + 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
    throw Object.assign(new Error('The PDF file is empty or larger than 10 MB.'), { status: 400 });
  }

  const content = Buffer.from(base64, 'base64');
  if (!content.length || content.length > MAX_FILE_SIZE || content.toString('ascii', 0, 5) !== '%PDF-') {
    throw Object.assign(new Error('The uploaded file must be a valid PDF smaller than 10 MB.'), { status: 400 });
  }
  const safeFilename = filename.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_');
  return { filename: path.basename(safeFilename), content };
}

function parseMetadata(body) {
  const title = typeof body?.title === 'string' ? body.title.trim() : '';
  const description = typeof body?.description === 'string' ? body.description.trim() : '';
  const issuedAt = typeof body?.issuedAt === 'string' ? body.issuedAt.trim() : '';
  const institution = typeof body?.institution === 'string' ? body.institution.trim() : '';

  if (title.length < 2 || title.length > 120) {
    throw Object.assign(new Error('Enter a title between 2 and 120 characters.'), { status: 400 });
  }
  if (!description || description.length > 2000) {
    throw Object.assign(new Error('Enter a description of up to 2,000 characters.'), { status: 400 });
  }
  const parsedDate = new Date(`${issuedAt}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(issuedAt)
    || Number.isNaN(parsedDate.getTime())
    || parsedDate.toISOString().slice(0, 10) !== issuedAt) {
    throw Object.assign(new Error('Enter a valid issue date.'), { status: 400 });
  }
  if (institution.length < 2 || institution.length > 160) {
    throw Object.assign(new Error('Enter an institution between 2 and 160 characters.'), { status: 400 });
  }
  return { title, description, issuedAt, institution };
}

function parseCvMetadata(body) {
  const title = typeof body?.title === 'string' ? body.title.trim() : '';
  const description = typeof body?.description === 'string' ? body.description.trim() : '';
  const issuedAt = typeof body?.issuedAt === 'string' ? body.issuedAt.trim() : '';
  const institution = typeof body?.institution === 'string' ? body.institution.trim() : '';
  if (title.length < 2 || title.length > 120) {
    throw Object.assign(new Error('Enter a CV title between 2 and 120 characters.'), { status: 400 });
  }
  if (!description || description.length > 2000) {
    throw Object.assign(new Error('Enter a CV description of up to 2,000 characters.'), { status: 400 });
  }
  if (issuedAt) {
    const parsedDate = new Date(`${issuedAt}T00:00:00.000Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(issuedAt)
      || Number.isNaN(parsedDate.getTime())
      || parsedDate.toISOString().slice(0, 10) !== issuedAt) {
      throw Object.assign(new Error('Enter a valid CV issue date.'), { status: 400 });
    }
  }
  if (institution.length > 160) {
    throw Object.assign(new Error('The CV institution must be 160 characters or fewer.'), { status: 400 });
  }
  return { title, description, issuedAt: issuedAt || null, institution: institution || null };
}

async function savePdf(content, prefix) {
  await mkdir(privateDocumentsDirectory, { recursive: true });
  const storedFilename = `${prefix}-${randomUUID()}.pdf`;
  await writeFile(resolveWritablePath('private-documents',  storedFilename), content, { flag: 'wx' });
  return storedFilename;
}

router.get('/', (req, res, next) => {
  try {
    const documents = database.prepare(`
      SELECT document_id, document_type, title, description, issued_at,
        institution, filename, stored_filename, updated_at, created_at
      FROM portfolio_documents
      ORDER BY CASE document_type WHEN 'cv' THEN 0 WHEN 'document' THEN 1 ELSE 2 END,
        issued_at DESC, title COLLATE NOCASE
    `).all();
    const available = documents.filter((row) => {
      if (!row.stored_filename) return true;
      return existsSync(resolveWritablePath('private-documents', row.stored_filename));
    });
    return res.json({ success: true, documents: available.map(toPublicDocument) });
  } catch (error) {
    return next(error);
  }
});

router.post('/cv', requireAdmin, async (req, res, next) => {
  let storedFilename;
  try {
    const metadata = parseCvMetadata(req.body);
    const { filename, content } = parseDocumentFile(req.body);
    storedFilename = await savePdf(content, 'cv');
    const documentId = `cv-${randomUUID()}`;
    const updatedAt = new Date().toISOString();
    database.prepare(`
      INSERT INTO portfolio_documents
        (document_id, document_type, title, description, issued_at, institution, filename, stored_filename, updated_at, created_at)
      VALUES (?, 'cv', ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(documentId, metadata.title, metadata.description, metadata.issuedAt, metadata.institution, filename, storedFilename, updatedAt, updatedAt);
    const document = database.prepare(`
      SELECT document_id, document_type, title, description, issued_at,
        institution, filename, updated_at, created_at
      FROM portfolio_documents WHERE document_id = ?
    `).get(documentId);
    return res.status(201).json({ success: true, document: toPublicDocument(document) });
  } catch (error) {
    if (storedFilename) {
      await unlink(resolveWritablePath('private-documents',  storedFilename)).catch((cleanupError) => {
        console.error('Could not clean up an unpublished CV file:', cleanupError);
      });
    }
    return next(error);
  }
});

router.post('/certificates', requireAdmin, async (req, res, next) => {
  let storedFilename;
  try {
    const metadata = parseMetadata(req.body);
    const { filename, content } = parseDocumentFile(req.body);
    const documentId = `certificate-${randomUUID()}`;
    storedFilename = await savePdf(content, documentId);
    const updatedAt = new Date().toISOString();
    database.prepare(`
      INSERT INTO portfolio_documents
        (document_id, document_type, title, description, issued_at, institution, filename, stored_filename, updated_at, created_at)
      VALUES (?, 'certificate', ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(documentId, metadata.title, metadata.description, metadata.issuedAt, metadata.institution, filename, storedFilename, updatedAt, updatedAt);

    const document = database.prepare(`
      SELECT document_id, document_type, title, description, issued_at,
        institution, filename, updated_at, created_at
      FROM portfolio_documents WHERE document_id = ?
    `).get(documentId);
    return res.status(201).json({ success: true, document: toPublicDocument(document) });
  } catch (error) {
    if (storedFilename) {
      await unlink(resolveWritablePath('private-documents',  storedFilename)).catch((cleanupError) => {
        console.error('Could not clean up an unpublished certificate file:', cleanupError);
      });
    }
    return next(error);
  }
});

router.put('/certificates/:documentId', requireAdmin, async (req, res, next) => {
  let storedFilename;
  try {
    const existing = database.prepare(`
      SELECT document_id, document_type, filename, stored_filename FROM portfolio_documents
      WHERE document_id = ? AND document_type IN ('certificate', 'cv', 'document')
    `).get(req.params.documentId);
    if (!existing) return res.status(404).json({ success: false, error: 'Document not found.' });

    const isCv = existing.document_type === 'cv';
    const metadata = isCv ? parseCvMetadata(req.body) : parseMetadata(req.body);
    const hasFile = typeof req.body?.file === 'string' && req.body.file.length > 0;
    const upload = hasFile ? parseDocumentFile(req.body) : null;
    if (upload) storedFilename = await savePdf(upload.content, existing.document_id);
    const updatedAt = new Date().toISOString();
    database.prepare(`
      UPDATE portfolio_documents
      SET title = ?, description = ?, issued_at = ?, institution = ?,
        filename = ?, stored_filename = ?, updated_at = ?
      WHERE document_id = ?
    `).run(
      metadata.title,
      metadata.description,
      metadata.issuedAt,
      metadata.institution,
      upload?.filename ?? existing.filename,
      storedFilename ?? existing.stored_filename,
      updatedAt,
      existing.document_id
    );
    if (storedFilename && storedFilename !== existing.stored_filename) {
      await unlink(resolveWritablePath('private-documents',  existing.stored_filename)).catch((cleanupError) => {
        console.error('Could not remove the replaced document file:', cleanupError);
      });
    }
    const document = database.prepare(`
      SELECT document_id, document_type, title, description, issued_at,
        institution, filename, updated_at, created_at
      FROM portfolio_documents WHERE document_id = ?
    `).get(existing.document_id);
    return res.json({ success: true, document: toPublicDocument(document) });
  } catch (error) {
    if (storedFilename) {
      await unlink(resolveWritablePath('private-documents',  storedFilename)).catch((cleanupError) => {
        console.error('Could not clean up an unpublished document file:', cleanupError);
      });
    }
    return next(error);
  }
});

router.delete('/:documentId', requireAdmin, async (req, res, next) => {
  try {
    const existing = database.prepare(`
      SELECT document_id, stored_filename FROM portfolio_documents WHERE document_id = ?
    `).get(req.params.documentId);
    if (!existing) return res.status(404).json({ success: false, error: 'Document not found.' });

    database.prepare('DELETE FROM portfolio_documents WHERE document_id = ?').run(existing.document_id);
    if (existing.stored_filename) {
      await unlink(resolveWritablePath('private-documents',  existing.stored_filename)).catch((cleanupError) => {
        console.error('Could not remove the deleted document file:', cleanupError);
      });
    }
    return res.json({ success: true });
  } catch (error) {
    return next(error);
  }
});

export default router;
