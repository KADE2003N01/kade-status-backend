import { randomUUID } from 'node:crypto';
import { unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import database from '../../config/database.js';
import { resolveWritableDirectory, resolveWritablePath } from '../../config/storage.js';
import { defaultHomepageContent, validateHomepageContent } from '../../config/homepage-content.js';
import { requireAdmin } from '../Auth/auth.routes.js';

const router = express.Router();
const CONTENT_KEY = 'homepage';
const profileImagesDirectory = resolveWritableDirectory('profile-images');
const MAX_PROFILE_IMAGE_SIZE = 5 * 1024 * 1024;
const profileImageTypes = {
  'image/jpeg': { extension: 'jpg', matches: (buffer) => buffer[0] === 0xff && buffer[1] === 0xd8 && buffer.at(-2) === 0xff && buffer.at(-1) === 0xd9 },
  'image/png': {
    extension: 'png',
    matches: (buffer) => buffer.length >= 45
      && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      && buffer.toString('ascii', 12, 16) === 'IHDR'
      && buffer.readUInt32BE(16) > 0 && buffer.readUInt32BE(16) <= 8192
      && buffer.readUInt32BE(20) > 0 && buffer.readUInt32BE(20) <= 8192
      && buffer.subarray(-12, -8).equals(Buffer.from([0, 0, 0, 0]))
      && buffer.toString('ascii', buffer.length - 8, buffer.length - 4) === 'IEND'
  },
  'image/webp': {
    extension: 'webp',
    matches: (buffer) => buffer.length >= 30
      && buffer.toString('ascii', 0, 4) === 'RIFF'
      && buffer.readUInt32LE(4) === buffer.length - 8
      && buffer.toString('ascii', 8, 12) === 'WEBP'
  }
};

function publicApiBaseUrl() {
  const configuredUrl = process.env.PUBLIC_API_URL;
  if (!configuredUrl) return '';
  try {
    const url = new URL(configuredUrl);
    const isLocalHost = ['localhost', '127.0.0.1', '::1'].includes(url.hostname.toLowerCase());
    if (url.protocol !== 'https:' || isLocalHost) return '';
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return '';
  }
}

function readHomepageRecord() {
  const row = database.prepare('SELECT value_json, updated_at FROM portfolio_settings WHERE setting_key = ?').get(CONTENT_KEY);
  return row
    ? { content: JSON.parse(row.value_json), updatedAt: row.updated_at }
    : { content: defaultHomepageContent, updatedAt: null };
}

function readHomepageContent() {
  return readHomepageRecord().content;
}

function saveHomepageContent(content) {
  const updatedAt = new Date().toISOString();
  database.prepare(`
    INSERT INTO portfolio_settings (setting_key, value_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(setting_key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
  `).run(CONTENT_KEY, JSON.stringify(content), updatedAt);
  return updatedAt;
}

router.get('/', (req, res, next) => {
  try {
    return res.json({ success: true, ...readHomepageRecord() });
  } catch (error) {
    return next(error);
  }
});

router.get('/profile-image/:filename', (req, res, next) => {
  const filename = req.params.filename;
  if (!/^profile-[0-9a-f-]{36}\.(jpg|png|webp)$/.test(filename)) {
    return res.status(404).json({ success: false, error: 'Profile image not found.' });
  }
  const extension = path.extname(filename);
  const contentType = extension === '.jpg' ? 'image/jpeg' : `image/${extension.slice(1)}`;
  res.sendFile(resolveWritablePath('profile-images',  filename), {
    headers: {
      'Content-Type': contentType,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'public, max-age=31536000, immutable'
    }
  }, (error) => {
    if (error && !res.headersSent) {
      if (error.code === 'ENOENT') return res.status(404).json({ success: false, error: 'Profile image not found.' });
      return next(error);
    }
  });
});

router.put('/', requireAdmin, (req, res, next) => {
  try {
    const content = validateHomepageContent(req.body?.content);
    const updatedAt = saveHomepageContent(content);
    return res.json({ success: true, content, updatedAt });
  } catch (error) {
    return next(error);
  }
});

router.post('/profile-image', requireAdmin, async (req, res, next) => {
  let storedFilename;
  try {
    const dataUrl = typeof req.body?.image === 'string' ? req.body.image : '';
    const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
    if (!match) {
      return res.status(400).json({ success: false, error: 'Choose a valid JPG, PNG, or WebP profile image.' });
    }
    const [, mimeType, encoded] = match;
    if (encoded.length > Math.ceil(MAX_PROFILE_IMAGE_SIZE * 4 / 3) + 4) {
      return res.status(400).json({ success: false, error: 'The profile image must be 5 MB or smaller.' });
    }
    const content = Buffer.from(encoded, 'base64');
    if (!content.length || content.length > MAX_PROFILE_IMAGE_SIZE || !profileImageTypes[mimeType].matches(content)) {
      return res.status(400).json({ success: false, error: 'The uploaded file does not match a supported image format or exceeds 5 MB.' });
    }

    const { extension } = profileImageTypes[mimeType];
    storedFilename = `profile-${randomUUID()}.${extension}`;
    await writeFile(resolveWritablePath('profile-images',  storedFilename), content, { flag: 'wx' });

    const homepage = structuredClone(readHomepageContent());
    const previousImageUrl = homepage.brand.imageUrl;
    const imagePath = `/api/homepage/profile-image/${storedFilename}`;
    // A stale localhost PUBLIC_API_URL makes every visitor's browser request
    // the image from their own computer. Keep the image path relative unless
    // the configured API address is a valid public HTTPS URL.
    const publicApiBase = publicApiBaseUrl();
    homepage.brand.imageUrl = publicApiBase ? `${publicApiBase}${imagePath}` : imagePath;
    const updatedHomepage = validateHomepageContent(homepage);
    const updatedAt = saveHomepageContent(updatedHomepage);
    const previousFilename = typeof previousImageUrl === 'string'
      ? previousImageUrl.match(/\/api\/homepage\/profile-image\/(profile-[0-9a-f-]{36}\.(?:jpg|png|webp))$/)?.[1]
      : undefined;
    if (previousFilename && previousFilename !== storedFilename) {
      await unlink(resolveWritablePath('profile-images',  previousFilename)).catch((cleanupError) => {
        if (cleanupError.code !== 'ENOENT') console.error('Could not remove the replaced profile image:', cleanupError);
      });
    }
    return res.status(201).json({ success: true, imageUrl: updatedHomepage.brand.imageUrl, updatedAt });
  } catch (error) {
    if (storedFilename) {
      await unlink(resolveWritablePath('profile-images',  storedFilename)).catch((cleanupError) => {
        console.error('Could not clean up an unpublished profile image:', cleanupError);
      });
    }
    return next(error);
  }
});

router.post('/reset', requireAdmin, (req, res, next) => {
  try {
    const updatedAt = saveHomepageContent(defaultHomepageContent);
    return res.json({ success: true, content: defaultHomepageContent, updatedAt });
  } catch (error) {
    return next(error);
  }
});

export default router;
