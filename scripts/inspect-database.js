import { openConfiguredDatabase } from './database.js';

const database = openConfiguredDatabase();
try {
  const tables = database.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all();
  const summary = tables.map(({ name }) => {
    const quotedName = `"${name.replaceAll('"', '""')}"`;
    const { count } = database.prepare(`SELECT COUNT(*) AS count FROM ${quotedName}`).get();
    return { table: name, rows: count };
  });
  console.table(summary);
} finally {
  database.close();
}
