import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const backendDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const storageRoot = process.env.STORAGE_DIR
  ? path.resolve(process.env.STORAGE_DIR)
  : backendDirectory;

/**
 * Store files under the backend directory locally. Set STORAGE_DIR to a
 * persistent mount path in production so uploads survive redeploys.
 */
export function resolveWritablePath(relativeFolder, filename) {
  const writablePath = path.join(storageRoot, relativeFolder, filename);
  mkdirSync(path.dirname(writablePath), { recursive: true });
  if (!existsSync(writablePath) && storageRoot !== backendDirectory) {
    const fallbackSource = path.join(backendDirectory, relativeFolder, filename);
    if (existsSync(fallbackSource)) {
      try {
        copyFileSync(fallbackSource, writablePath);
      } catch {}
    }
  }
  return writablePath;
}

/** Directory where NEW uploads should be written. */
export function resolveWritableDirectory(relativeFolder) {
  const dir = path.join(storageRoot, relativeFolder);
  mkdirSync(dir, { recursive: true });
  return dir;
}
