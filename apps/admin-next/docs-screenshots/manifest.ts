/**
 * Publishes one screenshot run: validates the staged files, writes the
 * manifest and only then replaces the docs site's public directory.
 *
 * The manifest (`apps/docs/content/public/screenshots/manifest.json`) records
 * what each screenshot shows, which doc pages use it and which build produced
 * it. It is generated from the scenario catalog, never hand-edited, and carries
 * run metadata instead of a timestamp so a re-run with the same inputs writes
 * the same bytes: no dates, no ports, no random ids.
 *
 * A failed or focused run never publishes: its files stay in the staging
 * directory and the committed images are left alone.
 */
import { execFileSync } from 'node:child_process';
import { cp, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';
import { chromium } from '@playwright/test';
import { checkScreenshotAssets } from '../../../scripts/docs/screenshot-assets.ts';
import { DOCS_LOCALES } from '../e2e/docs-locale.ts';
import { SCREENSHOTS_DIR, SCREENSHOTS_STAGING_DIR } from './capture.ts';
import { DOCS_DEVICE_SCALE_FACTOR, DOCS_VIEWPORT } from './run-settings.ts';
import { DOCS_SCENARIOS } from './scenarios.ts';

const REPOSITORY_ROOT = join(import.meta.dirname, '..', '..', '..');
const MANIFEST_NAME = 'manifest.json';

export interface ScreenshotManifest {
  readonly version: 1;
  readonly generator: {
    /** Source commit the screenshots were taken from. */
    readonly commit: string;
    readonly playwright: string;
    readonly chromium: string;
    readonly platform: string;
    readonly viewport: { readonly width: number; readonly height: number };
    readonly device_scale_factor: number;
    /** The working tree had uncommitted changes (the screenshots directory excluded). */
    readonly worktree_dirty: boolean;
  };
  readonly scenarios: readonly {
    readonly id: string;
    readonly description: string;
    readonly target: string;
    readonly locales: readonly string[];
    readonly pages: readonly string[];
  }[];
}

/** Removes files from a previous run before capturing starts. */
export async function resetStagingDirectory(): Promise<void> {
  await rm(SCREENSHOTS_STAGING_DIR, { recursive: true, force: true });
}

/**
 * Whether the source tree (the screenshots directory excluded: this run is
 * about to replace it) has uncommitted work. A local run builds the working
 * tree, so recording only the commit would misattribute the images.
 */
export function worktreeDirty(): boolean {
  const status = execFileSync(
    'git',
    ['status', '--porcelain', '--untracked-files=normal', '--', '.', ':(exclude)apps/docs/content/public/screenshots'],
    { cwd: REPOSITORY_ROOT, encoding: 'utf8' },
  );
  return status.trim().length > 0;
}

function gitCommit(): string {
  return execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: REPOSITORY_ROOT, encoding: 'utf8' }).trim();
}

function playwrightVersion(): string {
  const require = createRequire(import.meta.url);
  const manifest = require('@playwright/test/package.json') as { version: string };
  return manifest.version;
}

/** The Chromium a capture actually runs on (no build metadata assumption). */
async function chromiumVersion(): Promise<string> {
  const browser = await chromium.launch();
  try {
    return browser.version();
  } finally {
    await browser.close();
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).size > 0;
  } catch {
    return false;
  }
}

/** The expected files a run did not capture. */
async function missingScreenshots(): Promise<string[]> {
  const missing: string[] = [];
  for (const scenario of DOCS_SCENARIOS) {
    for (const locale of DOCS_LOCALES) {
      const file = `${scenario.id}.${locale}.light.png`;
      if (!(await exists(join(SCREENSHOTS_STAGING_DIR, file)))) {
        missing.push(file);
      }
    }
  }
  return missing;
}

async function writeManifest(directory: string): Promise<void> {
  const manifest: ScreenshotManifest = {
    version: 1,
    generator: {
      commit: gitCommit(),
      playwright: playwrightVersion(),
      chromium: await chromiumVersion(),
      platform: `${process.platform}-${process.arch}`,
      viewport: DOCS_VIEWPORT,
      device_scale_factor: DOCS_DEVICE_SCALE_FACTOR,
      worktree_dirty: process.env.SUROWAN_DOCS_WORKTREE_DIRTY === '1',
    },
    scenarios: DOCS_SCENARIOS.map((scenario) => ({
      id: scenario.id,
      description: scenario.description,
      target: scenario.target,
      locales: DOCS_LOCALES,
      pages: scenario.pages,
    })),
  };
  await writeFile(join(directory, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

/** Replaces the public directory with the staged one; a rename is the normal path. */
async function replaceDirectory(source: string, target: string): Promise<void> {
  await rm(target, { recursive: true, force: true });
  try {
    await rename(source, target);
  } catch {
    // Different volumes (or a lock): copy, then drop the staging copy.
    await cp(source, target, { recursive: true });
    await rm(source, { recursive: true, force: true });
  }
}

/**
 * Ends a run. Throws when any scenario is missing or the staged set does not
 * validate, so the public directory keeps the previous, known-good images.
 * `DOCS_SHOTS_ALLOW_INCOMPLETE=1` is for focused local runs: it reports where
 * the staged files are and publishes nothing.
 */
export async function publishScreenshots(): Promise<void> {
  const missing = await missingScreenshots();
  if (missing.length > 0) {
    const message = `docs:screenshots did not capture ${String(missing.length)} expected file(s):\n${missing.join('\n')}`;
    if (process.env.DOCS_SHOTS_ALLOW_INCOMPLETE === '1') {
      console.warn(
        `${message}\n\nStaged files kept at ${SCREENSHOTS_STAGING_DIR}. The published screenshots were not touched.`,
      );
      return;
    }
    throw new Error(message);
  }

  await writeManifest(SCREENSHOTS_STAGING_DIR);
  const report = await checkScreenshotAssets({
    directory: SCREENSHOTS_STAGING_DIR,
    expectedIds: DOCS_SCENARIOS.map((scenario) => scenario.id),
  });
  if (!report.ok) {
    throw new Error(`Refusing to publish an invalid screenshot set:\n${report.errors.join('\n')}`);
  }
  await replaceDirectory(SCREENSHOTS_STAGING_DIR, SCREENSHOTS_DIR);
  console.log(
    `docs:screenshots published ${String(report.scenarioCount)} scenarios (${String(report.fileCount)} PNGs) to ` +
      `${relative(REPOSITORY_ROOT, SCREENSHOTS_DIR)}`,
  );
}
