import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, type Request } from '@playwright/test';
import { adminUrl, test, watchPageIssues } from './helpers.ts';

/**
 * One smoke test per panel route: the built bundle renders that route under the
 * production CSP with a signed-in session, and it stays read-only and
 * same-origin while doing so.
 *
 * Nothing here reads visible copy, an accessible name or a locale. A route
 * "rendered" means its `<main>` has content, the router fell through to no error
 * boundary, every `/api/` answer was a success and the page produced no console
 * error, no uncaught error, no write call and no cross-origin request.
 *
 * A last test keeps the table complete by walking `src/routes/`, so a new page
 * cannot ship without its smoke test.
 */
test.use({ signedIn: true });

interface RouteCase {
  readonly path: string;
  /** Answers the route's read probes in-process, before it navigates. */
  readonly stub?: (page: Page) => Promise<void>;
}

/**
 * Answers one `/api/image*` read: the shared fixture runs no image service, so
 * the image routes answer 503 there (and the browser logs the failure as a
 * console error). That is a fixture gap, not a page defect, so the smoke stubs
 * the exact read instead of loosening an assertion for every route.
 */
async function stubImageRead(page: Page, path: string | RegExp, body: unknown): Promise<void> {
  await page.route(path, (route) => route.fulfill({ json: body }));
}

const ROUTES: readonly RouteCase[] = [
  { path: '/' },
  { path: '/warnings' },
  { path: '/invocations' },
  { path: '/invocations/4001' },
  { path: '/contexts' },
  { path: '/contexts/2001' },
  { path: '/messages' },
  { path: '/messages/6001' },
  { path: '/alarms' },
  { path: '/recurring-alarms' },
  { path: '/memories' },
  { path: '/group-memories' },
  { path: '/dictionary' },
  { path: '/reviews' },
  { path: '/search-settings' },
  { path: '/prompts' },
  { path: '/admins' },
  { path: '/chats' },
  { path: '/telegram' },
  { path: '/models' },
  { path: '/providers' },
  { path: '/stickers' },
  // The shared fixture runs no image service (`/api/image` answers 503, and the
  // browser logs that as a console error), so answer the read probes with an
  // enabled service and two empty lists: the page then renders its real list
  // state instead of a fixture gap.
  {
    path: '/image-assets',
    stub: async (page) => {
      await stubImageRead(page, '**/api/image/status', { enabled: true, models: [] });
      await stubImageRead(page, /\/api\/image\/prompts\?/, { items: [], total: 0, limit: 20, offset: 0 });
      await stubImageRead(page, /\/api\/image\/images\?/, { items: [], total: 0, limit: 20, offset: 0 });
    },
  },
  // Same fixture gap: the settings form reads the capability status. The config
  // itself (`/api/image/config`) is served for real from the fixture's file.
  {
    path: '/image-settings',
    stub: (page) => stubImageRead(page, '**/api/image/status', { enabled: false, models: [] }),
  },
  // Same gap: the page reads the capability status, the prompt picker and the
  // reference-image picker's recent assets.
  {
    path: '/image-generate',
    stub: async (page) => {
      await stubImageRead(page, '**/api/image/status', { enabled: false, models: [] });
      await stubImageRead(page, /\/api\/image\/prompts\?/, { items: [], total: 0, limit: 50, offset: 0 });
      await stubImageRead(page, /\/api\/image\/images\?/, { items: [], total: 0, limit: 20, offset: 0 });
    },
  },
  // Same gap: the generation list (the fixture seeds no generations).
  {
    path: '/image-generations',
    stub: (page) => stubImageRead(page, /\/api\/image\/generations\?/, { items: [], total: 0, limit: 20, offset: 0 }),
  },
  // Same gap: the fixture seeds no generation, so the detail read is answered
  // with the smallest record the page renders (no outputs, attempts or images).
  {
    path: '/image-generations/e2e-generation',
    stub: (page) =>
      stubImageRead(page, '**/api/image/generations/e2e-generation', {
        id: 'e2e-generation',
        status: 'succeeded',
        source: 'panel',
        actorName: '',
        createdAt: '2024-01-01T00:00:00.000Z',
        finishedAt: null,
        snapshot: {
          authored: { authoredPrompt: '', modelId: '', aspectRatio: '', resolution: '', outputCount: 0 },
          resolvedPrompt: '',
          finalPrompt: '',
          promptAssets: [],
          imageAssets: [],
        },
        outputs: [],
        attempts: [],
        error: null,
      }),
  },
  { path: '/settings' },
  { path: '/keychain' },
  { path: '/developer' },
  { path: '/decision-gate' },
  { path: '/harness' },
  { path: '/mcp-servers' },
  { path: '/preferences' },
  { path: '/playground' },
  { path: '/api-keys' },
];

interface ApiTraffic {
  /** Every `/api/` answer that is not a long-lived event stream. */
  readonly responses: { path: string; status: number }[];
  /** `/api/` requests that have neither answered nor finished. */
  readonly inflight: Set<Request>;
}

function isApiRequest(request: Request): boolean {
  try {
    return new URL(request.url()).pathname.startsWith('/api/');
  } catch {
    return false;
  }
}

/** Records the route's own API traffic, excluding streams that never end. */
function trackApiTraffic(page: Page): ApiTraffic {
  const traffic: ApiTraffic = { responses: [], inflight: new Set() };
  page.on('request', (request) => {
    if (isApiRequest(request)) {
      traffic.inflight.add(request);
    }
  });
  page.on('response', (response) => {
    if (!isApiRequest(response.request())) {
      return;
    }
    // A live-refresh stream answers once and then stays open by design: it is
    // neither a first-load answer nor something to wait for.
    if ((response.headers()['content-type'] ?? '').includes('text/event-stream')) {
      traffic.inflight.delete(response.request());
      return;
    }
    traffic.responses.push({ path: new URL(response.url()).pathname, status: response.status() });
  });
  const settle = (request: Request): void => {
    traffic.inflight.delete(request);
  };
  page.on('requestfinished', settle);
  page.on('requestfailed', settle);
  return traffic;
}

/**
 * Waits for the first load to settle: at least one `/api/` answer arrived,
 * nothing is in flight, and that stays true across two samples. The shell
 * renders as soon as the session answers, before the route issues its own
 * requests, so a single quiet sample could be the gap between the two waves.
 */
async function waitForFirstLoad(path: string, traffic: ApiTraffic): Promise<void> {
  let quietSamples = 0;
  await expect
    .poll(
      () => {
        quietSamples = traffic.inflight.size === 0 && traffic.responses.length > 0 ? quietSamples + 1 : 0;
        return quietSamples;
      },
      {
        message: `${path} never finished its first load without pending /api/ requests`,
        intervals: [100, 100, 200, 200, 500],
      },
    )
    .toBeGreaterThanOrEqual(2);
}

for (const route of ROUTES) {
  test(`${route.path} renders under the production CSP`, async ({ page }) => {
    const traffic = trackApiTraffic(page);
    const finishWatching = watchPageIssues(page);
    await route.stub?.(page);

    await page.goto(await adminUrl(route.path));
    await waitForFirstLoad(route.path, traffic);

    const main = page.locator('main');
    await expect(main).toBeVisible();
    expect(
      await main.evaluate((element) => element.children.length),
      `${route.path} rendered an empty main`,
    ).toBeGreaterThan(0);
    await expect(page.locator('[data-route-error]')).toHaveCount(0);

    const failed = traffic.responses.filter((response) => response.status >= 400);
    expect(failed, JSON.stringify(failed)).toEqual([]);

    const issues = finishWatching();
    expect(issues.writeApiCalls, JSON.stringify(issues.writeApiCalls)).toEqual([]);
    expect(issues.externalRequests, JSON.stringify(issues.externalRequests)).toEqual([]);
    expect(issues.consoleErrors, JSON.stringify(issues.consoleErrors)).toEqual([]);
    expect(issues.pageErrors, JSON.stringify(issues.pageErrors)).toEqual([]);
  });
}

/** `src/routes/`: the TanStack file routes this smoke has to stay complete with. */
const ROUTES_DIR = join(import.meta.dirname, '..', 'src', 'routes');

/**
 * The path pattern one route file answers, in this app's flat-file convention:
 * `index.tsx` is `/`, `foo.tsx` is `/foo`, and the non-nested `foo_.$param.tsx`
 * is `/foo/<one segment>`. `__root.tsx` is the shell and has no path of its own.
 */
function routePattern(file: string): RegExp {
  const base = file.slice(0, -'.tsx'.length);
  const [own, child] = base.split('_.');
  if (own === 'index') {
    return /^\/$/;
  }
  const prefix = `/${escapeRegExp(own ?? '')}`;
  return child === undefined ? new RegExp(`^${prefix}$`) : new RegExp(`^${prefix}/[^/]+$`);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// No page fixture: this test only reads the route directory and the table above.
test('every file under src/routes/ has a smoke entry', () => {
  const files = readdirSync(ROUTES_DIR).filter((file) => file.endsWith('.tsx') && file !== '__root.tsx');
  // An unreadable or emptied directory would otherwise pass the check below.
  expect(files.length, `no route files found in ${ROUTES_DIR}`).toBeGreaterThan(0);
  const missing = files.filter((file) => {
    const pattern = routePattern(file);
    return !ROUTES.some((route) => pattern.test(route.path));
  });
  expect(missing, `route files with no entry in ROUTES: ${missing.join(', ')}`).toEqual([]);
});
