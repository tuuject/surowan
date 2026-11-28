import { expect, type Page, test } from '@playwright/test';
import { adminBase, E2E_PASSWORD, E2E_USERNAME, e2eFetch, stopServer } from './helpers.ts';

/**
 * The sign-in state machine against the real AdminServer, asserted through the
 * session API and the form's stable autocomplete hooks only: no visible copy,
 * accessible name or locale is part of the contract, so a wording or layout
 * change cannot break these tests.
 */
test.describe.configure({ mode: 'serial' });

// The fresh-instance contract is only true on a store nobody has touched yet, so
// each run of this file (including a `--repeat-each` repeat that lands on the
// same worker) gets its own fixture server instead of the previous run's.
test.afterAll(stopServer);

const USERNAME_INPUT = 'input[autocomplete="username"]';
const PASSWORD_INPUT = 'input[autocomplete="current-password"]';
const CODE_INPUT = 'input[autocomplete="one-time-code"]';
const SUBMIT = 'button[type="submit"]';
const USE_CODE = '[data-testid="auth-switch-to-code"]';

interface CliPairing {
  readonly code: string;
  readonly next: string;
  readonly pairing: { readonly id: string; readonly purpose: string };
}

/** The per-file fixture server's origin, minted by the first test. */
let base = '';
/** The `web` code the first test spends; the next test replays it. */
let spentCode = '';

/** The panel session as the API returns it: untyped JSON, read by key. */
async function sessionOf(page: Page): Promise<Record<string, unknown>> {
  return (await (await page.request.get(`${base}/api/auth/session`)).json()) as Record<string, unknown>;
}

/**
 * Gives the password-less `admin` a password through the authenticated API:
 * the settings page is UI detail, and the fixture's `/ensure-admin` hook is a
 * no-op once an account exists. The session that authorizes the change comes
 * from a real one-time code, so nothing here bypasses the auth contract.
 */
async function setCredentials(): Promise<void> {
  const web = await e2eFetch<CliPairing>('/pairing-create?purpose=web', { method: 'POST' });
  const claim = await fetch(`${base}/api/auth/pairing`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: web.code }),
  });
  expect(claim.status).toBe(200);
  const cookie = (claim.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  const update = await fetch(`${base}/api/auth/credentials`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ username: E2E_USERNAME, password: E2E_PASSWORD }),
  });
  expect(update.status).toBe(200);
}

test('a fresh instance shows the ordinary sign-in; its first one-time code creates admin', async ({ page }) => {
  base = await adminBase();

  // Whoever reaches a fresh instance first cannot claim it: there is no setup route.
  const scanner = await fetch(`${base}/api/auth/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'scanner', password: 'scanner-password-1' }),
  });
  expect(scanner.status).toBe(401);

  // Nor can it tell the instance is fresh: no setup state, just the ordinary gate.
  const anonymous = (await (await fetch(`${base}/api/auth/session`)).json()) as Record<string, unknown>;
  expect(anonymous).not.toHaveProperty('setup_required');

  await page.goto(base);
  await expect(page.locator(USERNAME_INPUT)).toBeVisible();
  await expect(page.locator(PASSWORD_INPUT)).toBeVisible();
  await expect(page.locator('[data-route-error]')).toHaveCount(0);

  // The real `pairing create --web` creates the password-less `admin`.
  const web = await e2eFetch<CliPairing & { account: Record<string, unknown> }>('/pairing-create?purpose=web', {
    method: 'POST',
  });
  expect(web.account.username).toBe('admin');
  expect(web.account.created).toBe(true);
  await page.locator(USE_CODE).click();
  await expect(page.locator(CODE_INPUT)).toBeVisible();
  await page.locator(CODE_INPUT).fill(web.code);
  await page.locator(SUBMIT).click();

  // The code's session reaches the shell and reads back as the account it created.
  await expect(page.getByRole('main')).toBeVisible();
  await expect(page.locator('[data-route-error]')).toHaveCount(0);
  const session = await sessionOf(page);
  expect(session.authenticated).toBe(true);
  expect(session.username).toBe('admin');
  expect(session.has_password).toBe(false);
  spentCode = web.code;
});

test('a one-time code signs the browser in exactly once', async ({ page }) => {
  // The same code, replayed, is spent: the endpoint says so instead of opening
  // a second session, and the page never leaves the shell it signed into.
  const replay = await page.request.post(`${base}/api/auth/pairing`, { data: { code: spentCode } });
  expect(replay.status()).toBe(409);
  expect((await replay.json()) as Record<string, unknown>).toMatchObject({ error: 'pairing_code_used' });
});

test('password sign-in reaches the shell; a wrong password keeps the form and the URL', async ({ page }) => {
  await setCredentials();

  await page.goto(base);
  await expect(page.locator(USERNAME_INPUT)).toBeVisible();
  const formUrl = page.url();

  const rejected = page.waitForResponse(
    (response) => response.url().endsWith('/api/auth/login') && response.request().method() === 'POST',
  );
  await page.locator(USERNAME_INPUT).fill(E2E_USERNAME);
  await page.locator(PASSWORD_INPUT).fill('definitely-wrong-password');
  await page.locator(SUBMIT).click();
  const refused = await rejected;
  expect(refused.status()).toBe(401);
  expect((await refused.json()) as Record<string, unknown>).toMatchObject({ error: 'invalid_credentials' });

  // No session, no navigation: the visitor stays on the form they submitted.
  await expect(page.locator(PASSWORD_INPUT)).toBeVisible();
  await expect(page).toHaveURL(formUrl);
  await expect(page.locator('[data-route-error]')).toHaveCount(0);
  expect((await sessionOf(page)).authenticated).toBe(false);

  const accepted = page.waitForResponse(
    (response) => response.url().endsWith('/api/auth/login') && response.request().method() === 'POST',
  );
  await page.locator(PASSWORD_INPUT).fill(E2E_PASSWORD);
  await page.locator(SUBMIT).click();
  expect((await accepted).status()).toBe(200);

  await expect(page.getByRole('main')).toBeVisible();
  await expect(page.locator('[data-route-error]')).toHaveCount(0);
  const session = await sessionOf(page);
  expect(session.authenticated).toBe(true);
  expect(session.username).toBe(E2E_USERNAME);
  expect(session.has_password).toBe(true);
});

test('a revoked session is bounced to the sign-in form without an error screen', async ({ page }) => {
  await page.goto(base);
  await page.locator(USERNAME_INPUT).fill(E2E_USERNAME);
  await page.locator(PASSWORD_INPUT).fill(E2E_PASSWORD);
  await page.locator(SUBMIT).click();
  await expect(page.getByRole('main')).toBeVisible();

  // Revoke every admin session straight from the database.
  const revoked = await e2eFetch<{ deleted: number }>('/revoke-sessions', { method: 'POST' });
  expect(revoked.deleted).toBeGreaterThanOrEqual(1);

  // The next protected request 401s; the global handler returns to the gate.
  await page.goto(`${base}/invocations`);
  await expect(page.locator(USERNAME_INPUT)).toBeVisible();
  await expect(page.locator('[data-route-error]')).toHaveCount(0);
});
