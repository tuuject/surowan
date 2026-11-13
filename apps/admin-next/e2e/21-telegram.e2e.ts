import { type APIRequestContext, expect } from '@playwright/test';
import { adminUrl, appliedToast, e2eFetch, test, toast } from './helpers.ts';

/**
 * The Telegram page owns one field, the Bot Token. The fixture config already
 * references a `telegram` jar entry, so a fresh server starts "token configured"
 * and every test can act independently; each spec file has its own server.
 *
 * The connection state has no live manager in the E2E process, so the hook
 * moves the shared registry between statuses and the panel polls it.
 */
test.use({ signedIn: true });

interface ConnectionInput {
  readonly status: 'disabled' | 'connected' | 'network_error' | 'config_error';
  readonly reason?: 'unauthorized' | 'conflict' | 'token_unreadable';
}

async function setConnection(input: ConnectionInput): Promise<void> {
  await e2eFetch('/telegram-connection', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
}

interface TelegramApiView {
  readonly token_configured: boolean;
  readonly telegram_section_present: boolean;
  readonly status: { readonly status: string };
}

test.describe('Telegram settings', () => {
  test('renders the connection, bot identity and token form', async ({ page }) => {
    await setConnection({ status: 'connected' });
    await page.goto(await adminUrl('/telegram'));

    await expect(page.getByRole('heading', { name: 'Telegram settings' })).toBeVisible();
    await expect(page.getByText('Connected', { exact: true })).toBeVisible();
    await expect(page.getByText('@surowan_bot', { exact: true })).toBeVisible();
    await expect(page.getByText('A token is configured.', { exact: true })).toBeVisible();
    await expect(page.getByLabel('New Bot Token')).toHaveAttribute('type', 'password');
    await expect(page.getByRole('button', { name: 'Save token' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Clear token' })).toBeEnabled();
  });

  test('saves a token through key.json and keeps it out of the UI', async ({ page }) => {
    await page.goto(await adminUrl('/telegram'));
    const input = page.getByLabel('New Bot Token');
    await input.fill('123456:e2e-telegram-token');
    await page.getByRole('button', { name: 'Save token' }).click();

    await expect(toast(page, 'Telegram token saved')).toBeVisible();
    await expect(page.getByText('A token is configured.', { exact: true })).toBeVisible();
    await expect(input).toHaveValue('');

    const view = (await (await page.request.get(await adminUrl('/api/telegram'))).json()) as TelegramApiView;
    expect(view.token_configured).toBe(true);
    expect(view.telegram_section_present).toBe(true);
  });

  test('clears the token without deleting the telegram section', async ({ page }) => {
    await page.goto(await adminUrl('/telegram'));
    await page.getByRole('button', { name: 'Clear token' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Clear token' }).click();

    await expect(toast(page, 'Telegram token cleared')).toBeVisible();
    await expect(page.getByText('No token is configured.', { exact: true })).toBeVisible();
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    await expect(page.getByRole('main').getByRole('button', { name: 'Clear token' })).toBeDisabled();

    const view = (await (await page.request.get(await adminUrl('/api/telegram'))).json()) as TelegramApiView;
    expect(view.token_configured).toBe(false);
    expect(view.telegram_section_present).toBe(true);
  });

  test('a failed status poll keeps the token being typed', async ({ page }) => {
    await page.goto(await adminUrl('/telegram'));
    const input = page.getByLabel('New Bot Token');
    await input.fill('123456:half-typed-token');

    // The page polls every 10 s; fail the next poll only.
    await page.route('**/api/telegram', (route) =>
      route.request().method() === 'GET'
        ? route.fulfill({
            status: 500,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'internal_error', message: 'poll failed' }),
          })
        : route.fallback(),
    );
    await expect(page.getByText('Failed to read the Telegram settings', { exact: false })).toBeVisible({
      timeout: 20_000,
    });
    await expect(input).toHaveValue('123456:half-typed-token');
    await expect(page.getByRole('button', { name: 'Save token' })).toBeEnabled();

    await page.unroute('**/api/telegram');
    await expect(page.getByText('Failed to read the Telegram settings', { exact: false })).toHaveCount(0, {
      timeout: 20_000,
    });
    await expect(input).toHaveValue('123456:half-typed-token');
  });

  test('the overview shows the current Telegram status', async ({ page }) => {
    await setConnection({ status: 'connected' });
    await page.goto(await adminUrl('/'));
    await expect(page.getByText('Bot status')).toBeVisible();
    const main = page.getByRole('main');
    await expect(main.getByText('Telegram', { exact: true })).toBeVisible();
    await expect(main.getByText('Connected', { exact: true })).toBeVisible();
    await expect(main.getByText('@surowan_bot', { exact: true })).toBeVisible();
  });
});

interface BucketTimingView {
  readonly bucket_window_seconds: number;
  readonly bucket_max_seconds: number | null;
  readonly bucket_bump_seconds: number;
}

async function bucketTiming(
  request: APIRequestContext,
): Promise<{ readonly saved: BucketTimingView; readonly active: BucketTimingView }> {
  const view = (await (await request.get(await adminUrl('/api/telegram'))).json()) as {
    readonly bucket_timing: { readonly saved: BucketTimingView; readonly active: BucketTimingView };
  };
  return view.bucket_timing;
}

test.describe('Telegram message batches', () => {
  test('saves the batch timing and the running process adopts it without a restart', async ({ page }) => {
    await page.goto(await adminUrl('/telegram'));
    const minimum = page.getByLabel('Minimum wait (seconds)');
    const maximum = page.getByLabel('Maximum wait (seconds)');
    const extension = page.getByLabel('Extension per message (seconds)');
    const save = page.getByRole('button', { name: 'Save and apply' });

    await expect(page.getByText('Message batches', { exact: true })).toBeVisible();
    await expect(minimum).toHaveValue('15');
    await expect(maximum).toHaveValue('');
    await expect(maximum).toHaveAttribute('placeholder', 'Same as the minimum wait');
    await expect(extension).toHaveValue('0');
    await expect(save).toBeDisabled();

    // A ceiling below the minimum is caught before the round trip.
    await maximum.fill('10');
    await expect(page.getByText('Must be at least the minimum wait')).toBeVisible();
    await expect(save).toBeDisabled();
    await maximum.fill('301');
    await expect(page.getByText('Must be at most 300')).toBeVisible();

    await maximum.fill('60');
    await extension.fill('5');
    await expect(page.getByText('2 unsaved changes')).toBeVisible();
    await save.click();
    await expect(appliedToast(page)).toBeVisible();
    await expect(page.getByText('No unsaved changes')).toBeVisible();
    await expect(maximum).toHaveValue('60');
    const applied = { bucket_window_seconds: 15, bucket_max_seconds: 60, bucket_bump_seconds: 5 };
    expect(await bucketTiming(page.request)).toEqual({ saved: applied, active: applied });

    // Emptying the ceiling removes it, so it follows the minimum again.
    await maximum.fill('');
    await save.click();
    await expect.poll(async () => (await bucketTiming(page.request)).active.bucket_max_seconds).toBeNull();
    await expect(maximum).toHaveValue('');
    await expect(extension).toHaveValue('5');
  });

  test('a refused save keeps the edits and says why; discarding restores the saved timing', async ({ page }) => {
    await page.goto(await adminUrl('/telegram'));
    const extension = page.getByLabel('Extension per message (seconds)');
    // Tests of one file share a server, so start from whatever is saved now.
    const saved = String((await bucketTiming(page.request)).saved.bucket_bump_seconds);
    await expect(extension).toHaveValue(saved);
    await page.route('**/api/telegram/bucket-timing', (route) =>
      route.fulfill({
        status: 422,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'config_invalid', message: 'The idle grace is shorter than the maximum wait' }),
      }),
    );
    await extension.fill(saved === '7' ? '8' : '7');
    await page.getByRole('button', { name: 'Save and apply' }).click();
    await expect(
      page.getByRole('alert').filter({ hasText: 'The idle grace is shorter than the maximum wait' }),
    ).toBeVisible();
    await expect(extension).not.toHaveValue(saved);

    await page.getByRole('button', { name: 'Discard changes' }).click();
    await expect(extension).toHaveValue(saved);
    await expect(page.getByText('The idle grace is shorter than the maximum wait')).toHaveCount(0);
    await page.unroute('**/api/telegram/bucket-timing');
  });
});

test.describe('Telegram standing warnings', () => {
  test('warnings follow the connection state and name the config reason', async ({ page }) => {
    await setConnection({ status: 'network_error' });
    await page.goto(await adminUrl('/warnings'));
    await expect(page.getByText('Could not connect to the Telegram server')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Open Telegram settings' })).toBeVisible();

    const reasons = [
      ['unauthorized', 'Your Telegram token has been revoked or is invalid'],
      ['conflict', 'This Telegram token is already in use by another program'],
      ['token_unreadable', 'The Telegram token could not be read'],
    ] as const;
    for (const [reason, title] of reasons) {
      await setConnection({ status: 'config_error', reason });
      await page.reload();
      await expect(page.getByText(title, { exact: true })).toBeVisible();
      await expect(page.getByText('Could not connect to the Telegram server')).toHaveCount(0);
    }

    await setConnection({ status: 'disabled' });
    await page.reload();
    await expect(page.getByText('Your Telegram token has been revoked or is invalid')).toHaveCount(0);
    await expect(page.getByText('Telegram configuration error')).toHaveCount(0);
  });
});
