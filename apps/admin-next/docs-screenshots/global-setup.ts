import { access, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { SCREENSHOTS_STAGING_DIR } from './capture.ts';
import { resetStagingDirectory, worktreeDirty } from './manifest.ts';

/**
 * Prepares the run: fails fast when the SPA bundle is missing (every spec
 * server serves `dist/`, exactly like the E2E suite), clears the previous
 * staging directory and records whether the source tree was dirty. Nothing in
 * the docs tree is touched here: only a complete run publishes (see
 * `global-teardown.ts`).
 */
export default async function globalSetup(): Promise<void> {
  await access(join(import.meta.dirname, '..', 'dist', 'index.html'));
  await resetStagingDirectory();
  await mkdir(SCREENSHOTS_STAGING_DIR, { recursive: true });
  process.env.SUROWAN_DOCS_WORKTREE_DIRTY = worktreeDirty() ? '1' : '0';
}
