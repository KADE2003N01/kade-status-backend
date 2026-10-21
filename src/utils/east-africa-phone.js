import { parsePhoneNumberFromString } from 'libphonenumber-js';

const EAST_AFRICAN_COUNTRIES = new Set(['BI', 'CD', 'KE', 'RW', 'SO', 'SS', 'TZ', 'UG']);

export function parseEastAfricanPhone(value) {
  if (typeof value !== 'string') return undefined;
  const parsed = parsePhoneNumberFromString(value);
  return parsed?.isValid() && EAST_AFRICAN_COUNTRIES.has(parsed.country) ? parsed : undefined;
}
