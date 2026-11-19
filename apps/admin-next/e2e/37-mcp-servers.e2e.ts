import { writeFile } from 'node:fs/promises';
import { type APIResponse, expect, type Page, type TestInfo } from '@playwright/test';
import { adminUrl, e2eFetch, test, toast } from './helpers.ts';
import { E2E_MCP_DESCRIPTION_DRAFT, E2E_MERGE_ALIAS, E2E_MERGE_MODEL } from './models-fixture.ts';

// The whole spec opts into the live MCP manager (stdio fixture + a degraded
// HTTP endpoint); every test below sets up exactly the state it needs through
// the API first, so each one passes alone, in any order, and on a repeat run.
test.use({ signedIn: true, mcpManager: true });

/** The config file's raw text, read through the test-only hook from the server's own temp directory. */
async function configText(): Promise<{ readonly path: string; readonly text: string }> {
  return await e2eFetch<{ readonly path: string; readonly text: string }>('/config-text');
}

/** The parsed config file: the e2e fixture writes plain JSON, so JSON.parse is exact. */
async function configFile(): Promise<{
  readonly mcp?: { readonly servers?: readonly { alias?: string }[] };
  readonly telegram?: { readonly chats?: readonly { id?: number; mcp?: unknown }[] };
}> {
  return JSON.parse((await configText()).text);
}

/** The config revision right now, for API setup writes. */
async function revision(page: Page): Promise<string> {
  const response = await page.request.get(await adminUrl('/api/mcp-servers'));
  expect(response.status()).toBe(200);
  return ((await response.json()) as { revision: string }).revision;
}

/** A config write through the API, the way another operator or the CLI would do it. */
async function apiWrite(page: Page, route: string, method: string, body: unknown): Promise<APIResponse> {
  return await page.request.fetch(await adminUrl(`/api${route}`), {
    method,
    headers: { 'content-type': 'application/json', 'if-match': await revision(page) },
    data: JSON.stringify(body),
  });
}

/**
 * Removes a server a previous run left behind so a test can create it fresh.
 * A failed earlier run may also have left it bound; the binding this spec ever
 * creates is chat 123456789's, so clearing that unblocks the delete.
 */
async function ensureServerAbsent(page: Page, alias: string): Promise<void> {
  const remove = async (): Promise<APIResponse> =>
    await page.request.fetch(await adminUrl(`/api/mcp-servers/${encodeURIComponent(alias)}`), {
      method: 'DELETE',
      headers: { 'if-match': await revision(page) },
    });
  let response = await remove();
  if (response.status() === 409) {
    await resetBinding(page, '123456789');
    response = await remove();
  }
  expect([200, 404]).toContain(response.status());
}

/** Restores the seeded stdio server's tool selection and exposure, so a UI edit always starts from the same shape. */
async function resetStdioSelection(page: Page): Promise<void> {
  const response = await apiWrite(page, '/mcp-servers/stdio-fixture', 'PUT', {
    tools: ['echo'],
    payload_max_bytes: 32_768,
    result_max_bytes: 32_768,
    tool_policies: [{ name: 'echo', read_only: true, timeout_seconds: 20 }],
    exposure: 'direct',
    description: null,
  });
  expect(response.status(), await response.text()).toBe(200);
}

/** Points the Tool Model at the loopback upstream (`inherit: true` restores the default). */
async function setToolModel(page: Page, body: Record<string, unknown>): Promise<void> {
  const providers = (await (await page.request.get(await adminUrl('/api/providers'))).json()) as {
    readonly revision: string;
  };
  const response = await page.request.put(await adminUrl('/api/tool-model'), {
    headers: { 'if-match': providers.revision },
    data: body,
  });
  expect(response.ok(), await response.text()).toBe(true);
}

/** Restores a chat to inheriting every server (no `mcp` field). */
async function resetBinding(page: Page, chat: string): Promise<void> {
  const response = await apiWrite(page, `/chats/${chat}/mcp`, 'PUT', { mode: 'inherit' });
  expect(response.status(), await response.text()).toBe(200);
}

/** The verifiable artifact: the page as it stands plus the mcp section the writes left on disk. */
async function writeArtifact(testInfo: TestInfo, page: Page): Promise<void> {
  const config = await configText();
  const mcpStart = config.text.indexOf('"mcp"');
  const mcpSection = mcpStart < 0 ? '(no mcp section)' : config.text.slice(Math.max(0, mcpStart - 2));
  await page.screenshot({ path: testInfo.outputPath('mcp-servers.png'), fullPage: true });
  await testInfo.attach('mcp-servers', { path: testInfo.outputPath('mcp-servers.png'), contentType: 'image/png' });
  await writeFile(testInfo.outputPath('config-mcp.jsonc'), mcpSection, 'utf8');
  await testInfo.attach('config-mcp', { path: testInfo.outputPath('config-mcp.jsonc'), contentType: 'text/plain' });
}

test('lists the fixture servers with live state and discovered tools', async ({ page }) => {
  await page.goto(await adminUrl('/mcp-servers'));
  await expect(page.getByRole('heading', { name: 'MCP servers', exact: true })).toBeVisible();
  const stdioRow = page.locator('table tbody tr', { hasText: 'stdio-fixture' });
  await expect(stdioRow).toBeVisible();
  // The stdio fixture connects in the background; wait for it to report ready.
  await expect(stdioRow.getByText('Ready', { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(stdioRow.getByText('echo')).toBeVisible();

  const httpRow = page.locator('table tbody tr', { hasText: 'http-remote' });
  await expect(httpRow.getByText(/^Degraded/)).toBeVisible({ timeout: 30_000 });
  // The inheriting chat is named under the page, not the server row.
  await expect(page.getByText('Chats without an MCP binding inherit every server: 123456789')).toBeVisible();

  // The detail view shows every advertised tool, including the unselected ones,
  // with descriptions and input schemas as plain data.
  await stdioRow.getByRole('button', { name: 'View stdio-fixture' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('stdio', { exact: true })).toBeVisible();
  await expect(dialog.locator('table tbody tr', { hasText: 'echo' }).getByText('Exposed')).toBeVisible();
  await expect(dialog.locator('table tbody tr', { hasText: 'wait' }).getByText('Hidden')).toBeVisible();
  await expect(dialog.locator('table tbody tr', { hasText: 'images' }).getByText('Hidden')).toBeVisible();
  await expect(dialog.getByText('Echo text with a server-side call count')).toBeVisible();
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toHaveCount(0);
});

test('adds an HTTP server with a header secret, saves and lists it', async ({ page }) => {
  await ensureServerAbsent(page, 'added-http');
  await page.goto(await adminUrl('/mcp-servers'));
  await page.getByRole('button', { name: 'Add server', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Alias', { exact: true }).fill('added-http');
  await dialog.getByLabel('URL', { exact: true }).fill('https://added.example.test/mcp');
  // A header with a fresh secret: the plaintext goes to the keychain.
  await dialog.getByRole('button', { name: 'Add header' }).click();
  await dialog.getByLabel('Header name', { exact: true }).fill('x-api-key');
  await dialog.getByLabel('Value', { exact: true }).fill('e2e-added-mcp-secret');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(toast(page, 'Applied')).toBeVisible();

  const addedRow = page.locator('table tbody tr', { hasText: 'added-http' });
  await expect(addedRow).toBeVisible();
  await expect(addedRow.getByText('streamable_http')).toBeVisible();
  await expect(addedRow.getByText(/^Degraded/)).toBeVisible({ timeout: 30_000 });

  const config = await configText();
  expect(config.text).toContain('"alias": "added-http"');
  expect(config.text).toContain('"url": "https://added.example.test/mcp"');
  expect(config.text).toContain('"follow_redirects": false');
  // The file names the keychain entry; the plaintext never appears.
  expect(config.text).toContain('"x-api-key"');
  expect(config.text).not.toContain('e2e-added-mcp-secret');
});

test('edits a stdio server policy while its command stays read-only', async ({ page }) => {
  await resetStdioSelection(page);
  await page.goto(await adminUrl('/mcp-servers'));
  await page
    .locator('table tbody tr', { hasText: 'stdio-fixture' })
    .getByRole('button', { name: 'Edit stdio-fixture' })
    .click();
  const dialog = page.getByRole('dialog');
  // The alias and the stdio connection are shown, not offered for editing.
  await expect(dialog.getByLabel('Alias', { exact: true })).toHaveValue('stdio-fixture');
  await expect(dialog.getByLabel('Alias', { exact: true })).not.toBeEditable();
  await expect(dialog.getByText(/stdio: runs node\./)).toBeVisible();
  // Widen the tool list: switch to selected tools and add a second row.
  await dialog.getByRole('radio', { name: /Selected tools/ }).check();
  await dialog.getByRole('button', { name: 'Add tool', exact: true }).click();
  const toolInputs = dialog.getByLabel(/^Tool name /);
  await toolInputs.nth(1).fill('wait');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(toast(page, 'Applied')).toBeVisible();

  const config = await configText();
  expect(config.text).toContain('"echo"');
  expect(config.text).toContain('"wait"');
  // The connection is untouched: still the fixture command.
  expect(config.text).toContain('mcp-server.ts');
});

test('the Chats page MCP dialog sets explicit bindings', async ({ page }) => {
  await resetBinding(page, '123456789');
  const chatMcp = async (): Promise<unknown> =>
    (await configFile()).telegram?.chats?.find((chat) => chat.id === 123_456_789)?.mcp;

  await page.goto(await adminUrl('/chats'));
  const chatRow = page.locator('table tbody tr', { hasText: '123456789' });
  await chatRow.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'MCP servers' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('radio', { name: /Inherit every server/ })).toBeChecked();
  await dialog.getByRole('radio', { name: /Explicit bindings/ }).check();
  await dialog.getByRole('switch', { name: 'Bind stdio-fixture' }).check();
  // The stdio server only exposes `echo`; the binding narrows to it.
  await dialog.getByRole('radio', { name: /^Selected tools/ }).check();
  await dialog.getByRole('checkbox', { name: 'echo' }).check();
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(await chatMcp()).toEqual([{ server: 'stdio-fixture', tools: ['echo'] }]);

  // `none` writes the empty list, `inherit` removes the field again.
  await page.goto(await adminUrl('/chats'));
  await page.locator('table tbody tr', { hasText: '123456789' }).getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'MCP servers' }).click();
  await page
    .getByRole('dialog')
    .getByRole('radio', { name: /No MCP tools/ })
    .check();
  await page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await chatMcp()).toEqual([]);

  await page.goto(await adminUrl('/chats'));
  await page.locator('table tbody tr', { hasText: '123456789' }).getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'MCP servers' }).click();
  await page
    .getByRole('dialog')
    .getByRole('radio', { name: /Inherit every server/ })
    .check();
  await page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await chatMcp()).toBeUndefined();
});

test('deleting a bound server is blocked; an unbound one is removed', async ({ page }, testInfo) => {
  // This test owns its server and its binding, so it passes after any failure.
  await ensureServerAbsent(page, 'blocked-http');
  const created = await apiWrite(page, '/mcp-servers', 'POST', {
    alias: 'blocked-http',
    url: 'https://blocked.example.test/mcp',
    tools: '*',
    payload_max_bytes: 32_768,
    result_max_bytes: 32_768,
    default_tool_policy: { read_only: true, timeout_seconds: 30 },
  });
  expect(created.status(), await created.text()).toBe(200);
  const bound = await apiWrite(page, '/chats/123456789/mcp', 'PUT', {
    mode: 'explicit',
    bindings: [{ server: 'blocked-http' }],
  });
  expect(bound.status(), await bound.text()).toBe(200);

  await page.goto(await adminUrl('/mcp-servers'));
  const blockedRow = page.locator('table tbody tr', { hasText: 'blocked-http' });
  await expect(blockedRow.getByText('Bound: 123456789')).toBeVisible();
  await blockedRow.getByRole('button', { name: 'Delete blocked-http' }).click();
  // The destructive confirmation renders as an alertdialog, not a plain dialog.
  const confirm = page.getByRole('alertdialog');
  await confirm.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(confirm.getByText(/still bind MCP server blocked-http/)).toBeVisible();
  await expect(confirm.getByText('123456789')).toBeVisible();
  await confirm.getByRole('button', { name: 'Dismiss' }).click();
  await expect(confirm).toHaveCount(0);
  expect((await configFile()).mcp?.servers?.some((server) => server.alias === 'blocked-http')).toBe(true);

  // Unbound through the API, the delete goes through.
  await resetBinding(page, '123456789');
  await page.reload();
  await page
    .locator('table tbody tr', { hasText: 'blocked-http' })
    .getByRole('button', { name: 'Delete blocked-http' })
    .click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.locator('table tbody tr', { hasText: 'blocked-http' })).toHaveCount(0);
  const config = await configFile();
  expect(config.mcp?.servers?.some((server) => server.alias === 'blocked-http')).toBe(false);
  expect(config.mcp?.servers?.some((server) => server.alias === 'stdio-fixture')).toBe(true);
  await writeArtifact(testInfo, page);
});

test('switches a server to progressive exposure with a confirmed tool-model description', async ({
  page,
}, testInfo) => {
  await resetStdioSelection(page);
  await setToolModel(page, { provider: E2E_MERGE_ALIAS, model: E2E_MERGE_MODEL, thinking_level: 'low' });
  try {
    await page.goto(await adminUrl('/mcp-servers'));
    const row = page.locator('table tbody tr', { hasText: 'stdio-fixture' });
    // A draft needs the tools the server advertised, so wait for it to connect.
    await expect(row.getByText('Ready', { exact: true })).toBeVisible({ timeout: 30_000 });
    await row.getByRole('button', { name: 'Edit stdio-fixture' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('radio', { name: /^Progressive/ }).check();
    await expect(
      dialog.getByText('Without a description the model only sees a few tool names of this server.'),
    ).toBeVisible();

    // A draft describes the saved server, so unsaved connection edits block it.
    const draftButton = dialog.getByRole('button', { name: 'Draft with tool model', exact: true });
    const resultLimit = dialog.getByLabel('Result limit (bytes)', { exact: true });
    await resultLimit.fill('1024');
    await expect(draftButton).toBeDisabled();
    await expect(
      dialog.getByText('A draft describes the saved server: save the connection and tool changes first.'),
    ).toBeVisible();
    await resultLimit.fill('32768');
    await expect(draftButton).toBeEnabled();
    const savedServer = (await configFile()).mcp?.servers?.find((entry) => entry.alias === 'stdio-fixture');

    await draftButton.click();
    const description = dialog.getByLabel('Description', { exact: true });
    await expect(description).toHaveValue(E2E_MCP_DESCRIPTION_DRAFT);
    // The draft only filled the field: nothing is in the file before Save.
    expect((await configText()).text).not.toContain(E2E_MCP_DESCRIPTION_DRAFT);
    await description.fill(`${E2E_MCP_DESCRIPTION_DRAFT} Reviewed.`);

    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(toast(page, 'Applied')).toBeVisible();
    await expect(row.getByText('Progressive', { exact: true })).toBeVisible();
    const server = (await configFile()).mcp?.servers?.find((entry) => entry.alias === 'stdio-fixture') as
      | Record<string, unknown>
      | undefined;
    // A presentation-only save leaves every connection field exactly as stored.
    expect(server).toEqual({
      ...savedServer,
      exposure: 'progressive',
      description: `${E2E_MCP_DESCRIPTION_DRAFT} Reviewed.`,
    });

    // The detail view shows both fields back.
    await row.getByRole('button', { name: 'View stdio-fixture' }).click();
    const detail = page.getByRole('dialog');
    await expect(detail.getByText(`${E2E_MCP_DESCRIPTION_DRAFT} Reviewed.`)).toBeVisible();
    await writeArtifact(testInfo, page);
    await detail.getByRole('button', { name: 'Close' }).click();
  } finally {
    await setToolModel(page, { inherit: true });
    await resetStdioSelection(page);
  }
});
