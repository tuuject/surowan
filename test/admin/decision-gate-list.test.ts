import { expect, test } from 'vitest';
import { fixture, seedDecision } from './decision-gate-fixtures.ts';

/**
 * `GET /decision-gate/decisions`: the read-only list shadow data is reviewed
 * through. It follows the audit listings — snapshot pagination, a Chat filter
 * by Telegram id, ids as strings — and needs no write permission.
 */

interface DecisionPage {
  readonly items: readonly {
    readonly id: string;
    readonly bucket_id: string;
    readonly conversation_id: string;
    readonly chat: { readonly host_kind: string; readonly telegram_chat_id: string | null; readonly type: string };
    readonly mode: string;
    readonly model: string;
    readonly state: string;
    readonly outcome: string | null;
    readonly applied: boolean;
    readonly probability: number | null;
    readonly threshold: number;
    readonly history_count: number;
    readonly pending_count: number;
    readonly input_tokens: number | null;
    readonly cost: number | null;
    readonly duration_ms: number | null;
    readonly error_code: string | null;
    readonly error_detail: string | null;
    readonly created_at: string;
    readonly finished_at: string | null;
  }[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
  readonly as_of: string;
  readonly new_count: number;
}

const OTHER_GROUP = -1_001_234_567_891;

test('rows are newest first and carry the Chat and Conversation they belong to', async () => {
  const f = await fixture();
  const now = Date.now();
  // One time base per test: every timestamp is derived from `now`.
  const first = seedDecision(f.store, {
    telegramChatId: -1_001_234_567_890,
    conversationId: 900n,
    createdAt: new Date(now - 3_000).toISOString(),
  });
  const second = seedDecision(
    f.store,
    {
      telegramChatId: -1_001_234_567_890,
      conversationId: 901n,
      mode: 'enforce',
      outcome: 'drop',
      applied: true,
      probability: 0.12,
      createdAt: new Date(now - 2_000).toISOString(),
    },
    { model: 'typesafe/jev-1.14' },
  );
  const third = seedDecision(
    f.store,
    {
      telegramChatId: OTHER_GROUP,
      conversationId: 902n,
      state: 'error',
      outcome: null,
      createdAt: new Date(now - 1_000).toISOString(),
    },
    { errorCode: 'timeout', errorDetail: 'the request timed out' },
  );
  const page = (await (await f.call('/decision-gate/decisions')).json()) as DecisionPage;
  expect(page.items.map((item) => item.id)).toEqual([third.toString(), second.toString(), first.toString()]);
  expect(page.total).toBe(3);
  expect(page.limit).toBe(25);
  expect(page.offset).toBe(0);
  const newest = page.items[0];
  expect(newest).toMatchObject({
    bucket_id: expect.stringMatching(/^\d+$/),
    conversation_id: '902',
    chat: { host_kind: 'telegram', telegram_chat_id: String(OTHER_GROUP), type: 'supergroup' },
    mode: 'shadow',
    model: 'typesafe/jev-1.14',
    state: 'error',
    outcome: null,
    applied: false,
    probability: 0.81,
    threshold: 0.57,
    history_count: 6,
    pending_count: 3,
    input_tokens: 190,
    cost: 0.0004,
    duration_ms: 730,
    error_code: 'timeout',
    error_detail: 'the request timed out',
    finished_at: expect.any(String),
  });
  expect(page.items[1]).toMatchObject({ mode: 'enforce', outcome: 'drop', applied: true, probability: 0.12 });
});

test('the Chat filter never leaks another Chat’s rows and pages one frozen set', async () => {
  const f = await fixture();
  const ids: string[] = [];
  for (let index = 0; index < 3; index += 1) {
    ids.push(
      seedDecision(f.store, {
        telegramChatId: -1_001_234_567_890,
        conversationId: BigInt(910 + index),
        createdAt: new Date(Date.now() - index * 1_000).toISOString(),
      }).toString(),
    );
  }
  const otherRow = seedDecision(f.store, { telegramChatId: OTHER_GROUP, conversationId: 950n }).toString();
  const all = (await (await f.call('/decision-gate/decisions')).json()) as DecisionPage;
  expect(all.total).toBe(4);

  const filtered = (await (await f.call(`/decision-gate/decisions?chat=${OTHER_GROUP}`)).json()) as DecisionPage;
  expect(filtered.total).toBe(1);
  expect(filtered.items[0]?.chat.telegram_chat_id).toBe(String(OTHER_GROUP));

  const firstPage = (await (await f.call('/decision-gate/decisions?limit=2&offset=0')).json()) as DecisionPage;
  expect(firstPage.items.map((item) => item.id)).toEqual([otherRow, ids[2]]);
  expect(firstPage.total).toBe(4);
  const secondPage = (await (
    await f.call(`/decision-gate/decisions?limit=2&offset=2&as_of=${firstPage.as_of}`)
  ).json()) as DecisionPage;
  expect(secondPage.items.map((item) => item.id)).toEqual([ids[1], ids[0]]);
  // A row inserted after the snapshot is counted, never spliced into the page.
  seedDecision(f.store, { telegramChatId: OTHER_GROUP, conversationId: 951n });
  const later = (await (
    await f.call(`/decision-gate/decisions?limit=2&offset=2&as_of=${firstPage.as_of}`)
  ).json()) as DecisionPage;
  expect(later.items.map((item) => item.id)).toEqual([ids[1], ids[0]]);
  expect(later.new_count).toBe(1);
});

test('page and filter parameters are bounded and validated', async () => {
  const f = await fixture();
  for (const [query, error] of [
    ['limit=0', 'invalid_limit'],
    ['limit=101', 'invalid_limit'],
    ['limit=abc', 'invalid_limit'],
    ['offset=-1', 'invalid_offset'],
    ['offset=abc', 'invalid_offset'],
    ['chat=abc', 'invalid_chat'],
    ['as_of=nope', 'invalid_as_of'],
  ] as const) {
    const response = await f.call(`/decision-gate/decisions?${query}`);
    expect(response.status, query).toBe(400);
    expect(await response.json()).toMatchObject({ error });
  }
  // A parameter the endpoint does not read is ignored, as on the neighbouring lists.
  const ignored = (await (await f.call('/decision-gate/decisions?state=success')).json()) as DecisionPage;
  expect(ignored.total).toBe(0);
  const wrongMethod = await f.call('/decision-gate/decisions', { method: 'POST', body: '{}' });
  expect(wrongMethod.status).toBe(405);
});

test('a read_all API key can read the list and no credential cannot', async () => {
  const f = await fixture();
  seedDecision(f.store, { telegramChatId: -1_001_234_567_890, conversationId: 960n });
  const anonymous = await f.call('/decision-gate/decisions', { headers: { cookie: '' } });
  expect(anonymous.status).toBe(401);
  expect(await anonymous.json()).toMatchObject({ error: 'unauthenticated' });
  const auth = await f.bearerKey('read');
  const response = await f.bearerCall('/decision-gate/decisions', {}, auth);
  expect(response.status).toBe(200);
  const page = (await response.json()) as DecisionPage;
  expect(page.total).toBe(1);
  // `read` may not write the gate itself.
  const denied = await f.bearerCall('/decision-gate', { method: 'PUT', body: '{}' }, auth);
  expect(denied.status).toBe(403);
});

test('config view projects the gate without its credential or address', async () => {
  const f = await fixture({
    transform: (config) => {
      config.telegram.decision_gate = {
        enabled: true,
        threshold: 0.4,
        model: 'typesafe/jev-1.14',
        base_url: 'https://openrouter.ai/api/alpha',
        api_key: { jar: 'agent' },
      };
      const group = config.telegram.chats.find((chat) => chat.id === -1_001_234_567_890);
      if (group !== undefined) {
        group.decision_gate = { mode: 'enforce', history_messages: 3 };
      }
    },
  });
  for (const source of ['active', 'file'] as const) {
    const response = await f.call(`/config/view?source=${source}`);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain('agent-secret');
    const body = JSON.parse(text) as {
      config: {
        telegram: {
          decision_gate?: Record<string, unknown>;
          chats: readonly { id: string; decision_gate?: Record<string, unknown> }[];
        };
      };
    };
    const gate = body.config.telegram.decision_gate;
    expect(gate).toEqual({ enabled: true, threshold: 0.4, model: 'typesafe/jev-1.14' });
    // The credential and the address stay out of this projection entirely.
    expect(Object.hasOwn(gate ?? {}, 'api_key')).toBe(false);
    expect(Object.hasOwn(gate ?? {}, 'base_url')).toBe(false);
    const group = body.config.telegram.chats.find((chat) => chat.id === '-1001234567890');
    expect(group?.decision_gate).toEqual({ mode: 'enforce', history_messages: 3 });
  }
});
