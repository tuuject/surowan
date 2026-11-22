import { availableParallelism, tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from '@playwright/test';
import { DOCS_LOCALES } from './e2e/docs-locale.ts';
import { DOCS_DEVICE_SCALE_FACTOR, DOCS_VIEWPORT } from './docs-screenshots/run-settings.ts';

/**
 * The documentation screenshot suite. Separate from `playwright.config.ts` on
 * purpose: it is never part of `pnpm run admin:test:e2e` or vitest, and it
 * writes assets into the docs site instead of test output.
 *
 * It drives the built SPA against the same real `AdminServer` + temp SQLite +
 * Faux runtime as the E2E suite (`docs-screenshots/fixtures.ts` extends
 * `e2e/helpers.ts`). One project per documentation locale; the project name is
 * the locale the fixture uses for the browser language, the seeded synthetic
 * data and the file name, so the three can never disagree.
 *
 * Determinism: Chromium only, light theme, 1440x1000 at DPR 1, UTC, reduced
 * motion and `zh-CN`/`en-US` browser locales. Element and card screenshots are
 * preferred over full pages.
 */
export default defineConfig<
  { seedLocale: string | null; docsRuns: boolean; signedIn: boolean; adminUsername: string },
  object
>({
  testDir: './docs-screenshots',
  testMatch: '**/*.shot.ts',
  globalSetup: './docs-screenshots/global-setup.ts',
  globalTeardown: './docs-screenshots/global-teardown.ts',
  fullyParallel: false,
  workers: availableParallelism(),
  // `list` for the console, the local reporter for the teardown's verdict.
  reporter: [['list'], ['./docs-screenshots/reporter.ts']],
  timeout: 120_000,
  expect: { timeout: 15_000 },
  // Keep every artifact out of the repository; the PNGs are the only output.
  outputDir: join(tmpdir(), 'surowan-docs-screenshots-results'),
  use: {
    signedIn: true,
    seedLocale: null,
    // Only the specs whose shots document a failed or tool-using run seed them.
    docsRuns: false,
    // A presentable account name: it is visible in the shell's user menu.
    adminUsername: 'admin',
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
  projects: DOCS_LOCALES.map((locale) => ({
    name: locale,
    use: {
      seedLocale: locale,
      browserName: 'chromium',
      viewport: DOCS_VIEWPORT,
      deviceScaleFactor: DOCS_DEVICE_SCALE_FACTOR,
      locale: locale === 'zh-CN' ? 'zh-CN' : 'en-US',
      timezoneId: 'UTC',
      colorScheme: 'light',
      reducedMotion: 'reduce',
    },
  })),
});
