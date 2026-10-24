import { type APIRequestContext, expect, type Page } from '@playwright/test';
import { adminUrl, E2E_PASSWORD, E2E_USERNAME } from './helpers.ts';

/** The administrator session an API-key spec acts as. */
export interface ApiKeySession {
  readonly cookie: string;
  readonly sessionToken: string;
}

/**
 * Signs in as the E2E administrator, creating the account on first use.
 * The API-key specs sign in themselves instead of relying on the shared storage
 * state, so each one also passes when run on its own
 * (`pnpm run admin:test:e2e 14-api-keys`).
 */
export async function signIn(request: APIRequestContext): Promise<ApiKeySession> {
  const session = await request.get(await adminUrl('/api/auth/session'));
  const state = (await session.json()) as { setup_required: boolean };
  const response = state.setup_required
    ? await request.post(await adminUrl('/api/auth/setup'), {
        data: { username: E2E_USERNAME, password: E2E_PASSWORD },
      })
    : await request.post(await adminUrl('/api/auth/login'), {
        data: { username: E2E_USERNAME, password: E2E_PASSWORD },
      });
  expect(response.status()).toBe(200);
  const header = response.headers()['set-cookie'] ?? '';
  const cookie = header.slice(0, header.indexOf(';'));
  expect(cookie.startsWith('plasticwan_admin=')).toBe(true);
  return { cookie, sessionToken: cookie.slice(cookie.indexOf('=') + 1) };
}

export function bearer(key: string): { Authorization: string } {
  return { Authorization: `Bearer ${key}` };
}

/** In-page clipboard stub: Copy never touches the OS clipboard or logs the key. */
export async function installClipboardRecorder(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          (window as unknown as { __e2eCopiedText?: string }).__e2eCopiedText = text;
        },
      },
    });
  });
}

/** Boolean-only scan: no full `pwk_…` key may sit in Web Storage. */
export function storageHasApiKey(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const values = [...Object.values(window.localStorage), ...Object.values(window.sessionStorage)];
    return values.some((value) => /pwk_[A-Za-z0-9_-]{43}/.test(value));
  });
}

/** Boolean-only scan: is the plaintext still anywhere in the rendered DOM? */
export function bodyContains(page: Page, secret: string): Promise<boolean> {
  return page.evaluate(
    (needle) =>
      (document.body.textContent?.includes(needle) ?? false) ||
      [...document.querySelectorAll('input, textarea')].some((element) =>
        (element as HTMLInputElement | HTMLTextAreaElement).value.includes(needle),
      ),
    secret,
  );
}

export function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, resolve: release };
}

export function uniqueKeyName(scope: string): string {
  return `e2e-ui-${scope}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function createKeyThroughUi(page: Page, name: string): Promise<string> {
  await page.getByRole('main').getByRole('button', { name: 'Create API key' }).click();
  const createDialog = page.getByRole('dialog');
  await createDialog.getByLabel('Name').fill(name);
  await createDialog.getByRole('button', { name: 'Create key' }).click();
  const saveDialog = page.getByRole('dialog');
  await expect(saveDialog.getByText('Save your API key', { exact: true })).toBeVisible();
  const key = await saveDialog.getByLabel('API key').inputValue();
  await saveDialog.getByRole('button', { name: 'Done' }).click();
  await expect(saveDialog).not.toBeVisible();
  return key;
}
