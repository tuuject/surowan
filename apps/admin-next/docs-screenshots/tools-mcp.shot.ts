/**
 * MCP screenshots: the server list with live state and progressive exposure,
 * the per-Chat binding dialog and the standing warning a degraded server
 * raises.
 *
 * The whole file runs the real outbound MCP manager (`test.use({ mcpManager })`):
 * the stdio fixture connects over a child process, the HTTP server points at a
 * closed port and settles into `degraded`. Exposure and the description are
 * written the way the panel writes them; the binding is saved through the Chat
 * dialog.
 */
import type { Page } from '@playwright/test';
import { docsSeedText } from '../e2e/docs-locale.ts';
import { adminUrl, e2eFetch } from '../e2e/helpers.ts';
import { DOCS_IDS } from '../e2e/server-docs-ids.ts';
import { captureScreenshot } from './capture.ts';
import { apiJson, expect, test } from './fixtures.ts';
import { docsLabels } from './labels.ts';

test.use({ signedIn: true, mcpManager: true });

const STDIO = 'stdio-fixture';
const SKILLS = 'skills-fixture';
const DEGRADED = 'http-remote';

interface McpServersView {
  readonly revision: string;
  readonly servers: readonly {
    readonly alias: string;
    readonly exposure: string;
    readonly description: string | null;
    readonly skills: readonly unknown[];
    readonly state: { readonly state: string } | null;
  }[];
}

interface ChatsView {
  readonly items: readonly {
    readonly id: string;
    readonly saved: { readonly mcp: readonly { readonly server: string; readonly tools: unknown }[] | null } | null;
  }[];
}

/** Writes one server's presentation fields through the real API (the panel's own body). */
async function writeServer(page: Page, alias: string, body: unknown): Promise<void> {
  const view = await apiJson<McpServersView>(page, await adminUrl('/api/mcp-servers'));
  const response = await page.request.put(await adminUrl(`/api/mcp-servers/${alias}`), {
    headers: { 'content-type': 'application/json', 'if-match': view.revision },
    data: body,
  });
  expect(response.ok(), await response.text()).toBe(true);
}

test('tools/mcp-servers', async ({ page, docLocale }) => {
  const labels = docsLabels(docLocale);
  const seed = docsSeedText(docLocale);
  // Progressive exposure plus a description is the state the tools guide
  // documents; the connection fields stay exactly as the fixture wrote them.
  await writeServer(page, STDIO, {
    tools: ['echo'],
    payload_max_bytes: 32_768,
    result_max_bytes: 32_768,
    tool_policies: [{ name: 'echo', read_only: true, timeout_seconds: 20 }],
    exposure: 'progressive',
    description: seed.mcp.description,
  });

  await page.goto(await adminUrl('/mcp-servers'));
  await expect(page.getByRole('heading', { name: labels.mcp.title, exact: true })).toBeVisible();
  const stdio = page.locator('table tbody tr').filter({ hasText: STDIO });
  await expect(stdio.getByText(labels.mcp.ready, { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(stdio.getByText(labels.mcp.progressive, { exact: true })).toBeVisible();
  await expect(stdio.getByText('echo', { exact: true })).toBeVisible();

  const skills = page.locator('table tbody tr').filter({ hasText: SKILLS });
  await expect(skills.getByText(labels.mcp.ready, { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(skills.getByText(labels.mcp.skillsBadge(2), { exact: true })).toBeVisible();

  // The HTTP server can read `connecting` while it retries: wait for the API
  // to settle on the degraded state the row renders.
  const degraded = page.locator('table tbody tr').filter({ hasText: DEGRADED });
  await expect
    .poll(
      async () =>
        (await apiJson<McpServersView>(page, await adminUrl('/api/mcp-servers'))).servers.find(
          (server) => server.alias === DEGRADED,
        )?.state?.state,
      { timeout: 30_000 },
    )
    .toBe('degraded');
  await expect(degraded.getByText(new RegExp(`^${labels.mcp.degraded}`))).toBeVisible();

  const view = await apiJson<McpServersView>(page, await adminUrl('/api/mcp-servers'));
  const stdioView = view.servers.find((server) => server.alias === STDIO);
  expect(stdioView).toMatchObject({ exposure: 'progressive', description: seed.mcp.description });
  expect(stdioView?.state?.state).toBe('ready');
  expect(view.servers.find((server) => server.alias === SKILLS)?.skills.length).toBe(2);

  await captureScreenshot(page, docLocale, 'tools/mcp-servers');
});

test('chats/mcp-binding', async ({ page, docLocale }) => {
  const labels = docsLabels(docLocale);
  const group = DOCS_IDS.groupChatHostId.toString();
  await page.goto(await adminUrl('/chats'));
  const row = page.locator('table tbody tr').filter({ hasText: group });
  await expect(row).toBeVisible();

  const openDialog = async (): Promise<void> => {
    await row.getByRole('button', { name: labels.chats.moreActions, exact: true }).click();
    await page.getByRole('menuitem', { name: labels.chats.editMcp, exact: true }).click();
  };

  await openDialog();
  let dialog = page.getByRole('dialog', { name: labels.chats.mcp.title, exact: true });
  await expect(dialog.getByRole('radio', { name: labels.chats.mcp.explicit, exact: true })).not.toBeChecked();
  await dialog.getByRole('radio', { name: labels.chats.mcp.explicit, exact: true }).check();
  await dialog.getByRole('switch', { name: labels.chats.mcp.bind(STDIO), exact: true }).check();
  await dialog.getByRole('radio', { name: labels.chats.mcp.selectedTools, exact: true }).check();
  await dialog.getByRole('checkbox', { name: 'echo', exact: true }).check();
  await dialog.getByRole('button', { name: labels.chats.dialogSave, exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // The binding is in the Chat's own section of the configuration file; parse
  // the file rather than pattern-matching a window around the Chat id.
  const expected = [{ server: STDIO, tools: ['echo'] }];
  const view = await apiJson<ChatsView>(page, await adminUrl('/api/chats'));
  expect(view.items.find((item) => item.id === group)?.saved?.mcp).toEqual(expected);
  const config = await e2eFetch<{ readonly text: string }>('/config-text');
  const file = JSON.parse(config.text) as {
    readonly telegram?: { readonly chats?: readonly { readonly id?: number; readonly mcp?: unknown }[] };
  };
  expect(file.telegram?.chats?.find((chat) => String(chat.id) === group)?.mcp).toEqual(expected);

  // The dialog reopens on the Chats view; reload so it cannot mount a stale
  // pre-save snapshot while the page's own refetch is still in flight.
  await page.reload();
  await expect(row).toBeVisible();
  await openDialog();
  dialog = page.getByRole('dialog', { name: labels.chats.mcp.title, exact: true });
  await expect(dialog.getByRole('switch', { name: labels.chats.mcp.bind(STDIO), exact: true })).toBeChecked();
  await expect(dialog.getByRole('checkbox', { name: 'echo', exact: true })).toBeChecked();
  await expect(page.locator('[data-koi-toast]')).toHaveCount(0);

  await captureScreenshot(page, docLocale, 'chats/mcp-binding', dialog);
});

test('troubleshooting/mcp-degraded', async ({ page, docLocale }) => {
  const labels = docsLabels(docLocale);
  await page.goto(await adminUrl('/warnings'));
  const standing = page.getByRole('region', { name: labels.warnings.standingTitle, exact: true });
  await expect(standing).toBeVisible();

  // The standing warning is derived from live manager state on every read, so
  // it only exists while the HTTP server really is unreachable.
  const heading = page.getByRole('heading', { name: labels.warnings.mcpUnavailable, exact: true });
  await expect(standing.getByRole('heading', { name: labels.warnings.mcpUnavailable, exact: true })).toBeVisible({
    timeout: 30_000,
  });
  // Both the cause and the alias must sit in the same card, not just anywhere in
  // the panel: the deepest container holding the heading also names the alias.
  const card = page.locator('div').filter({ has: heading }).filter({ hasText: DEGRADED }).last();
  await expect(card).toContainText(DEGRADED);
  await expect(card).toContainText(labels.warnings.mcpUnavailable);

  await captureScreenshot(page, docLocale, 'troubleshooting/mcp-degraded', standing);
});
