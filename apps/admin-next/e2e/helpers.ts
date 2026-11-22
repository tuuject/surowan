import { type ChildProcess, spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test as base, expect, type Locator, type Page } from '@playwright/test';

/** The administrator every spec signs in as (the account is created on demand). */
export const E2E_USERNAME = 'e2e-admin';
export const E2E_PASSWORD = 'e2e-correct-horse';

const READY_TIMEOUT_MS = 60_000;

interface RunningServer {
  /** The spec file this server belongs to; the next file gets a fresh one. */
  readonly file: string;
  readonly child: ChildProcess;
  readonly baseURL: string;
  readonly authFile: string;
  signedIn: boolean;
}

let current: RunningServer | null = null;
let serverCount = 0;

process.on('exit', () => {
  current?.child.kill('SIGTERM');
  if (current !== null) {
    rmSync(current.authFile, { force: true });
  }
});

/**
 * Options fixed when a file's server first boots. The docs screenshot suite
 * extends the fixture with `seedLocale` (localized synthetic rows) and
 * `passkeys` (a localhost origin with a WebAuthn RP id); the ordinary E2E
 * suites keep the defaults, so their fixture text and mode are unchanged.
 */
export interface ServerOptions {
  readonly mcpImages: boolean;
  readonly mcpManager: boolean;
  /** `E2E_SEED_LOCALE`: seed the docs suite's language-specific text. */
  readonly seedLocale: string | null;
  /** `E2E_DOCS_RUNS`: also seed the docs suite's failed and tool-using runs. */
  readonly docsRuns: boolean;
  /** `E2E_PASSKEYS`: bind localhost and set `admin.public_url` for real WebAuthn. */
  readonly passkeys: boolean;
  /** Username the fixture administrator is created with; the docs suite uses a presentable one. */
  readonly adminUsername: string;
}

export const DEFAULT_SERVER_OPTIONS: ServerOptions = {
  mcpImages: false,
  mcpManager: false,
  seedLocale: null,
  docsRuns: false,
  passkeys: false,
  adminUsername: E2E_USERNAME,
};

/**
 * Every spec file runs against its own freshly seeded E2E backend (real
 * AdminServer + SqliteStore + the synthetic fixture, see `e2e/server.ts`), so
 * files share no state and can run in parallel workers in any order. Within a
 * worker, files run one after another: the first call from a new file stops
 * the previous file's server and starts a new one. The server also exits on
 * its own when its stdin closes, so a killed worker leaves nothing behind.
 *
 * The options only apply to the first call for a file: every later call in the
 * same file reuses that server, so a fixture may set them once per file.
 */
async function ensureServer(options: ServerOptions = DEFAULT_SERVER_OPTIONS): Promise<RunningServer> {
  const file = base.info().file;
  if (current?.file === file) {
    return current;
  }
  if (current !== null) {
    current.child.kill('SIGTERM');
    await rm(current.authFile, { force: true });
    current = null;
  }
  const root = join(import.meta.dirname, '..');
  const child = spawn(process.execPath, [join(import.meta.dirname, 'server.ts')], {
    cwd: root,
    stdio: ['pipe', 'pipe', 'inherit'],
    windowsHide: true,
    env: {
      ...process.env,
      E2E_MCP_IMAGES: options.mcpImages ? '1' : '0',
      E2E_MCP_MANAGER: options.mcpManager ? '1' : '0',
      // Always explicit: a developer with `E2E_SEED_LOCALE` exported must not
      // silently turn the ordinary E2E suites into the docs seed. The passkeys
      // suite, by contrast, starts the server through its own inherited
      // `E2E_PASSKEYS=1`, so that one is only added when a fixture asks for it.
      E2E_SEED_LOCALE: options.seedLocale ?? '',
      E2E_DOCS_RUNS: options.docsRuns ? '1' : '0',
      ...(options.passkeys ? { E2E_PASSKEYS: '1' } : {}),
    },
  });
  const baseURL = await waitForReady(child);
  serverCount += 1;
  current = {
    file,
    child,
    baseURL,
    authFile: join(tmpdir(), `surowan-admin-e2e-${process.pid}-${serverCount}.auth.json`),
    signedIn: false,
  };
  return current;
}

function waitForReady(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    const fail = (message: string): void => {
      clearTimeout(timer);
      child.kill('SIGKILL');
      reject(new Error(`E2E server did not become ready: ${message}${stdout.length === 0 ? '' : `\n${stdout}`}`));
    };
    const timer = setTimeout(() => fail(`timed out after ${READY_TIMEOUT_MS} ms`), READY_TIMEOUT_MS);
    const onData = (chunk: string | Buffer): void => {
      stdout += String(chunk);
      const ready = stdout.match(/E2E_READY base=(\S+)/);
      if (ready?.[1] !== undefined) {
        clearTimeout(timer);
        child.stdout?.off('data', onData);
        child.off('exit', onExit);
        // Keep draining stdout so a chatty server never blocks on a full pipe.
        child.stdout?.resume();
        resolve(ready[1]);
      }
    };
    const onExit = (code: number | null): void => fail(`exited early with code ${String(code)}`);
    child.stdout?.on('data', onData);
    child.once('error', (error) => fail(error.message));
    child.once('exit', onExit);
  });
}

export async function adminBase(): Promise<string> {
  return (await ensureServer()).baseURL;
}

/**
 * Boots this file's server with the given options, without signing in. The
 * docs fixture calls it first for every file, so a `signedIn: false` spec (the
 * sign-in page) still gets its locale-seeded backend, and helpers that run
 * before any page can no longer boot the file's server with defaults.
 */
export async function prepareServer(options: ServerOptions = DEFAULT_SERVER_OPTIONS): Promise<string> {
  return (await ensureServer(options)).baseURL;
}

export async function adminUrl(path: string): Promise<string> {
  return `${await adminBase()}${path}`;
}

/** Creates the E2E administrator unless the spec's server already has an account. */
export async function ensureAdmin(baseURL?: string, username: string = E2E_USERNAME): Promise<void> {
  const base = baseURL ?? (await adminBase());
  const response = await fetch(`${base}/__e2e/ensure-admin`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: E2E_PASSWORD }),
  });
  if (!response.ok) {
    throw new Error(`E2E hook /ensure-admin failed with HTTP ${response.status}`);
  }
}

/** Calls a test-only hook on the E2E server (`/__e2e/**`). */
export async function e2eFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const base = await adminBase();
  const response = await fetch(`${base}/__e2e${path}`, init);
  if (!response.ok) {
    throw new Error(`E2E hook ${path} failed with HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

/**
 * A Playwright storageState file holding a live admin session for this spec
 * file's server. The first call makes sure the administrator exists (the
 * `/__e2e/ensure-admin` hook: the panel has no web setup) and signs in through
 * the real password login; specs that change the session
 * may overwrite the file and later contexts in the same file pick that up.
 */
export async function authStoragePath(options: ServerOptions = DEFAULT_SERVER_OPTIONS): Promise<string> {
  const server = await ensureServer(options);
  if (server.signedIn) {
    return server.authFile;
  }
  await ensureAdmin(server.baseURL, options.adminUsername);
  const response = await fetch(`${server.baseURL}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: options.adminUsername, password: E2E_PASSWORD }),
  });
  const cookie = (response.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  const separator = cookie.indexOf('=');
  if (!response.ok || separator < 0) {
    throw new Error(`E2E sign-in failed with HTTP ${response.status}`);
  }
  const state = {
    cookies: [
      {
        name: cookie.slice(0, separator),
        value: cookie.slice(separator + 1),
        domain: new URL(server.baseURL).hostname,
        path: '/',
        expires: -1,
        httpOnly: true,
        secure: false,
        sameSite: 'Strict',
      },
    ],
    origins: [],
  };
  await writeFile(server.authFile, JSON.stringify(state), 'utf8');
  server.signedIn = true;
  return server.authFile;
}

/**
 * The suite's `test`: `test.use({ signedIn: true })` gives every context and
 * request fixture of the spec a live admin session on the spec's own server.
 */
export const test = base.extend<{
  signedIn: boolean;
  mcpImages: boolean;
  mcpManager: boolean;
  seedLocale: string | null;
  docsRuns: boolean;
  passkeys: boolean;
  adminUsername: string;
}>({
  signedIn: [false, { option: true }],
  mcpImages: [false, { option: true }],
  // The outbound MCP manager (a stdio fixture child plus a degraded HTTP
  // endpoint) runs only in the specs that assert on it, so unrelated suites
  // keep the fixture's "no connection manager" footprint.
  mcpManager: [false, { option: true }],
  // Docs screenshot suite only: localized synthetic rows, passkey mode and a
  // presentable fixture administrator name.
  seedLocale: [null, { option: true }],
  docsRuns: [false, { option: true }],
  passkeys: [false, { option: true }],
  adminUsername: [E2E_USERNAME, { option: true }],
  storageState: async (
    { signedIn, mcpImages, mcpManager, seedLocale, docsRuns, passkeys, adminUsername, storageState },
    use,
  ) => {
    const options = { mcpImages, mcpManager, seedLocale, docsRuns, passkeys, adminUsername };
    // The options select the server whether or not this spec wants a session:
    // booting only for `signedIn` would leave an unsigned spec (or a helper that
    // runs first) with the default fixture's text.
    await prepareServer(options);
    await use(signedIn ? await authStoragePath(options) : storageState);
  },
});

export interface PageIssues {
  readonly consoleErrors: string[];
  readonly pageErrors: string[];
  readonly writeApiCalls: string[];
  readonly externalRequests: string[];
}

/**
 * Attaches listeners that record console errors, page errors, non-GET calls
 * to `/api/**` and requests to any origin other than the admin server. A spec
 * that starts the listeners before navigating can assert on the returned
 * arrays after the flow; call `finish()` once the page settles.
 */
export function watchPageIssues(page: Page): () => PageIssues {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const writeApiCalls: string[] = [];
  const externalRequests: string[] = [];
  if (current?.file !== base.info().file) {
    throw new Error("watchPageIssues needs this spec file's server; navigate or sign in first");
  }
  const origin = current.baseURL;

  const onConsole = (message: { type(): string; text(): string }): void => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
    }
  };
  const onPageError = (error: Error): void => {
    pageErrors.push(error.message);
  };
  const onRequest = (request: { url(): string; method(): string }): void => {
    const url = request.url();
    const method = request.method();
    if (url.includes('/api/') && method !== 'GET') {
      writeApiCalls.push(`${method} ${url}`);
    }
    if (!url.startsWith(origin)) {
      externalRequests.push(`${method} ${url}`);
    }
  };

  page.on('console', onConsole);
  page.on('pageerror', onPageError);
  page.on('request', onRequest);

  return () => {
    page.off('console', onConsole);
    page.off('pageerror', onPageError);
    page.off('request', onRequest);
    return { consoleErrors, pageErrors, writeApiCalls, externalRequests };
  };
}

/**
 * Starts this page with the Invocation pages' live refresh already off, seeded
 * the way the panel store persists it. A spec that asserts the snapshot
 * "new records" contract, or a first request that must fail, cannot race the
 * stream's own refetch that way.
 */
export async function disableInvocationAutoRefresh(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.localStorage.setItem(
      'surowan-admin-ui',
      JSON.stringify({ version: 0, state: { invocationAutoRefresh: false } }),
    );
  });
}

/** Counts rendered body rows of the first table on the page. */
export function tableBodyRows(page: Page): ReturnType<Page['locator']> {
  return page.locator('table tbody tr');
}

/** The vertical model list's row whose id is exactly `modelId`. */
export function modelListRow(page: Page, modelId: string): Locator {
  return page.locator('[data-model-list] li').filter({ has: page.getByText(modelId, { exact: true }) });
}

/** The "Next page" button of a list's real page controls. */
export function nextPage(page: Page): ReturnType<Page['getByRole']> {
  return page.getByRole('button', { name: 'Next page', exact: true });
}

/** The "Previous page" button of a list's real page controls. */
export function previousPage(page: Page): ReturnType<Page['getByRole']> {
  return page.getByRole('button', { name: 'Previous page', exact: true });
}

/** Applies the filter toolbar's draft conditions. */
export async function clickSearch(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Search', exact: true }).click();
}

/** Asserts the list uses real page controls instead of a "Load more" stream. */
export async function expectRealPagination(page: Page): Promise<void> {
  await expect(page.getByRole('navigation', { name: 'Pagination', exact: true }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Load more', exact: true })).toHaveCount(0);
}

/** Opens a parent group when needed, then activates its real child link. */
export async function clickNav(page: Page, group: string, label: string): Promise<void> {
  const nav = page.getByRole('navigation', { name: 'Main navigation', exact: true });
  const parent = nav.getByRole('button', { name: group, exact: true });
  if ((await parent.getAttribute('aria-expanded')) !== 'true') {
    await parent.click();
  }
  await nav.getByRole('link', { name: label, exact: true }).click();
}

/**
 * A toast with `text`, scoped to the Koi toast stack: page content that also
 * contains the words (a dialog, or the row the write just rendered) would
 * otherwise satisfy or break the assertion.
 */
export function toast(page: Page, text: string): ReturnType<Page['locator']> {
  return page.locator('[data-koi-toast]').filter({ hasText: text });
}

/** The "Applied" toast of a successful config write. */
export function appliedToast(page: Page): ReturnType<Page['locator']> {
  return toast(page, 'Applied');
}
