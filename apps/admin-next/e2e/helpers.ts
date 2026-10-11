import { type ChildProcess, spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test as base, type Page } from '@playwright/test';

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
 * Every spec file runs against its own freshly seeded E2E backend (real
 * AdminServer + SqliteStore + the synthetic fixture, see `e2e/server.ts`), so
 * files share no state and can run in parallel workers in any order. Within a
 * worker, files run one after another: the first call from a new file stops
 * the previous file's server and starts a new one. The server also exits on
 * its own when its stdin closes, so a killed worker leaves nothing behind.
 */
async function ensureServer(): Promise<RunningServer> {
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
  });
  const baseURL = await waitForReady(child);
  serverCount += 1;
  current = {
    file,
    child,
    baseURL,
    authFile: join(tmpdir(), `plasticwan-admin-e2e-${process.pid}-${serverCount}.auth.json`),
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

export async function adminUrl(path: string): Promise<string> {
  return `${await adminBase()}${path}`;
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
 * file's server. The first call creates the administrator (or signs in, when a
 * spec already did) through the real auth API; specs that change the session
 * may overwrite the file and later contexts in the same file pick that up.
 */
export async function authStoragePath(): Promise<string> {
  const server = await ensureServer();
  if (server.signedIn) {
    return server.authFile;
  }
  const session = await fetch(`${server.baseURL}/api/auth/session`);
  const { setup_required: setupRequired } = (await session.json()) as { setup_required: boolean };
  const response = await fetch(`${server.baseURL}/api/auth/${setupRequired ? 'setup' : 'login'}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: E2E_USERNAME, password: E2E_PASSWORD }),
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
export const test = base.extend<{ signedIn: boolean }>({
  signedIn: [false, { option: true }],
  storageState: async ({ signedIn, storageState }, use) => {
    await use(signedIn ? await authStoragePath() : storageState);
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

/** Counts rendered body rows of the first table on the page. */
export function tableBodyRows(page: Page): ReturnType<Page['locator']> {
  return page.locator('table tbody tr');
}

/**
 * A toast with `text`, scoped to Sonner's container: page content that also
 * contains the words (a dialog, or the row the write just rendered) would
 * otherwise satisfy or break the assertion.
 */
export function toast(page: Page, text: string): ReturnType<Page['locator']> {
  return page.locator('[data-sonner-toast]').filter({ hasText: text });
}

/** The "Applied" toast of a successful config write. */
export function appliedToast(page: Page): ReturnType<Page['locator']> {
  return toast(page, 'Applied');
}
