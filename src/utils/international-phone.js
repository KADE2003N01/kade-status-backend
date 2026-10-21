import { parsePhoneNumberFromString } from 'libphonenumber-js';

/** Accept any valid international number in E.164 form (+ followed by digits). */
export function parseInternationalPhone(value) {
  if (typeof value !== 'string' || !value.startsWith('+')) return undefined;
  const parsed = parsePhoneNumberFromString(value);
  return parsed?.isValid() ? parsed : undefined;
}

// Compatibility alias for older integrations.
export const parseEastAfricanPhone = parseInternationalPhone;
