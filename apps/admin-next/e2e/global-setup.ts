import { access } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Fails fast when the SPA bundle is missing: every spec server serves `dist/`,
 * so run `pnpm run admin:build` first.
 */
export default async function globalSetup(): Promise<void> {
  await access(join(import.meta.dirname, '..', 'dist', 'index.html'));
}
