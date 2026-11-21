import { expect, test } from 'vitest';
import { fixture, GROUP, PRIVATE } from './decision-gate-fixtures.ts';

/**
 * `PUT /chats/:id/decision-gate`: the per-Chat override, which carries the six
 * behavior fields and inherits the rest from the global section field by field.
 */

interface ChatWriteBody {
  readonly revision: string;
  readonly items: readonly {
    readonly id: string;
    readonly saved: { readonly decision_gate: Record<string, unknown> | null } | null;
    readonly active: { readonly decision_gate: Record<string, unknown> | null } | null;
  }[];
  readonly apply: { readonly applied: readonly string[]; readonly restart_required: readonly string[] };
}

async function view(f: Awaited<ReturnType<typeof fixture>>): Promise<ChatWriteBody> {
  const response = await f.call('/chats');
  expect(response.status).toBe(200);
  return (await response.json()) as ChatWriteBody;
}

function chat(body: ChatWriteBody, id: number) {
  const found = body.items.find((item) => item.id === String(id));
  if (found === undefined) {
    throw new Error(`Chat ${id} missing from the view`);
  }
  return found;
}

test('the Chat view carries the override and a patch keeps every field it does not name', async () => {
  const f = await fixture({
    transform: (config) => {
      config.telegram.decision_gate = { api_key: { jar: 'agent' } };
      const group = config.telegram.chats.find((chat) => chat.id === GROUP);
      if (group !== undefined) {
        group.decision_gate = { enabled: true, threshold: 0.4, history_messages: 2 };
      }
    },
  });
  const initial = await view(f);
  expect(chat(initial, GROUP).saved?.decision_gate).toEqual({
    enabled: true,
    threshold: 0.4,
    history_messages: 2,
  });

  const response = await f.write(`/chats/${GROUP}/decision-gate`, 'PUT', { pending_messages: 4 }, initial.revision);
  expect(response.status).toBe(200);
  const body = (await response.json()) as ChatWriteBody;
  expect(body.apply.restart_required).toEqual([]);
  expect(body.apply.applied.filter((path) => path.endsWith('decision_gate.pending_messages'))).toHaveLength(1);
  expect(chat(body, GROUP).saved?.decision_gate).toEqual({
    enabled: true,
    threshold: 0.4,
    history_messages: 2,
    pending_messages: 4,
  });
  expect(chat(body, GROUP).active?.decision_gate).toEqual(chat(body, GROUP).saved?.decision_gate);
  // The running configuration carries it too.
  const activeChat = f.configStore.current().config.telegram.chats.find((entry) => entry.id === GROUP);
  expect(activeChat?.decision_gate).toMatchObject({ enabled: true, pending_messages: 4 });

  // Removing the last field removes the whole object instead of leaving `{}`.
  const removed = await f.write(
    `/chats/${GROUP}/decision-gate`,
    'PUT',
    { enabled: null, threshold: null, history_messages: null, pending_messages: null },
    body.revision,
  );
  expect(removed.status).toBe(200);
  const cleared = (await removed.json()) as ChatWriteBody;
  expect(chat(cleared, GROUP).saved?.decision_gate).toBeNull();
  const file = await f.file();
  const group = file.telegram?.chats.find((entry) => entry.id === GROUP);
  expect(group === undefined ? 'missing' : Object.hasOwn(group, 'decision_gate')).toBe(false);
});

test('only the six behavior fields are accepted; the connection fields stay global', async () => {
  const f = await fixture();
  const bytes = await f.raw();
  const revision = (await view(f)).revision;
  for (const body of [
    { model: 'typesafe/jev-1.14' },
    { base_url: 'https://elsewhere.example.test/api' },
    { api_key: 'nope' },
    { timeout_ms: 1_000 },
    { threshold: 0.5, api_key: null },
  ]) {
    const response = await f.write(`/chats/${GROUP}/decision-gate`, 'PUT', body, revision);
    expect(response.status, JSON.stringify(body)).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid_body' });
    expect(await f.raw()).toBe(bytes);
  }
  // Every value is validated against the configuration schema.
  for (const body of [{ threshold: 2 }, { mode: 'loud' }, { history_messages: 51 }, { pending_messages: 0 }, {}]) {
    const response = await f.write(`/chats/${GROUP}/decision-gate`, 'PUT', body, revision);
    expect(response.status, JSON.stringify(body)).toBe(400);
  }
});

test('a private Chat is refused and an unknown Chat is not found', async () => {
  const f = await fixture();
  const bytes = await f.raw();
  const revision = (await view(f)).revision;
  const privateChat = await f.write(`/chats/${PRIVATE}/decision-gate`, 'PUT', { enabled: false }, revision);
  expect(privateChat.status).toBe(400);
  expect(await privateChat.json()).toMatchObject({ error: 'invalid_body' });
  const unknown = await f.write('/chats/-100999/decision-gate', 'PUT', { enabled: false }, revision);
  expect(unknown.status).toBe(404);
  expect(await unknown.json()).toMatchObject({ error: 'chat_not_found' });
  const stale = await f.write(`/chats/${GROUP}/decision-gate`, 'PUT', { enabled: false }, `${revision}-stale`);
  expect(stale.status).toBe(409);
  expect(await stale.json()).toMatchObject({ error: 'config_conflict' });
  expect(await f.raw()).toBe(bytes);
});

test('a Chat cannot enable the gate without the global credential, and a foreign Origin is refused', async () => {
  const f = await fixture();
  const bytes = await f.raw();
  const revision = (await view(f)).revision;
  const enabling = await f.write(`/chats/${GROUP}/decision-gate`, 'PUT', { enabled: true }, revision);
  expect(enabling.status).toBe(400);
  expect(await enabling.json()).toMatchObject({ error: 'decision_gate_invalid' });
  expect(await f.raw()).toBe(bytes);

  // Enabling is fine once the global section names a credential.
  const withKey = await f.write('/decision-gate', 'PUT', { api_key: { entry: 'agent' } }, revision);
  expect(withKey.status).toBe(200);
  const nextRevision = ((await withKey.json()) as { revision: string }).revision;
  const foreign = await f.call(`/chats/${GROUP}/decision-gate`, {
    method: 'PUT',
    headers: { 'if-match': nextRevision, 'content-type': 'application/json', origin: 'http://evil.test' },
    body: JSON.stringify({ enabled: true }),
  });
  expect(foreign.status).toBe(403);
  expect(await foreign.json()).toMatchObject({ error: 'bad_origin' });
  const accepted = await f.write(`/chats/${GROUP}/decision-gate`, 'PUT', { enabled: true }, nextRevision);
  expect(accepted.status).toBe(200);
  const file = await f.file();
  expect(file.telegram?.chats.find((entry) => entry.id === GROUP)?.decision_gate).toEqual({ enabled: true });
});
