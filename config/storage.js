import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const backendDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Store files under the backend directory locally. In production, mount a
 * Render persistent disk over these directories so uploads survive redeploys.
 */
export function resolveWritablePath(relativeFolder, filename) {
  const bundledPath = path.join(backendDirectory, relativeFolder, filename);
  mkdirSync(path.dirname(bundledPath), { recursive: true });
  return bundledPath;
}

/** Directory where NEW uploads should be written. */
export function resolveWritableDirectory(relativeFolder) {
  const dir = path.join(backendDirectory, relativeFolder);
  mkdirSync(dir, { recursive: true });
  return dir;
}
