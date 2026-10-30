import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import database from '../database/database.js';

export const RECRUITER_SESSION_COOKIE = 'digital_status_recruiter_session';
export const RECRUITER_SESSION_DURATION_MS = 2 * 60 * 60 * 1000;

function configuredSecret(name) {
  const value = process.env[name] || '';
  if (value.length < 32) {
    const error = new Error(`${name} must be configured with at least 32 characters.`);
    error.status = 503;
    throw error;
  }
  return value;
}

function masterKey() {
  const value = configuredSecret('MASTER_KEY');
  if (!/^[a-f\d]{64}$/i.test(value)) {
    const error = new Error('MASTER_KEY must be a 32-byte hexadecimal value.');
    error.status = 503;
    throw error;
  }
  return Buffer.from(value, 'hex');
}

function seal(value, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(value), cipher.final()]);
  return `v1:${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${ciphertext.toString('hex')}`;
}

function unseal(value, key) {
  const [version, ivHex, tagHex, ciphertextHex] = value.split(':');
  if (version !== 'v1' || !ivHex || !tagHex || !ciphertextHex) {
    throw new Error('Encrypted portfolio data has an invalid format.');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextHex, 'hex')),
    decipher.final()
  ]);
}

function userDataKey(userId) {
  const wrappingKey = masterKey();
  let record = database.prepare('SELECT wrapped_data_key AS wrappedDataKey FROM user_keys WHERE user_id = ?').get(userId);
  if (!record) {
    const generatedKey = randomBytes(32);
    database.prepare(`
      INSERT OR IGNORE INTO user_keys (user_id, wrapped_data_key)
      VALUES (?, ?)
    `).run(userId, seal(generatedKey, wrappingKey));
    record = database.prepare('SELECT wrapped_data_key AS wrappedDataKey FROM user_keys WHERE user_id = ?').get(userId);
  }
  return unseal(record.wrappedDataKey, wrappingKey);
}

export function hashRecruiterEmail(email) {
  return createHmac('sha256', configuredSecret('OTP_HMAC_SECRET'))
    .update(email.trim().toLowerCase())
    .digest('hex');
}

export function hashRecruiterCode(portfolioId, emailHash, code) {
  return createHmac('sha256', configuredSecret('OTP_HMAC_SECRET'))
    .update(`${portfolioId}:${emailHash}:${code}`)
    .digest();
}

export function createRecruiterCode() {
  return String(randomInt(100000, 1000000));
}

export function isRecruiterCodeValid(portfolioId, emailHash, code, storedHash) {
  const expected = hashRecruiterCode(portfolioId, emailHash, code);
  const actual = Buffer.from(storedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function encryptPrivateField(userId, value) {
  return seal(Buffer.from(value, 'utf8'), userDataKey(userId));
}

export function decryptPrivateField(userId, value) {
  return unseal(value, userDataKey(userId)).toString('utf8');
}

export function hashRecruiterSession(token) {
  return createHmac('sha256', configuredSecret('SESSION_SECRET')).update(token).digest('hex');
}
