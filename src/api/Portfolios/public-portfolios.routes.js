import express from 'express';
import { z } from 'zod';
import database from '../../database/database.js';
import { validateRequest } from '../../middleware/validate-request.js';
import { hashRecruiterSession, RECRUITER_SESSION_COOKIE } from '../../services/platform-privacy.js';

const router = express.Router();
const paramsSchema = z.object({
  slug: z.string().toLowerCase().min(3).max(48).regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/)
});
const requestSchema = z.object({
  body: z.object({}),
  params: paramsSchema,
  query: z.object({})
});

router.get('/:slug', validateRequest(requestSchema), (req, res) => {
  const portfolio = database.prepare(`
    SELECT id, slug, template_id AS templateId
    FROM portfolios WHERE slug = ? COLLATE NOCASE AND status = 'published'
  `).get(req.validated.params.slug);
  if (!portfolio) return res.status(404).json({ success: false, error: 'Portfolio not found.' });

  const sections = database.prepare(`
    SELECT type, sort_order AS sortOrder, data_json AS dataJson
    FROM portfolio_sections
    WHERE portfolio_id = ? AND is_private = 0
    ORDER BY sort_order, id
  `).all(portfolio.id).map(({ type, sortOrder, dataJson }) => ({
    type,
    sortOrder,
    data: JSON.parse(dataJson)
  }));
  return res.json({
    success: true,
    portfolio: { slug: portfolio.slug, templateId: portfolio.templateId, sections }
  });
});

router.get('/:slug/full', validateRequest(requestSchema), (req, res) => {
  const portfolio = database.prepare(`
    SELECT id, slug, template_id AS templateId
    FROM portfolios WHERE slug = ? COLLATE NOCASE AND status = 'published'
  `).get(req.validated.params.slug);
  if (!portfolio) return res.status(404).json({ success: false, error: 'Portfolio not found.' });
  const token = req.cookies?.[RECRUITER_SESSION_COOKIE];
  if (!token) {
    return res.status(403).json({ success: false, error: 'Private portfolio access requires recruiter verification.' });
  }
  const session = database.prepare(`
    SELECT 1 FROM recruiter_sessions
    WHERE token_hash = ? AND portfolio_id = ? AND expires_at > ?
  `).get(hashRecruiterSession(token), portfolio.id, Date.now());
  if (!session) {
    return res.status(403).json({ success: false, error: 'Private portfolio access requires recruiter verification.' });
  }

  const sections = database.prepare(`
    SELECT type, sort_order AS sortOrder, is_private AS isPrivate, data_json AS dataJson
    FROM portfolio_sections WHERE portfolio_id = ?
    ORDER BY sort_order, id
  `).all(portfolio.id).map(({ type, sortOrder, isPrivate, dataJson }) => ({
    type,
    sortOrder,
    isPrivate: Boolean(isPrivate),
    data: JSON.parse(dataJson)
  }));
  return res.json({
    success: true,
    portfolio: { slug: portfolio.slug, templateId: portfolio.templateId, sections }
  });
});

export default router;
