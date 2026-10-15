import { existsSync } from 'node:fs';
import { mkdirSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const backendDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Vercel serverless filesystems are read-only except for /tmp, and /tmp is
 * wiped between invocations/instances. This helper picks the correct location
 * for each stored file:
 *
 *  - Local dev: the normal project folder (persistent across restarts).
 *  - Vercel: /tmp/<folder>, seeded from the bundled copy of the file when one
 *    exists in the deployment bundle (read-only) so previously uploaded files
 *    keep working until the instance is recycled.
 */
export function resolveWritablePath(relativeFolder, filename) {
  const bundledPath = path.join(backendDirectory, relativeFolder, filename);
  if (!process.env.VERCEL) {
    mkdirSync(path.dirname(bundledPath), { recursive: true });
    return bundledPath;
  }

  const tmpPath = path.join('/tmp', relativeFolder, filename);
  mkdirSync(path.dirname(tmpPath), { recursive: true });
  if (!existsSync(tmpPath) && existsSync(bundledPath)) {
    try {
      copyFileSync(bundledPath, tmpPath);
    } catch (error) {
      console.error(`Could not seed /tmp copy of ${relativeFolder}/${filename}:`, error.message);
    }
  }
  return tmpPath;
}

/** Directory where NEW uploads should be written. */
export function resolveWritableDirectory(relativeFolder) {
  if (!process.env.VERCEL) {
    const dir = path.join(backendDirectory, relativeFolder);
    mkdirSync(dir, { recursive: true });
    return dir;
  }
  const dir = path.join('/tmp', relativeFolder);
  mkdirSync(dir, { recursive: true });
  return dir;
}
