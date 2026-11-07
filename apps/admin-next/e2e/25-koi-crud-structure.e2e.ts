import { expect, type Page } from '@playwright/test';
import { adminUrl, clickNav, test } from './helpers.ts';

/** Structural acceptance for the order-page hierarchy, backed by the real fixture APIs. */
test.use({ signedIn: true });

async function expectOnlyFilterCards(page: Page, filterCount: number): Promise<void> {
  const main = page.getByRole('main');
  await expect(main.locator('[data-slot="card"]')).toHaveCount(0);
  await expect(main.locator('.koi-card__root:not([data-list-filter])')).toHaveCount(0);
  await expect(main.locator('[data-list-filter]')).toHaveCount(filterCount);
  await expect(page.getByRole('button', { name: 'Load more', exact: true })).toHaveCount(0);
}

test('overview uses plain stat metrics and a recent-invocation table linked to the audit list', async ({ page }) => {
  await page.goto(await adminUrl('/'));
  await expect(page.getByRole('heading', { name: 'Overview', exact: true })).toBeVisible();
  for (const label of ['Invocations', 'Ongoing invocations', 'Stored messages', 'Cached media analyses', 'Warnings']) {
    await expect(page.getByText(label, { exact: true }).first()).toBeVisible();
  }
  await expect(page.getByText('Recent invocations', { exact: true })).toBeVisible();
  await expect(page.locator('table tbody tr').first()).toBeVisible();
  const viewAll = page.getByRole('link', { name: 'View all', exact: true });
  await expect(viewAll).toHaveAttribute('href', '/invocations');
  await expect(page.getByText('Bot status', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel ongoing', exact: true })).toBeVisible();
  await expectOnlyFilterCards(page, 0);
});

test('a failed warning poll keeps cached warnings and their actions visible', async ({ page }) => {
  let warningCalls = 0;
  await page.route('**/api/warnings?*', async (route) => {
    warningCalls += 1;
    if (warningCalls > 1) {
      await route.fulfill({ status: 502, json: { error: 'internal', message: 'Synthetic warning refresh failure' } });
      return;
    }
    await route.fulfill({
      json: {
        generated_at: '2026-01-02T03:04:05.000Z',
        standing: [
          {
            kind: 'standing',
            code: 'invocation_failure_rate',
            category: 'runtime',
            severity: 'warning',
            variables: {},
            updated_at: '2026-01-02T03:04:05.000Z',
          },
        ],
        items: [
          {
            kind: 'event',
            id: 'warning-fixture',
            code: 'admin_login_failures',
            category: 'security',
            severity: 'critical',
            variables: {},
            created_at: '2026-01-02T03:04:05.000Z',
            updated_at: '2026-01-02T03:04:05.000Z',
            read_at: null,
          },
        ],
        next_cursor: null,
        unread_count: 1,
      },
    });
  });
  await page.goto(await adminUrl('/'));
  await expect(page.getByText('Invocation failure rate is above the threshold')).toBeVisible();
  await expect(page.getByText('Consecutive administrator sign-in failures')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Mark read', exact: true })).toBeVisible();

  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByText('Synthetic warning refresh failure', { exact: false })).toBeVisible();
  await expect(page.getByText('Invocation failure rate is above the threshold')).toBeVisible();
  await expect(page.getByText('Consecutive administrator sign-in failures')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Mark read', exact: true })).toBeVisible();
});

test('a failed recent-invocation read does not invent an empty table', async ({ page }) => {
  await page.route('**/api/invocations?*', (route) =>
    route.fulfill({ status: 502, json: { error: 'internal', message: 'Synthetic recent failure' } }),
  );
  await page.goto(await adminUrl('/'));
  await expect(page.getByText('Synthetic recent failure', { exact: false })).toBeVisible();
  await expect(page.locator('table')).toHaveCount(0);
  await expect(page.getByText('No records', { exact: true })).toHaveCount(0);
});

const pages = [
  {
    path: '/memories',
    api: '/api/memories',
    group: 'Agent data',
    label: 'Memories',
    heading: 'Memories',
    action: 'New memo',
    count: 'cursor',
  },
  {
    path: '/group-memories',
    api: '/api/group-memories',
    group: 'Agent data',
    label: 'Group memory',
    heading: 'Group memory',
    action: 'Refresh list',
    count: 'cursor',
  },
  {
    path: '/dictionary',
    api: '/api/dictionary',
    group: 'Agent data',
    label: 'Dictionary',
    heading: 'Dictionary',
    action: 'New entry',
    count: 'records',
  },
  {
    path: '/alarms',
    api: '/api/alarms',
    group: 'Agent data',
    label: 'Alarms',
    heading: 'Alarms',
    action: 'Refresh list',
    count: 'cursor',
  },
  {
    path: '/admins',
    api: '/api/admins',
    group: 'Telegram',
    label: 'Bot admins',
    heading: 'Bot admins',
    action: 'Add bot admin',
    count: 'records',
  },
  {
    path: '/chats',
    api: '/api/chats',
    group: 'Telegram',
    label: 'Chats',
    heading: 'Chat allowlist',
    action: 'Add Chat',
    count: 'records',
  },
  {
    path: '/models',
    api: '/api/providers',
    group: 'Agent setup',
    label: 'Models',
    heading: 'Providers',
    action: 'New provider',
    count: 'records',
  },
  {
    path: '/prompts',
    api: '/api/prompts/versions',
    group: 'Agent setup',
    label: 'Prompts',
    heading: 'Prompts',
    action: 'Refresh list',
    count: 'records',
  },
  {
    path: '/api-keys',
    api: '/api/api-keys',
    group: 'System',
    label: 'API keys',
    heading: 'API keys',
    action: 'Create API key',
    count: 'records',
  },
  {
    path: '/search-settings',
    api: '/api/search/config',
    group: 'Agent setup',
    label: 'Web search',
    heading: 'Web search',
    action: 'Add engine',
    count: 'records',
  },
] as const;

for (const entry of pages) {
  test(`${entry.path} keeps filter-only Cards, a plain table and real pagination`, async ({ page }) => {
    await page.goto(await adminUrl('/'));
    const listResponse = page.waitForResponse(
      (response) => response.request().method() === 'GET' && new URL(response.url()).pathname === entry.api,
    );
    await clickNav(page, entry.group, entry.label);
    expect((await listResponse).ok()).toBe(true);
    await expect(page).toHaveURL(new RegExp(`${entry.path}$`));
    await expect(page.getByRole('heading', { name: entry.heading, exact: true }).first()).toBeVisible();
    await expect(page.getByText('Filters', { exact: true }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: entry.action, exact: true }).first()).toBeVisible();
    await expect(page.locator('table').first()).toBeVisible();
    await expect(page.locator('table').first()).not.toHaveAttribute('aria-busy', 'true');
    await expect(
      page.getByText(entry.count === 'cursor' ? /Page 1 · \d+ records/ : /\d+ records/).first(),
    ).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Pagination', exact: true })).toHaveCount(
      entry.path === '/models' ? 2 : 1,
    );
    await expectOnlyFilterCards(page, entry.path === '/prompts' ? 2 : 1);
    await expect(page.getByRole('alert').filter({ hasText: 'Request failed' })).toHaveCount(0);
    await expect(page.getByText('Something went wrong')).toHaveCount(0);
  });
}

const paginatedRoutes = [
  { path: '/warnings', filters: 0 },
  { path: '/invocations', filters: 1 },
  { path: '/messages', filters: 1 },
  { path: '/contexts', filters: 1 },
  { path: '/stickers', filters: 1 },
  { path: '/image-generations', filters: 0 },
  { path: '/playground', filters: 0 },
] as const;

for (const entry of paginatedRoutes) {
  test(`${entry.path} has real pagination and no non-query Card`, async ({ page }) => {
    await page.goto(await adminUrl(entry.path));
    await expect(page.getByRole('navigation', { name: 'Pagination', exact: true }).first()).toBeVisible();
    await expectOnlyFilterCards(page, entry.filters);
  });
}

const plainSectionRoutes = [
  { path: '/settings', ready: 'Admin credentials' },
  { path: '/preferences', ready: 'Display' },
  { path: '/developer', ready: 'Debug payloads' },
  { path: '/image-settings', ready: 'Image generation settings' },
] as const;

for (const entry of plainSectionRoutes) {
  test(`${entry.path} renders settings as plain sections rather than Cards`, async ({ page }) => {
    await page.goto(await adminUrl(entry.path));
    await expect(page.getByText(entry.ready, { exact: true }).first()).toBeVisible();
    await expectOnlyFilterCards(page, 0);
  });
}

test('alarm details use a real dialog while cancellation remains a row action', async ({ page }) => {
  await page.goto(await adminUrl('/alarms'));
  const row = page.locator('table tbody tr', { hasText: 'Remind Alice about the fixture data' });
  await row.getByRole('button', { name: 'View', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Alarm ID', exact: true })).toBeVisible();
  await expect(dialog.getByText('Conversation ID', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await expect(row.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible();
});

test('search engines use create and edit dialogs without losing the table', async ({ page }) => {
  await page.goto(await adminUrl('/search-settings'));
  await page.getByRole('button', { name: 'Add engine', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Add engine', exact: true })).toBeVisible();
  await expect(dialog.getByLabel('Engine id')).toHaveValue('tavily-1');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.locator('table')).toBeVisible();
  await expect(page.getByText('No engine configured. Add one to make search available.')).toBeVisible();
});
