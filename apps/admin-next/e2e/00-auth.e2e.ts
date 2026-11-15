import { writeFile } from 'node:fs/promises';
import { expect, type Page, test } from '@playwright/test';
import { adminBase, E2E_PASSWORD, E2E_USERNAME, e2eFetch } from './helpers.ts';

/**
 * Auth state machine against the real AdminServer: the first sign-in with a
 * one-time code from the real server CLI (there is no web setup form), logout,
 * bad-password handling, and session revocation. Every flow asserts real UI
 * state (shell content / login form), not just response codes.
 */
test.describe.configure({ mode: 'serial' });

async function fillCredentials(page: Page, username: string, password: string): Promise<void> {
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill(password);
}

async function login(page: Page, base: string, username: string, password: string): Promise<void> {
  await page.goto(base);
  await expect(page.getByText('Surowan admin sign-in')).toBeVisible();
  await fillCredentials(page, username, password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByText('Stored messages')).toBeVisible();
}

test('a fresh instance shows the ordinary sign-in; the first code creates admin, who then sets credentials', async ({
  page,
}, testInfo) => {
  const base = await adminBase();
  // Whoever reaches a fresh instance first cannot claim it: there is no setup route.
  const scanner = await fetch(`${base}/api/auth/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'scanner', password: 'scanner-password-1' }),
  });
  expect(scanner.status).toBe(401);

  // Nor can it tell the instance is fresh: no setup state, and the same
  // sign-in page an instance in use shows.
  const anonymous = (await (await fetch(`${base}/api/auth/session`)).json()) as Record<string, unknown>;
  expect(anonymous).not.toHaveProperty('setup_required');
  await page.goto(base);
  await expect(page.getByText('Surowan admin sign-in')).toBeVisible();
  await expect(page.getByText('Enter your credentials to continue.')).toBeVisible();
  await expect(page.getByLabel('Username')).toBeVisible();
  await expect(page.getByLabel('Password')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('fresh-sign-in.png') });
  await testInfo.attach('fresh-sign-in', { path: testInfo.outputPath('fresh-sign-in.png'), contentType: 'image/png' });
  await page.getByRole('button', { name: 'Sign in with a one-time code' }).click();

  // The real `pairing create --web` creates the password-less `admin`.
  const web = await e2eFetch<CliPairing & { account: { username: string; created: boolean } }>(
    '/pairing-create?purpose=web',
    { method: 'POST' },
  );
  expect(web.account).toEqual({ username: 'admin', created: true });
  await page.getByLabel('One-time code').fill(web.code);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByText('Stored messages')).toBeVisible();
  await expect(page.getByText('Cached media analyses')).toBeVisible();
  await expect(page.getByText('Bot status')).toBeVisible();
  await expect(page.locator('[data-route-error]')).toHaveCount(0);
  const session = (await (await page.request.get(`${base}/api/auth/session`)).json()) as Record<string, unknown>;
  expect(session).toMatchObject({ authenticated: true, username: 'admin', has_password: false });

  // Choosing a username and password afterwards is the owner's call.
  await page.goto(await baseURLPath('/settings'));
  await page.getByLabel('New username').fill(E2E_USERNAME);
  await page.getByLabel('New password').fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Update credentials' }).click();
  await expect(page.getByText('Credentials updated; all other sessions were signed out.')).toBeVisible();
  await expect(page.getByText(E2E_USERNAME)).toBeVisible();
});

test('logout returns to the login form; bad password shows invalid_credentials and keeps the URL', async ({ page }) => {
  const base = await adminBase();
  await login(page, base, E2E_USERNAME, E2E_PASSWORD);

  // Sign out from the user menu → login form (not an error screen)
  await page.getByRole('button', { name: 'User menu' }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page.getByText('Surowan admin sign-in')).toBeVisible();
  await expect(page.locator('[data-route-error]')).toHaveCount(0);

  // wrong password: inline error with the stable code, URL unchanged
  const before = page.url();
  await fillCredentials(page, E2E_USERNAME, 'definitely-wrong-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByText('invalid_credentials', { exact: false })).toBeVisible();
  await expect(page).toHaveURL(before);
  await expect(page.getByText('Surowan admin sign-in')).toBeVisible();

  // correct login restores the shell
  await login(page, base, E2E_USERNAME, E2E_PASSWORD);
});

test('a revoked session is bounced to the login form without an error screen', async ({ page }) => {
  const base = await adminBase();
  await login(page, base, E2E_USERNAME, E2E_PASSWORD);

  // Revoke every admin session straight from the database.
  const revoked = await e2eFetch<{ deleted: number }>('/revoke-sessions', { method: 'POST' });
  expect(revoked.deleted).toBeGreaterThanOrEqual(1);

  // The next protected request 401s; the global handler returns to the gate.
  await page.goto(await baseURLPath('/invocations'));
  await expect(page.getByText('Surowan admin sign-in')).toBeVisible();
  await expect(page.locator('[data-route-error]')).toHaveCount(0);

  // Signing in again works. The gate preserves the current route
  // (/invocations), so assert the shell, then the overview.
  await fillCredentials(page, E2E_USERNAME, E2E_PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('main')).toBeVisible();
  await expect(page.locator('[data-route-error]')).toHaveCount(0);
  await page.goto(await baseURLPath('/'));
  await expect(page.getByText('Stored messages')).toBeVisible();
});

interface CliPairing {
  readonly code: string;
  readonly next: string;
  readonly pairing: { readonly id: string; readonly purpose: string };
}

interface PairingRows {
  readonly sessions: number;
  readonly rows: readonly { id: string; purpose: string; consumed: boolean; client_id: string | null }[];
}

async function submitCode(page: Page, code: string): Promise<void> {
  await page.getByRole('button', { name: 'Sign in with a one-time code' }).click();
  await page.getByLabel('One-time code').fill(code);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

test('a one-time code from the server CLI signs the browser in exactly once', async ({ page }, testInfo) => {
  const base = await adminBase();
  // The real `surowan pairing create --web`, run against this server's live database.
  const web = await e2eFetch<CliPairing>('/pairing-create?purpose=web', { method: 'POST' });
  expect(web.pairing.purpose).toBe('web');
  expect(web.next).toContain('Sign in with a one-time code');
  const before = await e2eFetch<PairingRows>('/pairing-rows');

  await page.goto(base);
  await expect(page.getByText('Surowan admin sign-in')).toBeVisible();
  await page.getByRole('button', { name: 'Sign in with a one-time code' }).click();
  await expect(page.getByText('Paste the one-time code generated on the server.')).toBeVisible();
  await expect(page.getByText('pairing create --web')).toBeVisible();
  // Client-side shape check before any request.
  await page.getByLabel('One-time code').fill('pwp_not-a-whole-code');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByText('Copy the whole code exactly as the server printed it')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('one-time-code-form.png') });

  // A terminal copy with stray spaces still signs in.
  await page.getByLabel('One-time code').fill(`  ${web.code}  `);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByText('Stored messages')).toBeVisible();
  await expect(page.getByText(E2E_USERNAME)).toBeVisible();
  const signedIn = await e2eFetch<PairingRows>('/pairing-rows');
  expect(signedIn.sessions).toBe(before.sessions + 1);

  // Signed out, the same code is spent.
  await page.getByRole('button', { name: 'User menu' }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page.getByText('Surowan admin sign-in')).toBeVisible();
  await submitCode(page, web.code);
  await expect(page.getByText('pairing_code_used', { exact: false })).toBeVisible();

  // An agent pairing code is not a sign-in code, and trying it does not spend it.
  await page.getByRole('button', { name: 'Sign in with a password' }).click();
  const client = await e2eFetch<CliPairing>('/pairing-create?purpose=client', { method: 'POST' });
  await submitCode(page, client.code);
  await expect(page.getByText('pairing_code_invalid', { exact: false })).toBeVisible();
  await expect(page.locator('[data-route-error]')).toHaveCount(0);

  // Back to the password form.
  await page.getByRole('button', { name: 'Sign in with a password' }).click();
  await expect(page.getByLabel('Username')).toBeVisible();

  const after = await e2eFetch<PairingRows>('/pairing-rows');
  // Sign-out removed the one session the code opened; the refused codes opened none.
  expect(after.sessions).toBe(before.sessions);
  expect(after.rows).toEqual(
    expect.arrayContaining([
      { id: web.pairing.id, purpose: 'web', consumed: true, client_id: null },
      { id: client.pairing.id, purpose: 'client', consumed: false, client_id: null },
    ]),
  );
  const resultPath = testInfo.outputPath('one-time-code-result.json');
  await writeFile(resultPath, JSON.stringify({ before, signedIn, after }, null, 2));
  await testInfo.attach('one-time-code-result', { path: resultPath, contentType: 'application/json' });
  await testInfo.attach('one-time-code-form', {
    path: testInfo.outputPath('one-time-code-form.png'),
    contentType: 'image/png',
  });
});

const OFFICIAL_DOCKER_COMMAND =
  'docker compose exec -u surowan plasticwan node /app/src/cli.ts pairing create --config /config/config.jsonc --web';

test('only the official Docker image is shown its docker compose command', async ({ page }, testInfo) => {
  const base = await adminBase();
  await page.goto(base);
  await page.getByRole('button', { name: 'Sign in with a one-time code' }).click();
  // A server without the image marker (a source checkout or a self-built image)
  // gets the generic hint and nothing it could paste blindly.
  await expect(page.getByText('pairing create --web', { exact: true })).toBeVisible();
  await expect(page.getByText(OFFICIAL_DOCKER_COMMAND)).toHaveCount(0);

  await e2eFetch('/official-image?enabled=1', { method: 'POST' });
  try {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.reload();
    await page.getByRole('button', { name: 'Sign in with a one-time code' }).click();
    await expect(page.getByText(OFFICIAL_DOCKER_COMMAND)).toBeVisible();
    await page.getByRole('button', { name: 'Copy command' }).click();
    await expect(page.getByText('Copied to clipboard')).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(OFFICIAL_DOCKER_COMMAND);
    await page.screenshot({ path: testInfo.outputPath('official-docker-hint.png') });
    await testInfo.attach('official-docker-hint', {
      path: testInfo.outputPath('official-docker-hint.png'),
      contentType: 'image/png',
    });
  } finally {
    await e2eFetch('/official-image?enabled=0', { method: 'POST' });
  }
});

async function baseURLPath(path: string): Promise<string> {
  return `${await adminBase()}${path}`;
}
