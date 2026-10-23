import { expect, test } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getCurrentSystemPrompt, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { BucketScheduler } from '../src/orchestration/scheduler.ts';
import { sleep, startFixtureServer, stopFixtureServer } from './helpers.ts';
import {
  AGENT_MODEL,
  SECOND_MODEL,
  textUpdate,
  until,
  customProvider,
  model,
  fauxAgent,
  type Fixture,
  setup,
  runDirect,
} from './config-reload-fixtures.ts';

test('a reload during a run does not reach that run', async () => {
  const fixture = await setup({
    transform: (config) => {
      config.agent!.send_max_text_length = 10;
    },
  });
  try {
    const faux = fauxAgent();
    const prompts: string[] = [];
    faux.setResponses([
      async (context) => {
        prompts.push(getCurrentSystemPrompt(context.messages));
        await writeFile(join(fixture.directory, 'agent-system-prompt.md'), 'A prompt for later runs.');
        await fixture.patch((config) => {
          config.agent!.send_max_text_length = 1_000;
        });
        const reloaded = await fixture.reloader.reloadFromFile();
        expect(reloaded.ok).toBe(true);
        return fauxAssistantMessage(fauxToolCall('send', { kind: 'text', text: 'x'.repeat(20) }), {
          stopReason: 'toolUse',
        });
      },
      (context) => {
        prompts.push(getCurrentSystemPrompt(context.messages));
        return fauxAssistantMessage('done');
      },
    ]);
    const runtime = fixture.runtimeWith(faux);
    fixture.ingestion.ingest(textUpdate(1, 10, 'hello'), new Date());
    const [invocationId] = fixture.scheduler.processDue(new Date(Date.now() + 60_000));
    if (invocationId === undefined) {
      throw new Error('Expected a queued invocation');
    }
    const outcome = await runDirect(fixture, runtime, invocationId);
    expect(outcome).toEqual({ state: 'completed', reason: 'completed' });
    expect(prompts).toHaveLength(2);
    // The published prompt never reaches the run that is already in flight.
    expect(prompts[1]).toBe(prompts[0]);
    expect(prompts[1]).toContain('Participate safely.');
    expect(prompts[1]).not.toContain('A prompt for later runs.');
    // The send limit comes from the snapshot too.
    expect(
      fixture.store.db
        .prepare<[bigint], { error_code: string | null }>(
          "SELECT error_code FROM tool_calls WHERE invocation_id = ? AND tool_name = 'send'",
        )
        .all(invocationId)
        .map((row) => row.error_code),
    ).toEqual(['send_text_too_long']);
    expect(
      fixture.store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM host_sends').get()?.count,
    ).toBe(0n);
    // The reload did happen: the next run gets the new prompt and limit.
    expect(fixture.configStore.current().config.agent!.send_max_text_length).toBe(1_000);
    expect(fixture.configStore.current().config.agent!.system_prompt).toBe('A prompt for later runs.');
  } finally {
    fixture.store.close();
  }
});

test('the next invocation uses the reloaded configuration', async () => {
  const fixture = await setup();
  try {
    const faux = fauxAgent();
    const levels: (string | undefined)[] = [];
    faux.setResponses([
      (_context, options) => {
        levels.push(options?.reasoning);
        return fauxAssistantMessage('first answer');
      },
    ]);
    const runtime = fixture.runtimeWith(faux);
    fixture.ingestion.ingest(textUpdate(1, 10, 'first'), new Date());
    const [first] = fixture.scheduler.processDue(new Date(Date.now() + 60_000));
    if (first === undefined) {
      throw new Error('Expected a queued invocation');
    }
    await runDirect(fixture, runtime, first);
    expect(levels).toEqual(['low']);
    await fixture.patch((config) => {
      config.agent!.thinking_level = 'high';
    });
    const reloaded = await fixture.reloader.reloadFromFile();
    expect(reloaded.ok).toBe(true);

    faux.setResponses([
      (_context, options) => {
        levels.push(options?.reasoning);
        return fauxAssistantMessage('second answer');
      },
    ]);
    fixture.ingestion.ingest(textUpdate(2, 11, 'second'), new Date(Date.now() + 120_000));
    const [second] = fixture.scheduler.processDue(new Date(Date.now() + 180_000));
    if (second === undefined) {
      throw new Error('Expected a second queued invocation');
    }
    await runDirect(fixture, runtime, second);
    expect(levels).toEqual(['low', 'high']);
  } finally {
    fixture.store.close();
  }
});

test('a bucket attached to a long-lived invocation keeps its snapshot', async () => {
  const fixture = await setup({
    transform: (config) => {
      config.telegram.bucket_window_seconds = 1;
      config.agent!.context!.idle_grace_seconds = 3;
      config.agent!.context!.max_wall_clock_seconds = 60;
    },
  });
  const faux = fauxAgent();
  const prompts: string[] = [];
  const levels: (string | undefined)[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  faux.setResponses([
    async (context, options) => {
      prompts.push(getCurrentSystemPrompt(context.messages));
      levels.push(options?.reasoning);
      await gate;
      return fauxAssistantMessage('first answer');
    },
    (context, options) => {
      prompts.push(getCurrentSystemPrompt(context.messages));
      levels.push(options?.reasoning);
      return fauxAssistantMessage('');
    },
  ]);
  const runtime = fixture.runtimeWith(faux);
  const scheduler = new BucketScheduler(
    fixture.store,
    fixture.configStore,
    (invocationId, snapshot, signal) => runtime.run(invocationId, snapshot, signal),
    fixture.conversationRuntime,
  );
  try {
    scheduler.start();
    fixture.ingestion.ingest(textUpdate(1, 10, 'first'), new Date());
    scheduler.wake();
    await until(() => prompts.length === 1, 'the first model call');

    // A second message collects its own window and attaches to the running run.
    fixture.ingestion.ingest(textUpdate(2, 11, 'second'), new Date());
    scheduler.wake();
    await sleep(1_200);
    await writeFile(join(fixture.directory, 'agent-system-prompt.md'), 'A prompt for later runs.');
    await fixture.patch((config) => {
      Object.assign(config.telegram.chats[0] ?? {}, { provider: 'faux', model: SECOND_MODEL, thinking_level: 'high' });
    });
    const reloaded = await fixture.reloader.reloadFromFile();
    expect(reloaded.ok).toBe(true);
    release();

    await until(() => prompts.length === 2, 'the attached batch');
    expect(prompts[1]).toBe(prompts[0]);
    expect(prompts[1]).not.toContain('A prompt for later runs.');
    expect(
      fixture.store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM invocation_buckets').get()?.count,
    ).toBe(2n);
    expect(fixture.configStore.current().config.agent!.system_prompt).toBe('A prompt for later runs.');
    expect(fixture.configStore.current().config.telegram.chats[0]?.model).toBe(SECOND_MODEL);
    expect(levels).toEqual(['low', 'low']);
    await until(
      () =>
        fixture.store.db
          .prepare<[], { count: bigint }>("SELECT COUNT(*) AS count FROM model_calls WHERE state = 'success'")
          .get()?.count === 2n,
      'both model audits',
    );
    expect(
      fixture.store.db
        .prepare<[], { model: string; state: string }>('SELECT model, state FROM model_calls ORDER BY id')
        .all(),
    ).toEqual([
      { model: AGENT_MODEL, state: 'success' },
      { model: AGENT_MODEL, state: 'success' },
    ]);
  } finally {
    release();
    await scheduler.stop();
    fixture.store.close();
  }
}, 30_000);

/**
 * A loopback endpoint speaking the minimum of the OpenAI chat-completions
 * streaming protocol Pi's adapter needs, recording what each request carried.
 */
interface CompletionServer {
  readonly baseUrl: string;
  readonly requests: { readonly authorization: string | null; readonly path: string }[];
  stop(): Promise<void>;
}

async function startCompletionServer(onRequest?: (index: number) => Promise<void>): Promise<CompletionServer> {
  const requests: { authorization: string | null; path: string }[] = [];
  const { server, port } = await startFixtureServer(async (request) => {
    requests.push({ authorization: request.headers.get('authorization'), path: new URL(request.url).pathname });
    await request.text();
    await onRequest?.(requests.length - 1);
    return new Response(completionStream('answered'), { headers: { 'content-type': 'text/event-stream' } });
  });
  return { baseUrl: `http://127.0.0.1:${port}/v1`, requests, stop: () => stopFixtureServer(server) };
}

function completionStream(text: string): string {
  const chunk = (delta: unknown, finishReason: string | null): string =>
    `data: ${JSON.stringify({
      id: 'chatcmpl-fixture',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'agent-model',
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    })}\n\n`;
  return `${chunk({ role: 'assistant', content: text }, null)}${chunk({}, 'stop')}data: [DONE]\n\n`;
}

test('a running invocation keeps the connection it started with', async () => {
  const second = await startCompletionServer();
  let fixture: Fixture | undefined;
  let reloaded = 'not attempted';
  const running = await startCompletionServer(async (index) => {
    if (index !== 0) {
      return;
    }
    // The connection changes between the two turns of one invocation, exactly
    // where a panel save lands while a long-lived run is still going.
    const active = fixture;
    if (active === undefined) {
      throw new Error('Expected the fixture to be built');
    }
    await active.patch((config) => {
      customProvider(config.providers, 'agent').base_url = `${second.baseUrl}/`;
      customProvider(config.providers, 'agent').api_key = { jar: 'key-b' };
    });
    const result = await active.reloader.reloadFromFile();
    reloaded = result.ok ? 'ok' : `${result.code}: ${result.message}`;
  });
  const active = await setup({
    transform: (config) => {
      config.agent!.send_nudge_enabled = true;
      config.providers.agent = {
        kind: 'custom',
        base_url: `${running.baseUrl}/`,
        api: 'openai-completions',
        api_key: { jar: 'key-a' },
        models: [
          model('agent-model', {
            reasoning: false,
            input: ['text', 'image'],
            context_window: 200_000,
            max_tokens: 32_768,
          }),
        ],
      };
      config.agent!.provider = 'agent';
      config.agent!.model = 'agent-model';
      config.agent!.thinking_level = 'off';
    },
  });
  fixture = active;
  try {
    // The runtime streams through the configured endpoint; the faux only stands
    // in for the unrelated `faux` alias the fixture's base configuration keeps.
    const runtime = active.runtimeWith(fauxAgent());
    active.ingestion.ingest(textUpdate(1, 10, 'hello'), new Date());
    const [invocationId] = active.scheduler.processDue(new Date(Date.now() + 60_000));
    if (invocationId === undefined) {
      throw new Error('Expected a queued invocation');
    }
    const outcome = await runDirect(active, runtime, invocationId);
    expect(outcome).toEqual({ state: 'completed', reason: 'completed' });
    expect(reloaded).toBe('ok');
    // Both turns of the run went to the connection it started with, under the
    // key the process had resolved for it.
    expect(running.requests.map((request) => request.authorization)).toEqual(['Bearer key-a', 'Bearer key-a']);
    expect(second.requests).toEqual([]);

    // The invocation that starts after the publication uses the new connection.
    active.ingestion.ingest(textUpdate(2, 11, 'again'), new Date(Date.now() + 120_000));
    const [next] = active.scheduler.processDue(new Date(Date.now() + 180_000));
    if (next === undefined) {
      throw new Error('Expected a second queued invocation');
    }
    await runDirect(active, runtime, next);
    expect(second.requests.length).toBeGreaterThan(0);
    expect(second.requests.every((request) => request.authorization === 'Bearer key-b')).toBe(true);
    expect(running.requests).toHaveLength(2);
  } finally {
    await running.stop();
    await second.stop();
    active.store.close();
  }
});
