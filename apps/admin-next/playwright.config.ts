import { availableParallelism, tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from '@playwright/test';

/**
 * Playwright browser smoke for the Admin Panel. The suite drives the real
 * `AdminServer` + real `SqliteStore` + `test/fixtures/admin-seed.ts` synthetic
 * data through the built SPA (`dist/`), served with the production CSP.
 *
 * It is deliberately text-free: no spec asserts visible copy, an accessible name
 * or a layout, so UI wording and design work never edit a test. What remains is
 * the sign-in state machine (`00-auth`), one render smoke per panel route
 * (`01-routes`), and the `admin:dev:mock` launcher lifecycle (`30-dev-mock`).
 *
 * - Every spec file gets its own freshly seeded `e2e/server.ts` process on a
 *   random loopback port (started by `e2e/helpers.ts`), so files share no
 *   state and run in parallel on every core; tests inside a file stay serial.
 * - `30-dev-mock` drives the fixed port 127.0.0.1:5273 and must run on its own
 *   with `--workers=1`.
 * - `globalSetup` only checks that the SPA bundle has been built.
 * - `*.e2e.ts` is excluded from vitest discovery (separate directory,
 *   non-`.test.ts` names) and this `testMatch`.
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.e2e.ts',
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: false,
  workers: availableParallelism(),
  reporter: 'list',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  // Keep all artifacts out of the repo.
  outputDir: join(tmpdir(), 'surowan-admin-e2e-results'),
  use: {
    // Artifacts stay in `outputDir` (outside the repo), written on failure only.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    // Pin the browser locale so the SPA's navigator-language detection always
    // resolves to English, independent of the machine running the suite.
    locale: 'en-US',
  },
});
