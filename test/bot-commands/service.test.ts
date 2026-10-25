import { afterAll, describe, expect, test } from 'vitest';
import { BotCommandService } from '../../src/orchestration/bot-commands/index.ts';
import { AgentModelSwitcher } from '../../src/platform/models/switch.ts';
import { ConversationContextStore } from '../../src/context/store.ts';
import { ALICE, FIXED_NOW, cleanupDirectories, setup, textUpdate } from './fixtures.ts';

afterAll(cleanupDirectories);

describe('bot command service', () => {
  test('self-ignore controls reject unknown identity and report an unavailable reloader', async () => {
    const { store, commands } = await setup();
    try {
      for (const name of ['ignoreme', 'unignoreme'] as const) {
        expect(await commands.run({ name }, 123456789n, null)).toContain('无法识别发送者');
        expect(await commands.run({ name }, 123456789n, ALICE)).toBe('运行时配置应用不可用。');
      }
    } finally {
      store.close();
    }
  });

  test('pause expires pending buckets, aborts queued invocations and blocks new buckets', async () => {
    const { store, ingestion, scheduler, commands } = await setup();
    const start = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(textUpdate(1, 10, 'hello'), start);
    const [invocationId] = scheduler.processDue(new Date(start.getTime() + 15_000));
    if (invocationId === undefined) {
      throw new Error('Expected queued invocation');
    }
    expect(store.db.prepare<[], { state: string }>('SELECT state FROM invocations').get()?.state).toBe('queued');

    const reply = await commands.run({ name: 'pause' }, 123456789n, ALICE, FIXED_NOW);
    expect(reply).toContain('/resume');
    expect(store.db.prepare<[], { paused_at: string }>('SELECT paused_at FROM chat_pause').get()?.paused_at).toBe(
      FIXED_NOW.toISOString(),
    );
    expect(store.db.prepare<[], { state: string }>('SELECT state FROM buckets').get()?.state).toBe('expired');
    const invocation = store.db
      .prepare<[], { state: string; completion_reason: string }>('SELECT state, completion_reason FROM invocations')
      .get();
    expect(invocation?.state).toBe('aborted');
    expect(invocation?.completion_reason).toBe('chat_paused');

    ingestion.ingest(textUpdate(2, 11, 'while paused'), new Date(start.getTime() + 20_000));
    expect(store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM buckets').get()?.count).toBe(1n);
    expect(store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM messages').get()?.count).toBe(2n);
    expect(scheduler.processDue(new Date(start.getTime() + 60_000))).toHaveLength(0);
    store.close();
  });

  test('resume removes the pause and restores interaction', async () => {
    const { store, ingestion, scheduler, commands } = await setup();
    const start = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(textUpdate(1, 10, 'hello'), start);
    scheduler.processDue(new Date(start.getTime() + 15_000));
    await commands.run({ name: 'pause' }, 123456789n, ALICE, FIXED_NOW);
    await commands.run({ name: 'resume' }, 123456789n, ALICE, FIXED_NOW);
    expect(store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM chat_pause').get()?.count).toBe(0n);
    ingestion.ingest(textUpdate(2, 11, 'after resume'), new Date(start.getTime() + 30_000));
    expect(scheduler.processDue(new Date(start.getTime() + 45_000))).toHaveLength(1);
    store.close();
  });

  test("status reports model, thinking effort and today's split token usage", async () => {
    const { store, ingestion, scheduler, commands } = await setup();
    ingestion.ingest(textUpdate(1, 10, 'hello'), FIXED_NOW);
    store.db
      .prepare(
        "INSERT INTO daily_usage(utc_date, scope, resource, metric, amount, updated_at) VALUES (?, 'chat', ?, 'model_tokens', 1234, ?)",
      )
      .run(FIXED_NOW.toISOString().slice(0, 10), '123456789', FIXED_NOW.toISOString());
    store.db
      .prepare(
        "INSERT INTO daily_usage(utc_date, scope, resource, metric, amount, updated_at) VALUES (?, 'chat', ?, 'model_tokens', 66, ?)",
      )
      .run(FIXED_NOW.toISOString().slice(0, 10), '987654321', FIXED_NOW.toISOString());
    const [invocationId] = scheduler.processDue(new Date(FIXED_NOW.getTime() + 15_000));
    if (invocationId === undefined) {
      throw new Error('Expected queued invocation');
    }
    store.db
      .prepare(
        "INSERT INTO model_calls(invocation_id, role, provider, model, attempt, state, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens, created_at, finished_at) VALUES (?, 'agent', 'agent', 'agent-model', 1, 'success', 500, 200, 400, 134, 1234, ?, ?)",
      )
      .run(invocationId, FIXED_NOW.toISOString(), FIXED_NOW.toISOString());
    const status = await commands.run({ name: 'status' }, 123456789n, ALICE, FIXED_NOW);
    expect(status).toContain('本群模型: agent / agent-model（继承全局）');
    expect(status).toContain('思考强度: low（继承全局）');
    expect(status).toContain(
      '本群今日 token 用量: 1,234\n全局今日 token 用量: 1,300 / 300,000 (0.43%)\n读取: 500\n写入: 200\n缓存读取: 400\n缓存写入: 134',
    );
    expect(status).not.toContain('已暂停');
    await commands.run({ name: 'pause' }, 123456789n, ALICE, FIXED_NOW);
    expect(await commands.run({ name: 'status' }, 123456789n, ALICE, FIXED_NOW)).toContain('已暂停');
    store.close();
  });

  test('status reports the retained Conversation Context', async () => {
    const { store, ingestion, scheduler, commands } = await setup();
    ingestion.ingest(textUpdate(1, 10, 'hello'), FIXED_NOW);
    const [invocationId] = scheduler.processDue(new Date(FIXED_NOW.getTime() + 15_000));
    if (invocationId === undefined) {
      throw new Error('Expected queued invocation');
    }
    const conversationId = store.db
      .prepare<[bigint], { conversation_id: bigint }>('SELECT conversation_id FROM invocations WHERE id = ?')
      .get(invocationId)?.conversation_id;
    if (conversationId === undefined) {
      throw new Error('Expected a conversation');
    }
    const contexts = new ConversationContextStore(store);
    const { header } = contexts.open(conversationId, 'hash-a');
    contexts.append(header, {
      invocationId,
      isCheckpoint: true,
      estTokens: 10,
      json: JSON.stringify({ role: 'user', content: 'hello', timestamp: 1 }),
      role: 'user',
    });

    const status = await commands.run({ name: 'status' }, 123456789n, ALICE, FIXED_NOW);
    expect(status).toContain(`Context 消息 1，保留 send 0，head_seq ${header.headSeq}`);
    expect(status).toContain('未 GC');
    store.close();
  });

  test('status reflects a published agent model with per-chat display', async () => {
    const { store, loaded, scheduler, configStore } = await setup();
    const switcher = new AgentModelSwitcher(configStore);
    const commands = new BotCommandService(store, configStore, scheduler, switcher);
    configStore.publish({
      config: { ...loaded.config, agent: { ...loaded.config.agent, provider: 'vision', model: 'vision-model' } },
      hash: 'published',
      models: configStore.current().models,
      visionModel: configStore.current().visionModel,
    });
    expect(await commands.run({ name: 'status' }, 123456789n, ALICE, FIXED_NOW)).toContain(
      '本群模型: vision / vision-model（继承全局）',
    );
    store.close();
  });

  test('status isolates per-chat usage and includes other chats in the global total', async () => {
    const { store, commands } = await setup();
    store.db
      .prepare(
        "INSERT INTO daily_usage(utc_date, scope, resource, metric, amount, updated_at) VALUES (?, 'chat', ?, 'model_tokens', 999, ?)",
      )
      .run('2026-08-14', '123456789', FIXED_NOW.toISOString());
    store.db
      .prepare(
        "INSERT INTO daily_usage(utc_date, scope, resource, metric, amount, updated_at) VALUES (?, 'chat', ?, 'model_tokens', 888, ?)",
      )
      .run(FIXED_NOW.toISOString().slice(0, 10), '987654321', FIXED_NOW.toISOString());
    expect(await commands.run({ name: 'status' }, 123456789n, ALICE, FIXED_NOW)).toContain(
      '本群今日 token 用量: 0\n全局今日 token 用量: 888 / 300,000 (0.30%)',
    );
    store.close();
  });
});
