/**
 * The docs screenshot fixture: the shared E2E backend, pinned to one
 * documentation locale per Playwright project.
 *
 * It adds three guarantees on top of `e2e/helpers.ts`:
 *
 * - the panel opens in the project's language (`admin-language`) and in the
 *   light theme (`admin-theme`) before the first navigation, with the browser
 *   locale agreeing, so nothing depends on machine settings;
 * - the server under test was seeded with the same locale's synthetic data
 *   (`test.use({ seedLocale })` in `playwright.docs.config.ts`);
 * - the browser only ever talks to the loopback admin server. Every other
 *   origin is aborted, so a page that tries a real provider or CDN fails the
 *   run instead of producing a screenshot that proves nothing.
 */
import { expect, type Page } from '@playwright/test';
import { isDocsLocale, type DocsLocale } from '../e2e/docs-locale.ts';
import { prepareServer, test as e2eTest } from '../e2e/helpers.ts';

/** Hosts the fixture server may legitimately bind (`localhost` in passkeys mode). */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

export const test = e2eTest.extend<{ serverReady: boolean }, { docLocale: DocsLocale }>({
  // Boot this file's server with the project's options before any other
  // fixture or hook runs, so the locale seed applies even to specs that never
  // sign in and to helpers called before the first page exists.
  serverReady: [
    async ({ mcpImages, mcpManager, seedLocale, docsRuns, passkeys, adminUsername }, use) => {
      await prepareServer({ mcpImages, mcpManager, seedLocale, docsRuns, passkeys, adminUsername });
      await use(true);
    },
    { auto: true },
  ],
  docLocale: [
    // The project name is the documentation locale; deriving it here keeps the
    // browser language, the seeded server data and the output file name in one
    // place (see `projects` in playwright.docs.config.ts).
    // biome-ignore lint/correctness/noEmptyPattern: Playwright's fixture signature always destructures the fixture object.
    async ({}, use, workerInfo) => {
      const name = workerInfo.project.name;
      if (!isDocsLocale(name)) {
        throw new Error(`Docs screenshot projects must be named zh-CN or en, not "${name}"`);
      }
      await use(name);
    },
    { scope: 'worker' },
  ],

  context: async ({ context, docLocale }, use) => {
    await context.addInitScript(
      ({ language }) => {
        window.localStorage.setItem('admin-language', language);
        window.localStorage.setItem('admin-theme', 'light');
        // Koi's own theme hint, in case the panel or a shell reads it.
        window.localStorage.setItem('koi-theme', 'light');
      },
      { language: docLocale },
    );
    await use(context);
  },

  page: async ({ page }, use) => {
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if ((url.protocol === 'http:' || url.protocol === 'https:') && !LOOPBACK_HOSTS.has(url.hostname)) {
        await route.abort('blockedbyclient');
        return;
      }
      await route.continue();
    });
    await use(page);
  },
});

export { expect };

/** The response body of a same-origin admin API read, parsed. */
export async function apiJson<T>(page: Page, url: string): Promise<T> {
  const response = await page.request.get(url);
  expect(response.ok(), `${url} answered HTTP ${String(response.status())}`).toBe(true);
  return (await response.json()) as T;
}
