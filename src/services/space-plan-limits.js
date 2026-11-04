// Server-side single source of truth for FolioSpace plan limits (Pattern C in
// SUBSCRIPTION_PLAN.md). Mirrors my-digital-status/src/services/spacePlans.js —
// keep the two shapes identical so frontend UX and backend law never drift.
const FREE_SECTIONS = ['hero', 'about', 'skills', 'contact'];
const STANDARD_SECTIONS = [...FREE_SECTIONS, 'experience', 'education', 'projects'];
const PROFESSIONAL_SECTIONS = [...STANDARD_SECTIONS, 'certificates', 'video_pitch'];

export const spacePlanLimits = {
  free: {
    maxSpaces: 1,
    sections: FREE_SECTIONS,
    templates: ['classic'],
    watermark: true,
    customColors: false,
    visitorStats: false,
    privateSections: false,
    subdomain: false,
    customDomain: false,
    seoControls: false,
    pdfExport: false,
    qrCode: false,
    priorityPlacement: false,
    branding: false
  },
  standard: {
    maxSpaces: 3,
    sections: STANDARD_SECTIONS,
    templates: ['classic', 'studio'],
    watermark: false,
    customColors: true,
    visitorStats: true,
    privateSections: true,
    subdomain: true,
    customDomain: false,
    seoControls: false,
    pdfExport: false,
    qrCode: false,
    priorityPlacement: false,
    branding: false
  },
  professional: {
    maxSpaces: -1, // -1 means unlimited on the server (JSON-safe)
    sections: PROFESSIONAL_SECTIONS,
    templates: ['classic', 'studio', 'executive'],
    watermark: false,
    customColors: true,
    visitorStats: true,
    privateSections: true,
    subdomain: true,
    customDomain: true,
    seoControls: true,
    pdfExport: true,
    qrCode: true,
    priorityPlacement: true,
    branding: true
  }
};

const planRank = { free: 0, standard: 1, professional: 2 };

// Read the plan the subscriptions table grants this user. The record is the
// law: whatever state it holds, the gates follow it — no client header is trusted.
export function getUserPlanRow(database, userId) {
  return database.prepare(`
    SELECT s.plan_id AS planId, s.state AS state, s.period_end AS periodEnd
    FROM subscriptions s
    WHERE s.user_id = ?
  `).get(userId);
}

export function getUserPlanId(database, userId) {
  const row = getUserPlanRow(database, userId);
  if (!row) return 'free';
  // An expired paid period falls back to Free rather than hard-locking the
  // account (downgrade-friendly presentation, Pattern D).
  if (row.state === 'active' || row.state === 'grace') return row.planId;
  if (row.state === 'free' || row.state === 'cancelled') {
    return row.planId === 'free' ? 'free' : 'free';
  }
  return 'free';
}

export function getPlanLimits(database, userId) {
  return spacePlanLimits[getUserPlanId(database, userId)] || spacePlanLimits.free;
}

export function planAllowsFeature(limits, feature) {
  return Boolean(limits[feature]);
}

export function planAllowsSection(limits, sectionType) {
  return limits.sections.includes(sectionType);
}

// Can this user create another portfolio space?
export function canCreateSpace(limits, ownedCount) {
  if (limits.maxSpaces === -1) return true;
  return ownedCount < limits.maxSpaces;
}

// The plan to suggest when a gate blocks the user.
export function minimumPlanForFeature(feature) {
  for (const [planId, limits] of Object.entries(spacePlanLimits)) {
    if (planAllowsFeature(limits, feature)) return planId;
  }
  return 'professional';
}

export function minimumPlanForSection(sectionType) {
  for (const [planId, limits] of Object.entries(spacePlanLimits)) {
    if (planAllowsSection(limits, sectionType)) return planId;
  }
  return 'professional';
}

export { planRank };
