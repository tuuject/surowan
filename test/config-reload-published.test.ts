import { expect, test } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { AdminServer } from '../src/ingress/admin/server.ts';
import { SecretStore } from '../src/platform/secrets.ts';
import {
  CHAT_ID,
  ADMIN,
  AGENT_MODEL,
  SECOND_MODEL,
  logEvents,
  textUpdate,
  customProvider,
  builtinProvider,
  model,
  CountingSecrets,
  fauxAgent,
  setup,
  transcript,
  runDirect,
} from './config-reload-fixtures.ts';

test('a connection change re-resolves exactly one provider secret', async () => {
  const fixture = await setup({ secrets: (keyJar) => new CountingSecrets(keyJar) });
  const secrets = fixture.secrets as CountingSecrets;
  try {
    const resolvedAtStartup = secrets.resolutions;
    expect(resolvedAtStartup).toBeGreaterThan(0);
    await fixture.patch((config) => {
      // One provider changes its connection, another only its model list.
      customProvider(config.providers, 'agent').api_key = { jar: 'agent-rotated' };
      builtinProvider(config.providers, 'faux').models.push(model('deepseek-reasoner'));
    });
    const result = await fixture.reloader.reloadFromFile();
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.message);
    }
    expect(secrets.resolutions).toBe(resolvedAtStartup + 1);
  } finally {
    fixture.store.close();
  }
});

test('a reload that cannot resolve a new secret leaves the running configuration alone', async () => {
  const fixture = await setup();
  try {
    const before = fixture.configStore.current();
    await fixture.patch((config) => {
      // Two providers change their connection in one edit; the second one's
      // SecretRef cannot be resolved, so nothing may be published.
      customProvider(config.providers, 'agent').api_key = { jar: 'agent-rotated' };
      customProvider(config.providers, 'vision').api_key = { env: 'SUROWAN_TEST_MISSING_SECRET' };
    });
    const result = await fixture.reloader.reloadFromFile();
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('Expected the reload to fail');
    }
    expect(result.code).toBe('secret_unresolved');
    expect(result.message).toContain('SUROWAN_TEST_MISSING_SECRET');
    expect(fixture.reloader.status().lastError).toMatchObject({ code: 'secret_unresolved' });
    // Neither the generation nor the registry moved: the whole candidate is
    // refused, not half applied.
    expect(fixture.configStore.current()).toBe(before);
    expect(fixture.configStore.current().config.providers.agent).toMatchObject({ api_key: { jar: 'agent' } });
  } finally {
    fixture.store.close();
  }
});

test('a run keeps the registry it started with when a reload publishes a new one', async () => {
  const fixture = await setup({
    transform: (config) => {
      config.agent!.send_nudge_enabled = true;
    },
  });
  try {
    const faux = fauxAgent();
    const seen: { readonly id: string; readonly contextWindow: number }[] = [];
    faux.setResponses([
      async (_context, _options, _state, requestModel) => {
        seen.push(requestModel);
        // The reload lands between this turn and the next one, exactly where a
        // panel save can land while a long-lived invocation is still running.
        await fixture.patch((config) => {
          builtinProvider(config.providers, 'faux').models.push(model('deepseek-reasoner'));
        });
        const reloaded = await fixture.reloader.reloadFromFile();
        expect(reloaded.ok).toBe(true);
        return fauxAssistantMessage('a private draft');
      },
      (_context, _options, _state, requestModel) => {
        seen.push(requestModel);
        return fauxAssistantMessage('');
      },
    ]);
    const runtime = fixture.runtimeWith(faux);
    const before = fixture.configStore.beginInvocation();
    fixture.ingestion.ingest(textUpdate(1, 10, 'hello'), new Date());
    const [invocationId] = fixture.scheduler.processDue(new Date(Date.now() + 60_000));
    if (invocationId === undefined) {
      throw new Error('Expected a queued invocation');
    }
    const outcome = await runDirect(fixture, runtime, invocationId);
    expect(outcome).toEqual({ state: 'completed', reason: 'completed' });
    expect(seen).toHaveLength(2);
    // The second turn resolved its model from the snapshot the run started with,
    // even though the reload published a registry carrying a freshly built one.
    expect(seen[1]).toBe(seen[0]);
    expect(fixture.configStore.current().models).not.toBe(before.models);
    expect(before.models.getModel('faux', 'deepseek-reasoner')).toBeUndefined();
    expect(fixture.configStore.current().models.getModel('faux', 'deepseek-reasoner')).toBeDefined();
    expect(before.models.getModel('faux', AGENT_MODEL)?.id).toBe(AGENT_MODEL);
  } finally {
    fixture.store.close();
  }
});

test('telegram.admins hot-applies and gates bot commands without a restart', async () => {
  const fixture = await setup();
  try {
    fixture.ingestion.ingest(textUpdate(1, 10, 'hello'), new Date());
    const stranger = { id: 7n, name: 'Stranger', username: null };
    expect(await fixture.commands.run({ name: 'pause' }, BigInt(CHAT_ID), stranger, new Date())).toBe(
      '该命令仅对本 Bot 的管理员可用。',
    );

    await fixture.patch((config) => {
      config.telegram.admins = [7];
    });
    const reloaded = await fixture.reloader.reloadFromFile();
    expect(reloaded.ok).toBe(true);

    expect(await fixture.commands.run({ name: 'pause' }, BigInt(CHAT_ID), stranger, new Date())).toContain('已暂停');
  } finally {
    fixture.store.close();
  }
});

test('a prompt change rebuilds the Conversation Context on the next run', async () => {
  const fixture = await setup();
  try {
    const faux = fauxAgent();
    faux.setResponses([() => fauxAssistantMessage('first answer')]);
    const runtime = fixture.runtimeWith(faux);
    fixture.ingestion.ingest(textUpdate(1, 10, 'first'), new Date());
    const [first] = fixture.scheduler.processDue(new Date(Date.now() + 60_000));
    if (first === undefined) {
      throw new Error('Expected a queued invocation');
    }
    await runDirect(fixture, runtime, first);
    expect(transcript(fixture.store)).toContain('first answer');

    await writeFile(join(fixture.directory, 'agent-system-prompt.md'), 'A completely different system prompt.');
    const reloaded = await fixture.reloader.reloadFromFile();
    expect(reloaded.ok).toBe(true);
    if (!reloaded.ok) {
      throw new Error(reloaded.message);
    }
    expect(reloaded.applied).toEqual(['agent.system_prompt_file']);

    faux.setResponses([() => fauxAssistantMessage('second answer')]);
    fixture.ingestion.ingest(textUpdate(2, 11, 'second'), new Date(Date.now() + 120_000));
    const [second] = fixture.scheduler.processDue(new Date(Date.now() + 180_000));
    if (second === undefined) {
      throw new Error('Expected a second queued invocation');
    }
    await runDirect(fixture, runtime, second);
    const rows = transcript(fixture.store);
    expect(rows).not.toContain('first answer');
    expect(rows).toContain('second answer');
    expect(logEvents('context_rebuilt').length).toBeGreaterThan(0);
  } finally {
    fixture.store.close();
  }
});

test('a budget lowered during a run blocks the next model call', async () => {
  const fixture = await setup();
  try {
    const faux = fauxAgent();
    faux.setResponses([
      async () => {
        await fixture.patch((config) => {
          config.agent!.daily_budget!.max_tokens = 100_000;
        });
        const reloaded = await fixture.reloader.reloadFromFile();
        expect(reloaded.ok).toBe(true);
        return fauxAssistantMessage(fauxToolCall('send', { kind: 'text', text: 'hello' }), { stopReason: 'toolUse' });
      },
      () => fauxAssistantMessage('done'),
    ]);
    const runtime = fixture.runtimeWith(faux);
    fixture.ingestion.ingest(textUpdate(1, 10, 'hello'), new Date());
    const [invocationId] = fixture.scheduler.processDue(new Date(Date.now() + 60_000));
    if (invocationId === undefined) {
      throw new Error('Expected a queued invocation');
    }
    // Another chat already spent 200k tokens of the shared daily budget.
    const now = new Date().toISOString();
    fixture.store.db
      .prepare(
        "INSERT INTO daily_usage(utc_date, scope, resource, metric, amount, updated_at) VALUES (?, 'chat', ?, 'model_tokens', ?, ?)",
      )
      .run(now.slice(0, 10), '987654321', 200_000, now);
    const outcome = await runDirect(fixture, runtime, invocationId);
    // The turn boundary notices the exhausted budget before the next model call
    // is even attempted: the run ends, and no second call reaches the provider.
    expect(outcome).toEqual({ state: 'completed', reason: 'budget' });
    expect(
      fixture.store.db
        .prepare<[bigint], { count: bigint }>('SELECT COUNT(*) AS count FROM model_calls WHERE invocation_id = ?')
        .get(invocationId)?.count,
    ).toBe(1n);
  } finally {
    fixture.store.close();
  }
});

test('a reloaded model and thinking level show up in /status and the admin API', async () => {
  const fixture = await setup({
    transform: (config) => {
      config.admin = { enabled: true, host: '127.0.0.1', port: 8899, session_ttl_hours: 12 };
    },
  });
  try {
    fixture.runtimeWith(fauxAgent());
    await fixture.patch((config) => {
      config.agent!.model = SECOND_MODEL;
      config.agent!.thinking_level = 'high';
    });
    const reloaded = await fixture.reloader.reloadFromFile();
    expect(reloaded.ok).toBe(true);

    const status = await fixture.commands.run({ name: 'status' }, BigInt(CHAT_ID), ADMIN);
    expect(status).toContain(`本群模型: faux / ${SECOND_MODEL}（继承全局）`);
    expect(status).toContain('思考强度: high（继承全局）');

    const server = new AdminServer({
      store: fixture.store,
      configStore: fixture.configStore,
      modelSwitcher: fixture.modelSwitcher,
      configReloader: fixture.reloader,
      secrets: new SecretStore(),
    });
    const created = await server.handle(
      new Request('http://127.0.0.1:8899/api/auth/setup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'owner', password: 'correct-horse-battery' }),
      }),
    );
    const cookie = created.headers.get('set-cookie')?.split(';')[0] ?? '';
    const view = (await (
      await server.handle(new Request('http://127.0.0.1:8899/api/providers', { headers: { cookie } }))
    ).json()) as { agent: { provider: string; model: string } };
    expect(view.agent).toMatchObject({ provider: 'faux', model: SECOND_MODEL });
  } finally {
    fixture.store.close();
  }
});
