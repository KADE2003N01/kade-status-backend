import express from 'express';
import { z } from 'zod';
import database from '../../database/database.js';
import { validateRequest } from '../../middleware/validate-request.js';
import { requirePlatformUser } from '../../verification/platform-auth.js';
import { decryptPrivateField } from '../../services/platform-privacy.js';

const router = express.Router();
const emptyObject = z.object({});
const sectionTypes = ['hero', 'about', 'experience', 'education', 'projects', 'skills', 'certificates', 'video_pitch', 'contact'];
const slugSchema = z.string().trim().toLowerCase().min(3).max(48)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/);
const reservedSlugs = new Set([
  'about', 'account', 'admin', 'api', 'auth', 'contact', 'dashboard', 'documents',
  'login', 'logout', 'platform', 'portfolio', 'public', 'signup', 'u'
]);
const requestSchema = (body, params = emptyObject, query = emptyObject) => z.object({ body, params, query });
const idParams = z.object({ portfolioId: z.coerce.number().int().positive() });
const checkSlugSchema = requestSchema(emptyObject, emptyObject, z.object({ slug: slugSchema }));
const createSchema = requestSchema(z.object({
  slug: slugSchema,
  title: z.string().trim().min(1).max(120)
}));
const updateBodySchema = z.object({
  slug: slugSchema.optional(),
  title: z.string().trim().min(1).max(120).optional()
}).refine((body) => Object.keys(body).length > 0);
const sectionsBodySchema = z.object({
  sections: z.array(z.object({
    type: z.enum(sectionTypes),
    sortOrder: z.number().int().min(0).max(1000).default(0),
    isPrivate: z.boolean().default(false),
    data: z.record(z.string(), z.unknown())
  }).strict()).max(9)
    .refine((sections) => new Set(sections.map(({ type }) => type)).size === sections.length)
});
const publishSchema = requestSchema(emptyObject, idParams);

function cleanContent(value, key = '', depth = 0) {
  if (depth > 5) throw new Error('Portfolio content is nested too deeply.');
  if (typeof value === 'string') {
    const text = value.replace(/<[^>]*>/g, '').trim();
    if (text.length > 4000) throw new Error('Portfolio text must be 4,000 characters or fewer.');
    if (/(?:url|href|link|src)$/i.test(key) && text && !/^https:\/\//i.test(text)) {
      throw new Error('Portfolio links must use HTTPS.');
    }
    return text;
  }
  if (Array.isArray(value)) {
    if (value.length > 100) throw new Error('Portfolio lists may contain at most 100 items.');
    return value.map((item) => cleanContent(item, key, depth + 1));
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value);
    if (entries.length > 40) throw new Error('Portfolio sections may contain at most 40 fields.');
    return Object.fromEntries(entries.map(([childKey, childValue]) => [
      childKey.slice(0, 80),
      cleanContent(childValue, childKey, depth + 1)
    ]));
  }
  if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return value;
  throw new Error('Portfolio content contains an unsupported value.');
}

function readSections(portfolioId, includePrivate = true) {
  const privateFilter = includePrivate ? '' : 'AND is_private = 0';
  return database.prepare(`
    SELECT type, sort_order AS sortOrder, is_private AS isPrivate, data_json AS dataJson
    FROM portfolio_sections WHERE portfolio_id = ? ${privateFilter}
    ORDER BY sort_order, id
  `).all(portfolioId).map((section) => ({
    type: section.type,
    sortOrder: section.sortOrder,
    isPrivate: Boolean(section.isPrivate),
    data: JSON.parse(section.dataJson)
  }));
}

function readPortfolio(portfolioId) {
  const portfolio = database.prepare(`
    SELECT id, owner_user_id AS ownerUserId, slug, template_id AS templateId,
      status, created_at AS createdAt, updated_at AS updatedAt
    FROM portfolios WHERE id = ?
  `).get(portfolioId);
  return portfolio ? { ...portfolio, sections: readSections(portfolioId) } : null;
}

function isReservedSlug(slug) {
  return reservedSlugs.has(slug) || slug.startsWith('admin-') || slug.startsWith('platform-');
}

router.use(requirePlatformUser, (req, res, next) => {
  if (req.platformUser.role !== 'customer') {
    return res.status(403).json({ success: false, error: 'Customer account required.' });
  }
  return next();
});

router.get('/slugs/check', validateRequest(checkSlugSchema), (req, res) => {
  const { slug } = req.validated.query;
  const exists = database.prepare('SELECT 1 FROM portfolios WHERE slug = ? COLLATE NOCASE').get(slug);
  return res.json({ success: true, available: !exists && !isReservedSlug(slug) });
});

router.get('/', (req, res) => {
  const portfolios = database.prepare(`
    SELECT id FROM portfolios WHERE owner_user_id = ? ORDER BY updated_at DESC, id DESC
  `).all(req.platformUser.id).map(({ id }) => readPortfolio(id));
  return res.json({ success: true, portfolios });
});

router.post('/', validateRequest(createSchema), (req, res) => {
  const { slug, title } = req.validated.body;
  if (isReservedSlug(slug)) {
    return res.status(400).json({ success: false, error: 'That portfolio address is reserved.' });
  }
  try {
    const createPortfolio = database.transaction(() => {
      const result = database.prepare(`
        INSERT INTO portfolios (owner_user_id, slug)
        VALUES (?, ?)
      `).run(req.platformUser.id, slug);
      database.prepare(`
        INSERT INTO portfolio_sections (portfolio_id, type, sort_order, data_json)
        VALUES (?, 'hero', 0, ?)
      `).run(result.lastInsertRowid, JSON.stringify({ title }));
      return result.lastInsertRowid;
    });
    const id = createPortfolio();
    return res.status(201).json({ success: true, portfolio: readPortfolio(id) });
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ success: false, error: 'That portfolio address is already in use.' });
    }
    throw error;
  }
});

router.get('/:portfolioId', validateRequest(requestSchema(emptyObject, idParams)), (req, res) => {
  const portfolio = readPortfolio(req.validated.params.portfolioId);
  if (!portfolio || portfolio.ownerUserId !== req.platformUser.id) {
    return res.status(404).json({ success: false, error: 'Portfolio not found.' });
  }
  return res.json({ success: true, portfolio });
});

router.get('/:portfolioId/leads', validateRequest(requestSchema(emptyObject, idParams)), (req, res) => {
  const portfolio = database.prepare('SELECT owner_user_id AS ownerUserId FROM portfolios WHERE id = ?')
    .get(req.validated.params.portfolioId);
  if (!portfolio || portfolio.ownerUserId !== req.platformUser.id) {
    return res.status(404).json({ success: false, error: 'Portfolio not found.' });
  }
  const leads = database.prepare(`
    SELECT id, name_enc AS name, email_enc AS email, position_enc AS position,
      phone_enc AS phone, reason_enc AS reason, created_at AS createdAt
    FROM recruiter_contacts WHERE portfolio_id = ? AND owner_user_id = ?
    ORDER BY created_at DESC, id DESC LIMIT 500
  `).all(req.validated.params.portfolioId, req.platformUser.id).map((lead) => ({
    id: lead.id,
    name: decryptPrivateField(req.platformUser.id, lead.name),
    email: decryptPrivateField(req.platformUser.id, lead.email),
    position: decryptPrivateField(req.platformUser.id, lead.position),
    phone: decryptPrivateField(req.platformUser.id, lead.phone),
    reason: decryptPrivateField(req.platformUser.id, lead.reason),
    createdAt: lead.createdAt
  }));
  return res.json({ success: true, leads });
});

router.put('/:portfolioId', validateRequest(requestSchema(updateBodySchema, idParams)), (req, res) => {
  const { portfolioId } = req.validated.params;
  const current = database.prepare('SELECT owner_user_id AS ownerUserId FROM portfolios WHERE id = ?').get(portfolioId);
  if (!current || current.ownerUserId !== req.platformUser.id) {
    return res.status(404).json({ success: false, error: 'Portfolio not found.' });
  }
  const { slug, title } = req.validated.body;
  if (slug && isReservedSlug(slug)) {
    return res.status(400).json({ success: false, error: 'That portfolio address is reserved.' });
  }
  try {
    const updatePortfolio = database.transaction(() => {
      database.prepare('UPDATE portfolios SET slug = COALESCE(?, slug), updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run(slug || null, portfolioId);
      if (title !== undefined) {
        const hero = database.prepare("SELECT data_json FROM portfolio_sections WHERE portfolio_id = ? AND type = 'hero'")
          .get(portfolioId);
        const data = hero ? JSON.parse(hero.data_json) : {};
        data.title = title;
        database.prepare(`
          INSERT INTO portfolio_sections (portfolio_id, type, sort_order, data_json)
          VALUES (?, 'hero', 0, ?)
          ON CONFLICT (portfolio_id, type) DO UPDATE SET
            data_json = excluded.data_json, updated_at = CURRENT_TIMESTAMP
        `).run(portfolioId, JSON.stringify(data));
      }
    });
    updatePortfolio();
    return res.json({ success: true, portfolio: readPortfolio(portfolioId) });
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ success: false, error: 'That portfolio address is already in use.' });
    }
    throw error;
  }
});

router.put('/:portfolioId/sections', validateRequest(requestSchema(sectionsBodySchema, idParams)), (req, res) => {
  const { portfolioId } = req.validated.params;
  const ownsPortfolio = database.prepare('SELECT 1 FROM portfolios WHERE id = ? AND owner_user_id = ?')
    .get(portfolioId, req.platformUser.id);
  if (!ownsPortfolio) return res.status(404).json({ success: false, error: 'Portfolio not found.' });

  let encoded;
  try {
    encoded = req.validated.body.sections.map((section) => {
      const data = cleanContent(section.data);
      const dataJson = JSON.stringify(data);
      if (Buffer.byteLength(dataJson, 'utf8') > 30_000) {
        throw new Error('Each portfolio section must be 30 KB or smaller.');
      }
      return { ...section, dataJson };
    });
  } catch (error) {
    return res.status(400).json({ success: false, error: error.message });
  }

  database.transaction(() => {
    const upsert = database.prepare(`
      INSERT INTO portfolio_sections (portfolio_id, type, sort_order, data_json, is_private)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (portfolio_id, type) DO UPDATE SET
        sort_order = excluded.sort_order, data_json = excluded.data_json,
        is_private = excluded.is_private, updated_at = CURRENT_TIMESTAMP
    `);
    for (const section of encoded) {
      upsert.run(portfolioId, section.type, section.sortOrder, section.dataJson, Number(section.isPrivate));
    }
    database.prepare('UPDATE portfolios SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(portfolioId);
  })();
  return res.json({ success: true, portfolio: readPortfolio(portfolioId) });
});

router.put('/:portfolioId/publish', validateRequest(publishSchema), (req, res) => {
  const result = database.prepare(`
    UPDATE portfolios SET status = 'published', updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND owner_user_id = ?
  `).run(req.validated.params.portfolioId, req.platformUser.id);
  if (!result.changes) return res.status(404).json({ success: false, error: 'Portfolio not found.' });
  return res.json({ success: true, portfolio: readPortfolio(req.validated.params.portfolioId) });
});

router.put('/:portfolioId/unpublish', validateRequest(publishSchema), (req, res) => {
  const result = database.prepare(`
    UPDATE portfolios SET status = 'draft', updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND owner_user_id = ?
  `).run(req.validated.params.portfolioId, req.platformUser.id);
  if (!result.changes) return res.status(404).json({ success: false, error: 'Portfolio not found.' });
  return res.json({ success: true, portfolio: readPortfolio(req.validated.params.portfolioId) });
});

router.delete('/:portfolioId', validateRequest(publishSchema), (req, res) => {
  const result = database.prepare('DELETE FROM portfolios WHERE id = ? AND owner_user_id = ?')
    .run(req.validated.params.portfolioId, req.platformUser.id);
  if (!result.changes) return res.status(404).json({ success: false, error: 'Portfolio not found.' });
  return res.json({ success: true });
});

export default router;