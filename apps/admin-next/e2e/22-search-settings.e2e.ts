import { expect } from '@playwright/test';
import { adminUrl, test, toast } from './helpers.ts';
import type { SearchConfigView } from '../src/lib/api/search.ts';

test.use({ signedIn: true });

const providers = [
  {
    id: 'tavily',
    label: 'Tavily',
    default_endpoint: 'https://api.tavily.com/search',
    key: 'required',
    query_limit: 400,
    supports_count: true,
  },
  {
    id: 'brave',
    label: 'Brave Search',
    default_endpoint: 'https://api.search.brave.com/res/v1/web/search',
    key: 'required',
    query_limit: 400,
    supports_count: true,
  },
  {
    id: 'exa',
    label: 'Exa',
    default_endpoint: 'https://api.exa.ai/search',
    key: 'required',
    query_limit: 500,
    supports_count: true,
  },
  {
    id: 'firecrawl',
    label: 'Firecrawl',
    default_endpoint: 'https://api.firecrawl.dev/v2/search',
    key: 'required',
    query_limit: 500,
    supports_count: true,
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    default_endpoint: 'https://api.deepseek.com/v1/tools/search',
    key: 'required',
    query_limit: 128,
    supports_count: true,
  },
  {
    id: 'searxng',
    label: 'SearXNG',
    default_endpoint: null,
    key: 'forbidden',
    query_limit: 500,
    supports_count: false,
  },
  {
    id: 'youcom',
    label: 'You.com',
    default_endpoint: 'https://ydc-index.io/v1/search',
    key: 'required',
    query_limit: 500,
    supports_count: true,
  },
] as const;

function view(overrides: Partial<SearchConfigView>): SearchConfigView {
  return {
    revision: 'rev-1',
    enabled: true,
    active: true,
    url_filters: [],
    engines: [],
    providers: [...providers],
    deepseek_keys: [],
    ...overrides,
  };
}

/** A configured engine: the page must show it without ever holding its key. */
const configuredEngine = {
  id: 'main',
  provider: 'tavily',
  enabled: true,
  endpoint: 'https://api.tavily.com/search',
  results: 5,
  timeout_seconds: 15,
  note: 'Chinese developer blogs',
  key_configured: true,
};

test('shows a configured engine without its key and saves the switch', async ({ page }) => {
  let config = view({ engines: [configuredEngine] });
  const writes: unknown[] = [];
  await page.route('**/api/search/config', async (route) => {
    if (route.request().method() === 'PUT') {
      expect(route.request().headers()['if-match']).toBe(config.revision);
      const body = route.request().postDataJSON();
      writes.push(body);
      config = { ...config, revision: 'rev-2', enabled: false, active: false };
      await route.fulfill({ json: { ...config, apply: { applied: ['web_search'], restart_required: [] } } });
      return;
    }
    await route.fulfill({ json: config });
  });
  await page.goto(await adminUrl('/search-settings'));
  await expect(page.getByRole('heading', { name: 'Web search' })).toBeVisible();
  await expect(page.getByText('Turning search off changes the capability set')).toBeVisible();
  await expect(page.getByLabel('Enable web search')).toBeChecked();
  await expect(page.getByLabel('Engine id')).toHaveValue('main');
  await expect(page.getByLabel('Provider')).toHaveText('Tavily');
  await expect(page.getByLabel('Note for the model')).toHaveValue('Chinese developer blogs');
  await expect(page.getByLabel('Credential')).toHaveText('Keep the configured key');
  await expect(page.getByLabel('Enter a new key')).toHaveCount(0);

  await page.getByLabel('Enable web search').uncheck();
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(toast(page, 'Web search settings saved')).toBeVisible();
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({
    enabled: false,
    engines: [
      {
        id: 'main',
        provider: 'tavily',
        keep_api_key: true,
        api_key: null,
        endpoint: 'https://api.tavily.com/search',
      },
    ],
  });
  // The plaintext never came back from the server, so the page never had it.
  expect(JSON.stringify(config)).not.toContain('tvly-');
});

test('switching provider drops the old endpoint and configured key', async ({ page }) => {
  await page.route('**/api/search/config', async (route) => {
    await route.fulfill({ json: view({ engines: [configuredEngine] }) });
  });
  await page.goto(await adminUrl('/search-settings'));
  await expect(page.getByLabel('Credential')).toHaveText('Keep the configured key');
  await page.getByLabel('Provider').click();
  await page.getByRole('option', { name: 'Brave Search' }).click();
  await expect(page.getByLabel('Provider')).toHaveText('Brave Search');
  // The Tavily address and key belong to Tavily; Brave starts from its own default.
  await expect(page.getByLabel('Endpoint')).toHaveValue('');
  // A key must be entered, so the mode dropdown is not a choice and disappears.
  await expect(page.getByRole('combobox', { name: 'Credential' })).toHaveCount(0);
  await expect(page.getByLabel('Enter a new key')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save settings' })).toBeDisabled();
});

test('adds an engine with a new key and previews URL filter matches', async ({ page }) => {
  let config = view({ enabled: false, active: false, engines: [] });
  const writes: Array<{ enabled: boolean; engines: { id: string; provider: string; api_key: string | null }[] }> = [];
  await page.route('**/api/search/config', async (route) => {
    if (route.request().method() === 'PUT') {
      const body = route.request().postDataJSON();
      writes.push(body);
      config = { ...config, revision: 'rev-2', enabled: true, active: true };
      await route.fulfill({ json: { ...config, apply: { applied: ['web_search'], restart_required: [] } } });
      return;
    }
    await route.fulfill({ json: config });
  });
  await page.goto(await adminUrl('/search-settings'));
  await expect(page.getByText('No engine configured. Add one to make search available.')).toBeVisible();
  await page.getByRole('button', { name: 'Add engine' }).click();
  await expect(page.getByLabel('Engine id')).toHaveValue('tavily-1');
  // No stored key and no DeepSeek alias, so "enter a new key" is the only mode.
  await expect(page.getByRole('combobox', { name: 'Credential' })).toHaveCount(0);
  await page.getByLabel('Enter a new key').fill('e2e-search-key');
  await page.getByLabel('Note for the model').fill('Chinese developer blogs');

  // The preview never sends a request: it only marks what the rules drop.
  await page.getByLabel('Rules').fill('csdn');
  await page.getByLabel('Test URLs').fill('https://blog.csdn.net/a\nhttps://example.com/b');
  await expect(page.getByText('filtered by csdn')).toBeVisible();
  await expect(page.getByText('kept')).toBeVisible();

  await page.getByLabel('Enable web search').check();
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(toast(page, 'Web search settings saved')).toBeVisible();
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({
    enabled: true,
    url_filters: ['csdn'],
    engines: [{ id: 'tavily-1', provider: 'tavily', api_key: 'e2e-search-key', note: 'Chinese developer blogs' }],
  });
});

test('a save conflict offers a reload onto the current revision', async ({ page }) => {
  let served = view({ engines: [configuredEngine] });
  const ifMatch: string[] = [];
  await page.route('**/api/search/config', async (route) => {
    if (route.request().method() === 'PUT') {
      const revision = route.request().headers()['if-match'] ?? '';
      ifMatch.push(revision);
      if (revision !== 'rev-2') {
        // Another tab saved after this page loaded: the server moved to rev-2.
        served = { ...served, revision: 'rev-2' };
        await route.fulfill({ status: 409, json: { error: 'config_conflict', message: 'stale' } });
        return;
      }
      served = { ...served, revision: 'rev-3' };
      await route.fulfill({ json: { ...served, apply: { applied: ['web_search'], restart_required: [] } } });
      return;
    }
    await route.fulfill({ json: served });
  });
  await page.goto(await adminUrl('/search-settings'));
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByText('The configuration changed elsewhere')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save settings' })).toBeDisabled();

  await page.getByRole('button', { name: 'Reload' }).click();
  await expect(page.getByText('The configuration changed elsewhere')).toHaveCount(0);
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(toast(page, 'Web search settings saved')).toBeVisible();
  expect(ifMatch).toEqual(['rev-1', 'rev-2']);
});

test('reusing the only DeepSeek model key saves that alias', async ({ page }) => {
  const writes: unknown[] = [];
  await page.route('**/api/search/config', async (route) => {
    if (route.request().method() === 'PUT') {
      writes.push(route.request().postDataJSON());
      await route.fulfill({
        json: { ...view({ revision: 'rev-2' }), apply: { applied: ['web_search'], restart_required: [] } },
      });
      return;
    }
    await route.fulfill({ json: view({ deepseek_keys: ['deepseek'] }) });
  });
  await page.goto(await adminUrl('/search-settings'));
  await page.getByRole('button', { name: 'Add engine' }).click();
  await page.getByLabel('Provider').click();
  await page.getByRole('option', { name: 'DeepSeek' }).click();
  await page.getByLabel('Credential').click();
  await page.getByRole('option', { name: 'Reuse a DeepSeek model key' }).click();
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(toast(page, 'Web search settings saved')).toBeVisible();
  expect(writes[0]).toMatchObject({
    engines: [{ provider: 'deepseek', api_key: null, keep_api_key: false, key_source: 'deepseek' }],
  });
});

test('renaming a configured engine asks for a credential instead of keeping one', async ({ page }) => {
  await page.route('**/api/search/config', async (route) => {
    await route.fulfill({ json: view({ engines: [configuredEngine] }) });
  });
  await page.goto(await adminUrl('/search-settings'));
  await expect(page.getByLabel('Credential')).toHaveText('Keep the configured key');
  await page.getByLabel('Engine id').fill('renamed');
  // The server keeps keys by id, so the renamed engine has no key to keep;
  // "enter a new key" is then the only mode and its dropdown disappears.
  await expect(page.getByRole('combobox', { name: 'Credential' })).toHaveCount(0);
  await expect(page.getByLabel('Enter a new key')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save settings' })).toBeDisabled();
  // Back on the stored id, keeping the configured key is offered again.
  await page.getByLabel('Engine id').fill('main');
  await page.getByLabel('Credential').click();
  await expect(page.getByRole('option', { name: 'Keep the configured key' })).toBeVisible();
});

test('an invalid URL filter blocks saving with a visible message', async ({ page }) => {
  let writes = 0;
  await page.route('**/api/search/config', async (route) => {
    if (route.request().method() === 'PUT') {
      writes += 1;
    }
    await route.fulfill({ json: view({ enabled: false, active: false }) });
  });
  await page.goto(await adminUrl('/search-settings'));
  await page.getByLabel('Rules').fill('(');
  await expect(page.getByText('Not a valid regular expression: (')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save settings' })).toBeDisabled();
  // The panel uses the server's RE2 rules, so lookaround is refused here too.
  await page.getByLabel('Rules').fill('csdn(?!\\.net)');
  await expect(page.getByText('Not a valid regular expression: csdn(?!\\.net)')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save settings' })).toBeDisabled();
  expect(writes).toBe(0);
});
