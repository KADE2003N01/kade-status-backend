import database from './config/database.js';
import { existsSync } from 'node:fs';
import path from 'node:path';

const backendDir = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), 'private-documents');

// Remove stale rows whose PDF files no longer exist
const rows = database.prepare('SELECT document_id, stored_filename FROM portfolio_documents').all();
for (const row of rows) {
  if (row.stored_filename && !existsSync(path.join(backendDir, row.stored_filename))) {
    database.prepare('DELETE FROM portfolio_documents WHERE document_id = ?').run(row.document_id);
    console.log('removed stale row:', row.document_id);
  }
}
console.log('remaining rows:', JSON.stringify(database.prepare('SELECT document_id, title, stored_filename FROM portfolio_documents').all(), null, 1));
