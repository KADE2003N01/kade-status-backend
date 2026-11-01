import database from '../database/database.js';

export function resolveSupportRequestsForAdmin(email, categories, actorId, resolution) {
  if (!categories.length) return 0;
  const placeholders = categories.map(() => '?').join(', ');
  const matches = database.prepare(`SELECT id, category FROM admin_support_requests
    WHERE email = ? COLLATE NOCASE AND status = 'open' AND category IN (${placeholders})`)
    .all(email, ...categories);
  if (!matches.length) return 0;

  const now = new Date().toISOString();
  database.transaction(() => {
    const update = database.prepare("UPDATE admin_support_requests SET status = 'resolved', resolved_at = ? WHERE id = ? AND status = 'open'");
    const addAudit = database.prepare('INSERT INTO platform_admin_audit (actor_id, action, details_json) VALUES (?, ?, ?)');
    for (const request of matches) {
      if (!update.run(now, request.id).changes) continue;
      addAudit.run(actorId, 'support_request_auto_resolved', JSON.stringify({
        requestId: request.id,
        email: email.toLowerCase(),
        category: request.category,
        resolution
      }));
    }
  })();
  return matches.length;
}
