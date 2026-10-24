/**
 * `/api/telegram`: the connection view and the token write path. Every case
 * uses a real configuration file, key jar, reloader and AdminServer, so the
 * assertions cover what lands on disk, not just the response body.
 */
import { expect, test } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AdminServer } from '../src/ingress/admin/server.ts';
import {
  resolveTelegramTokenSource,
  type TelegramTokenSource,
} from '../src/adapters/local-monolith/telegram-connection-token.ts';
import type { SecretStore } from '../src/platform/secrets.ts';
import { ImConnectionRegistry } from '../src/platform/im-connection.ts';
import { readKeyJar } from '../src/platform/key-jar.ts';
import { PASSWORD, post, readJson, request, sessionCookie } from './admin-fixtures.ts';
import { logLines, setup } from './config-reload-fixtures.ts';

interface Panel {
  readonly fixture: Awaited<ReturnType<typeof setup>>;
  readonly server: AdminServer;
  readonly connections: ImConnectionRegistry;
  readonly published: TelegramTokenSource[];
  call(path: string, init?: RequestInit): Promise<Response>;
  configText(): Promise<string>;
  close(): Promise<void>;
}

async function panel(
  options: Parameters<typeof setup>[0] = {},
  connections = new ImConnectionRegistry(),
): Promise<Panel> {
  const published: TelegramTokenSource[] = [];
  let secrets: SecretStore | undefined;
  const fixture = await setup({
    ...options,
    telegramConfig: {
      prepare: async (candidate) => await resolveTelegramTokenSource(candidate, secrets as SecretStore),
      publish: (source) => published.push(source),
    },
  });
  secrets = fixture.secrets;
  const server = new AdminServer({
    store: fixture.store,
    configStore: fixture.configStore,
    configReloader: fixture.reloader,
    secrets: fixture.secrets,
    connections,
  });
  const setupResponse = await server.handle(post('/api/auth/setup', { username: 'owner', password: PASSWORD }));
  const cookie = sessionCookie(setupResponse);
  return {
    fixture,
    server,
    connections,
    published,
    call: (path, init = {}) =>
      server.handle(
        request(`/api${path}`, {
          ...init,
          headers: { cookie, origin: 'http://127.0.0.1:8899', ...(init.headers as Record<string, string>) },
        }),
      ),
    configText: () => readFile(fixture.configPath, 'utf8'),
    close: async () => {
      await server.stop();
      fixture.store.close();
    },
  };
}

function putToken(revision: string, token: unknown): RequestInit {
  return {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'if-match': revision },
    body: JSON.stringify({ token }),
  };
}

test('GET /telegram reports the connection, the token presence and the revision', async () => {
  const p = await panel();
  try {
    const before = await readJson(await p.call('/telegram'));
    expect(before).toMatchObject({
      revision: expect.stringMatching(/^[a-f0-9]{64}$/),
      status: { status: 'disabled' },
      telegram_section_present: true,
      token_configured: true,
    });

    p.connections.set('telegram', {
      status: 'network_error',
      since: '2026-10-25T00:00:00.000Z',
    });
    const network = await readJson(await p.call('/telegram'));
    expect(network.status).toEqual({ status: 'network_error', since: '2026-10-25T00:00:00.000Z' });

    p.connections.set('telegram', {
      status: 'connected',
      since: '2026-10-25T00:00:00.000Z',
      bot: { id: '42', username: 'surowan_bot' },
    });
    const connected = await readJson(await p.call('/telegram'));
    expect(connected.status).toMatchObject({
      status: 'connected',
      bot: { id: '42', username: 'surowan_bot' },
    });
  } finally {
    await p.close();
  }
});

test('PUT /telegram writes the token into the key jar and only a reference into the file', async () => {
  const p = await panel();
  try {
    const token = '123456789:AAH-super-secret-token-value';
    const before = await readJson(await p.call('/telegram'));
    const response = await p.call('/telegram', putToken(before.revision, token));
    expect(response.status).toBe(200);
    const body = await readJson(response);
    expect(body).toMatchObject({
      revision: expect.stringMatching(/^[a-f0-9]{64}$/),
      token_configured: true,
      telegram_section_present: true,
      apply: { applied: expect.arrayContaining(['telegram.token']), restart_required: [] },
    });
    expect(body.revision).not.toBe(before.revision);

    const text = await p.configText();
    expect(text).not.toContain(token);
    const jar = await readKeyJar(join(p.fixture.directory, 'key.json'));
    expect(jar).not.toBeNull();
    const entry = Object.entries(jar ?? {}).find(([, value]) => value === token);
    expect(entry).toBeDefined();
    // The previous reference is gone and the fresh one points at the new entry.
    expect(jar).not.toHaveProperty('telegram');
    expect(text).toContain(`"jar": "${entry?.[0]}"`);

    // The reloader published the resolved token; the manager would restart on it.
    expect(p.published.at(-1)).toEqual({ kind: 'token', token });
    expect(p.fixture.configStore.current().config.telegram.token).toEqual({ jar: entry?.[0] });

    // Neither the response nor any reload log names the plaintext.
    expect(JSON.stringify(body)).not.toContain(token);
    expect(logLines().join('\n')).not.toContain(token);
  } finally {
    await p.close();
  }
});

test('PUT /telegram refuses a stale revision and never echoes the token', async () => {
  const p = await panel();
  try {
    const current = await readJson(await p.call('/telegram'));
    const textBefore = await p.configText();
    const token = '987654321:stale-revision-secret';
    const stale = await p.call('/telegram', putToken('0'.repeat(64), token));
    expect(stale.status).toBe(409);
    const staleBody = await readJson(stale);
    expect(staleBody).toMatchObject({ error: 'config_conflict' });
    expect(JSON.stringify(staleBody)).not.toContain(token);
    expect(await p.configText()).toBe(textBefore);
    expect(logLines().join('\n')).not.toContain(token);

    const missing = await p.call('/telegram', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    expect(missing.status).toBe(400);
    expect(await readJson(missing)).toMatchObject({ error: 'revision_required' });

    const empty = await p.call('/telegram', putToken(current.revision, '   '));
    expect(empty.status).toBe(400);
    expect(await readJson(empty)).toMatchObject({ error: 'invalid_body' });

    const extra = await p.call('/telegram', {
      ...putToken(current.revision, token),
      body: JSON.stringify({ token, chats: [] }),
    });
    expect(extra.status).toBe(400);
    expect(await readJson(extra)).toMatchObject({ error: 'invalid_body' });
    expect(await p.configText()).toBe(textBefore);
  } finally {
    await p.close();
  }
});

test('PUT /telegram with null removes the token and garbage-collects its jar entry', async () => {
  const p = await panel();
  try {
    const before = await readJson(await p.call('/telegram'));
    const cleared = await p.call('/telegram', putToken(before.revision, null));
    expect(cleared.status).toBe(200);
    const body = await readJson(cleared);
    expect(body).toMatchObject({
      token_configured: false,
      apply: { applied: expect.arrayContaining(['telegram.token']) },
    });
    const text = await p.configText();
    expect(text).not.toContain('"token"');
    const jar = await readKeyJar(join(p.fixture.directory, 'key.json'));
    expect(jar).not.toHaveProperty('telegram');
    expect(p.published.at(-1)).toEqual({ kind: 'disabled' });
    expect(p.fixture.configStore.current().config.telegram.token).toBeUndefined();

    // Clearing an already-cleared token is an idempotent success.
    const again = await p.call('/telegram', putToken(body.revision, null));
    expect(again.status).toBe(200);
    expect(await readJson(again)).toMatchObject({ token_configured: false, apply: { applied: [] } });
    expect(await p.configText()).toBe(text);
  } finally {
    await p.close();
  }
});

test('PUT /telegram creates a missing telegram section from the documented defaults', async () => {
  const p = await panel({
    transform: (config) => {
      (config as unknown as Record<string, unknown>).telegram = undefined;
    },
  });
  try {
    const before = await readJson(await p.call('/telegram'));
    expect(before).toMatchObject({ telegram_section_present: false, token_configured: false });

    const token = '111111111:new-section-secret';
    const response = await p.call('/telegram', putToken(before.revision, token));
    expect(response.status).toBe(200);
    expect(await readJson(response)).toMatchObject({ telegram_section_present: true, token_configured: true });

    const file = JSON.parse(await p.configText()) as {
      telegram: {
        token: { jar: string };
        process_bot_messages: boolean;
        bucket_window_seconds: number;
        chats: unknown[];
      };
    };
    expect(file.telegram.process_bot_messages).toBe(false);
    expect(file.telegram.bucket_window_seconds).toBe(15);
    expect(file.telegram.chats).toEqual([]);
    expect(file.telegram.token.jar).toEqual(expect.any(String));
    const jar = await readKeyJar(join(p.fixture.directory, 'key.json'));
    expect(jar?.[file.telegram.token.jar]).toBe(token);
  } finally {
    await p.close();
  }
});

test('Chats, Admins and Harness writes still create a missing telegram section', async () => {
  const missingTelegram = (config: { telegram?: unknown }): void => {
    (config as unknown as Record<string, unknown>).telegram = undefined;
  };

  const chats = await panel({ transform: missingTelegram });
  try {
    const revision = (await readJson(await chats.call('/chats'))).revision as string;
    const response = await chats.call('/chats', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'if-match': revision },
      body: JSON.stringify({ id: '987654321', topic_ids: null, provider: null, model: null, thinking_level: null }),
    });
    expect(response.status).toBe(200);
    const file = JSON.parse(await chats.configText()) as {
      telegram: { chats: { id: number }[]; process_bot_messages: boolean; bucket_window_seconds: number };
    };
    expect(file.telegram.chats.map((chat) => chat.id)).toEqual([987654321]);
    expect(file.telegram.process_bot_messages).toBe(false);
    expect(file.telegram.bucket_window_seconds).toBe(15);
  } finally {
    await chats.close();
  }

  const admins = await panel({ transform: missingTelegram });
  try {
    const revision = (await readJson(await admins.call('/admins'))).revision as string;
    const response = await admins.call('/admins', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'if-match': revision },
      body: JSON.stringify({ telegram_user_id: 777 }),
    });
    expect(response.status).toBe(200);
    const file = JSON.parse(await admins.configText()) as {
      telegram: { admins: number[]; process_bot_messages: boolean };
    };
    expect(file.telegram.admins).toEqual([777]);
    expect(file.telegram.process_bot_messages).toBe(false);
  } finally {
    await admins.close();
  }

  const harness = await panel({ transform: missingTelegram });
  try {
    const revision = (await readJson(await harness.call('/harness'))).revision as string;
    const response = await harness.call('/harness', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'if-match': revision },
      body: JSON.stringify({ values: { 'proactive_reply.enabled': true } }),
    });
    expect(response.status).toBe(200);
    const file = JSON.parse(await harness.configText()) as {
      telegram: { proactive_reply: { enabled: boolean }; process_bot_messages: boolean };
    };
    expect(file.telegram.proactive_reply.enabled).toBe(true);
    expect(file.telegram.process_bot_messages).toBe(false);
  } finally {
    await harness.close();
  }
});
