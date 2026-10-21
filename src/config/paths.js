import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const backendDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Resolve relative paths from the backend package, regardless of the shell's current directory. */
export function resolveBackendPath(configuredPath, fallbackPath) {
  const targetPath = configuredPath || fallbackPath;
  return path.isAbsolute(targetPath)
    ? targetPath
    : path.resolve(backendDirectory, targetPath);
}

export function getDatabasePath() {
  if (process.env.DATABASE_PATH) {
    return resolveBackendPath(process.env.DATABASE_PATH, path.join('data', 'portfolio.sqlite'));
  }
  if (process.env.STORAGE_DIR) {
    return path.join(path.resolve(process.env.STORAGE_DIR), 'portfolio.sqlite');
  }
  return resolveBackendPath(undefined, path.join('data', 'portfolio.sqlite'));
}
