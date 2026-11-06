import { getUserPlanId } from './space-plan-limits.js';

export const ACCOUNT_PAGE_IDS = [
  'overview',
  'profile',
  'security',
  'subscription',
  'benefits',
  'chat',
  'settings',
  'support',
  'support-chat',
  'gallery'
];

export const ACCOUNT_PAGE_DEFAULTS = {
  free: ['overview', 'profile', 'security', 'subscription', 'benefits', 'settings', 'support'],
  standard: ['overview', 'profile', 'security', 'subscription', 'benefits', 'settings', 'support', 'gallery'],
  professional: ['overview', 'profile', 'security', 'subscription', 'benefits', 'chat', 'settings', 'support', 'support-chat', 'gallery']
};

const PLAN_IDS = Object.keys(ACCOUNT_PAGE_DEFAULTS);

export function getPlanAccountPages(database, planId) {
  const plan = PLAN_IDS.includes(planId) ? planId : 'free';
  const rows = database.prepare(`SELECT page_id AS pageId
    FROM platform_plan_account_pages WHERE plan_id = ? AND enabled = 1 ORDER BY rowid`).all(plan);
  return rows.length ? rows.map((row) => row.pageId) : [...ACCOUNT_PAGE_DEFAULTS[plan]];
}

export function getAllPlanAccountPages(database) {
  return Object.fromEntries(PLAN_IDS.map((planId) => [planId, getPlanAccountPages(database, planId)]));
}

export function canAccessAccountPage(database, userId, pageId) {
  const planId = getUserPlanId(database, userId);
  const pages = getPlanAccountPages(database, planId);
  return pages.includes(pageId) && (pageId !== 'support-chat' || pages.includes('support'));
}

export function requireAccountPage(database, pageId) {
  return (req, res, next) => {
    if (!canAccessAccountPage(database, req.platformUser.id, pageId)) {
      return res.status(403).json({ success: false, error: 'This page is not included in your current account access.' });
    }
    return next();
  };
}
