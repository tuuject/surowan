/**
 * Shared fixture for the `16-model-health*` specs: the loopback health
 * providers they create through the real write API, plus the relay, page and
 * wire-shape helpers all of them drive.
 *
 * Each spec file boots its own freshly seeded server, so the provider setup and
 * teardown is registered per file by `modelHealthFixture` rather than once
 * for the suite. The fixture creates `health-a` (ok / unexpected models) and
 * `health-b` (upstream failure) on top of the relay connection the E2E fixture
 * already serves, and deletes exactly those aliases again.
 *
 * The wire contract the specs assert is pinned here: one user message with the
 * fixed prompt, no system role, no tools, streaming, output capped at 128.
 */
import { expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { adminUrl, E2E_PASSWORD, E2E_USERNAME, e2eFetch, test } from './helpers.ts';
import {
  E2E_HEALTH_ALIAS_A,
  E2E_HEALTH_ALIAS_B,
  E2E_HEALTH_FAIL_MODEL,
  E2E_HEALTH_OK_2_MODEL,
  E2E_HEALTH_OK_MODEL,
  E2E_HEALTH_PROMPT,
  E2E_HEALTH_UNEXPECTED_MODEL,
  E2E_RELAY_ALIAS,
  E2E_SECRETS,
} from './models-fixture.ts';

const USERNAME = E2E_USERNAME;
const PASSWORD = E2E_PASSWORD;

/** Providers this fixture creates; afterAll deletes exactly these aliases. */
const CREATED_ALIASES = [E2E_HEALTH_ALIAS_A, E2E_HEALTH_ALIAS_B] as const;

export interface RelayRequestRecord {
  readonly model: string;
  readonly aborted: boolean;
  readonly completed: boolean;
}

export interface RelayStats {
  readonly total: number;
  readonly by_model: Record<string, number>;
  readonly max_concurrent: number;
  readonly in_flight: number;
  readonly rejected: number;
  readonly aborted: number;
  readonly completed: number;
  readonly records: readonly RelayRequestRecord[];
  readonly bodies: readonly Record<string, unknown>[];
}

export interface ProvidersView {
  readonly revision: string;
  readonly agent: { readonly provider: string; readonly model: string };
  readonly vision: { readonly provider: string; readonly model: string };
  readonly providers: readonly { readonly alias: string; readonly base_url: string }[];
}

let cookie = '';

export async function relayStats(): Promise<RelayStats> {
  return await e2eFetch<RelayStats>('/relay-stats');
}

export async function resetRelayStats(): Promise<void> {
  await e2eFetch('/relay-stats/reset', { method: 'POST' });
}

/**
 * Test-only upstream gate: `hold` parks health requests for `model` (or every
 * model when omitted) before the fixture answers, `release` lets them proceed.
 * Holding before a click makes "still checking" and "cancelled" deterministic:
 * nothing settles until the spec says so.
 */
async function setHealthGate(action: 'hold' | 'release', model?: string): Promise<void> {
  await e2eFetch(`/health-gate/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(model === undefined ? {} : { model }),
  });
}

export const holdHealthGate = (model?: string): Promise<void> => setHealthGate('hold', model);
export const releaseHealthGate = (model?: string): Promise<void> => setHealthGate('release', model);

export async function selectProvider(page: Page, alias: string): Promise<void> {
  await page.getByRole('button', { name: `Provider ${alias}` }).click();
  await expect(page.locator('h2', { hasText: alias })).toBeVisible();
}

/** The table row whose model id cell is exactly `modelId` (ids may prefix each other). */
export function modelRow(page: Page, modelId: string): Locator {
  return page.locator('tr').filter({ has: page.getByText(modelId, { exact: true }) });
}

/** The expandable details row that TableShell renders right after the model row. */
export function expandedRow(page: Page, modelId: string): Locator {
  return modelRow(page, modelId).locator('xpath=following-sibling::tr[1]');
}

export async function showHealthDetails(page: Page, modelId: string): Promise<void> {
  await modelRow(page, modelId).getByRole('button', { name: 'Toggle row details' }).click();
}

export async function providersView(page: Page): Promise<ProvidersView> {
  return (await (await page.request.get(await adminUrl('/api/providers'))).json()) as ProvidersView;
}

/**
 * The wire contract the upstream must have seen: one user message with the
 * exact fixed prompt, no system role, no tools, streaming, output capped at 128.
 */
export function assertHealthRequestShape(body: Record<string, unknown>, model: string): void {
  expect(body.model).toBe(model);
  expect(body.stream).toBe(true);
  expect(body.tools).toBeUndefined();
  expect(body.tool_choice).toBeUndefined();
  const messages = body.messages as unknown;
  expect(Array.isArray(messages)).toBe(true);
  const list = messages as Array<Record<string, unknown>>;
  expect(list).toHaveLength(1);
  expect(list[0]?.role).toBe('user');
  expect(list[0]?.content).toBe(E2E_HEALTH_PROMPT);
  const cap = (body.max_tokens as number | undefined) ?? (body.max_completion_tokens as number | undefined);
  expect(cap).toBeLessThanOrEqual(128);
}

function healthModel(id: string, name: string): Record<string, unknown> {
  return {
    id,
    name,
    reasoning: false,
    input: ['text'],
    context_window: 4096,
    max_tokens: 128,
    cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
  };
}

/** Creates the health providers the calling file checks. */
async function createHealthProviders(request: APIRequestContext): Promise<void> {
  // Sign in through the API like 14-api-keys does, so the spec also works on
  // its own; the browser tests reuse the shared storage state from 00-auth.
  const session = await request.get(await adminUrl('/api/auth/session'));
  const state = (await session.json()) as { setup_required: boolean };
  const response = state.setup_required
    ? await request.post(await adminUrl('/api/auth/setup'), { data: { username: USERNAME, password: PASSWORD } })
    : await request.post(await adminUrl('/api/auth/login'), { data: { username: USERNAME, password: PASSWORD } });
  expect(response.status()).toBe(200);
  const header = response.headers()['set-cookie'] ?? '';
  cookie = header.slice(0, header.indexOf(';'));
  expect(cookie.startsWith('plasticwan_admin=')).toBe(true);

  // The new providers reuse the relay connection the fixture already serves
  // models and chat completions from; only their model ids are new.
  const view = (await (
    await request.get(await adminUrl('/api/providers'), { headers: { cookie } })
  ).json()) as ProvidersView;
  const relay = view.providers.find((provider) => provider.alias === E2E_RELAY_ALIAS);
  expect(relay, `fixture provider ${E2E_RELAY_ALIAS} is missing`).toBeDefined();
  let revision = view.revision;
  for (const [alias, models] of [
    [
      E2E_HEALTH_ALIAS_A,
      [
        healthModel(E2E_HEALTH_OK_MODEL, 'Health OK'),
        healthModel(E2E_HEALTH_OK_2_MODEL, 'Health OK 2'),
        healthModel(E2E_HEALTH_UNEXPECTED_MODEL, 'Health unexpected'),
      ],
    ],
    [E2E_HEALTH_ALIAS_B, [healthModel(E2E_HEALTH_FAIL_MODEL, 'Health fail')]],
  ] as const) {
    const created = await request.post(await adminUrl('/api/providers'), {
      headers: { cookie, 'if-match': revision },
      data: {
        alias,
        kind: 'custom',
        base_url: relay?.base_url,
        api: 'openai-completions',
        api_key: E2E_SECRETS.health,
        models,
      },
    });
    expect(created.status(), `creating ${alias} failed`).toBe(200);
    revision = ((await created.json()) as ProvidersView).revision;
  }
}

/** Deletes exactly the aliases `createHealthProviders` added. */
async function deleteHealthProviders(request: APIRequestContext): Promise<void> {
  if (cookie.length === 0) {
    return;
  }
  for (const alias of CREATED_ALIASES) {
    const view = (await (
      await request.get(await adminUrl('/api/providers'), { headers: { cookie } })
    ).json()) as ProvidersView;
    if (!view.providers.some((provider) => provider.alias === alias)) {
      continue;
    }
    const deleted = await request.delete(await adminUrl(`/api/providers/${alias}`), {
      headers: { cookie, 'if-match': view.revision },
    });
    expect(deleted.status(), `deleting ${alias} failed`).toBe(200);
  }
}

/**
 * Registers the file-scoped provider setup/teardown and the gate cleanup every
 * health spec needs: whatever a test does to the upstream gate, the hold never
 * leaks into the next test.
 */
export function modelHealthFixture(): void {
  test.beforeAll(async ({ request }) => {
    await createHealthProviders(request);
  });

  test.afterAll(async ({ request }) => {
    await deleteHealthProviders(request);
  });

  test.afterEach(async () => {
    await releaseHealthGate();
  });
}
