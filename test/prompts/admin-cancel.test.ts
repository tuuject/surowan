import type { Update } from 'grammy/types';
import { expect, test } from 'vitest';
import { AdminServer } from '../../src/ingress/admin/index.ts';
import { TelegramIngestion } from '../../src/ingress/telegram-ingestion/index.ts';
import { attachBucketToInvocation } from '../../src/orchestration/invocation-queue/index.ts';
import { BucketScheduler } from '../../src/orchestration/scheduler/index.ts';
import { sleep } from '../helpers.ts';
import { fixture, login, post, put, readJson, request } from './admin-fixtures.ts';

function textUpdate(updateId: number, messageId: number, chatId: number, text: string): Update {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      date: 1_700_000_000 + messageId,
      chat:
        chatId > 0
          ? { id: chatId, type: 'private', first_name: 'Owner' }
          : { id: chatId, type: 'group', title: 'E2E Group' },
      from: { id: 42, is_bot: false, first_name: 'Alice' },
      text,
    },
  };
}

test('saving a prompt reports affected runs and the scoped cancel stops only those', async () => {
  const {
    store,
    server: baseServer,
    reloader,
    configStore,
  } = await fixture((config) => {
    config.telegram.chats.push({ id: -100222 });
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const scheduler = new BucketScheduler(store, configStore, async (_id, _snapshot, signal) => {
    await gate;
    return signal.aborted ? { state: 'aborted', reason: 'aborted' } : { state: 'completed', reason: 'done' };
  });
  const server = new AdminServer({ store, configStore, configReloader: reloader, scheduler });
  const ingestion = new TelegramIngestion(store, configStore, { id: 999 });
  const invocationStates = (): string[] =>
    store.db
      .prepare<[], { state: string }>('SELECT state FROM invocations ORDER BY id')
      .all()
      .map((row) => row.state);
  const until = async (check: () => boolean, label: string): Promise<void> => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (check()) {
        return;
      }
      await sleep(10);
    }
    throw new Error(`Timed out waiting for ${label}`);
  };
  try {
    const start = new Date();
    ingestion.ingest(textUpdate(1, 10, 123456789, 'hello chat a'), start);
    ingestion.ingest(textUpdate(2, 20, -100222, 'hello chat b'), start);
    store.db.prepare('UPDATE buckets SET deadline_at = ?').run(new Date(start.getTime() - 1_000).toISOString());
    scheduler.start();
    await until(
      () => invocationStates().filter((state) => state === 'running').length === 2,
      'both running invocations',
    );

    // A second batch attached mid-run to chat A and not yet injected.
    ingestion.ingest(textUpdate(3, 11, 123456789, 'again chat a'), new Date());
    const running = store.db
      .prepare<[], { id: bigint; conversation_id: bigint; chat_id: bigint }>(
        "SELECT i.id, i.conversation_id, c.telegram_chat_id AS chat_id FROM invocations i JOIN conversations v ON v.id = i.conversation_id JOIN chats c ON c.id = v.chat_id WHERE i.state = 'running'",
      )
      .all();
    const chatA = running.find((row) => row.chat_id === 123456789n);
    if (chatA === undefined) {
      throw new Error('Expected a running invocation for chat A');
    }
    const attached = store.db
      .prepare<[], { id: bigint }>("SELECT id FROM buckets WHERE state = 'collecting'")
      .get()!.id;
    attachBucketToInvocation(store, 20, chatA.id, attached, chatA.conversation_id, new Date());

    const cookie = await login(baseServer);
    const view = await readJson(
      await server.handle(request('/api/prompts/group?chat=123456789&source=file', { headers: { cookie } })),
    );
    const saved = await readJson(
      await server.handle(
        put('/api/prompts/group?chat=123456789', { prompt: 'new group prompt' }, cookie, view.content_hash),
      ),
    );
    expect(saved).toMatchObject({ status: 'saved', affected_running: 1 });

    const canceled = await server.handle(
      post('/api/prompts/cancel-running', { scope: 'group', chat_id: '123456789' }, cookie),
    );
    expect(canceled.status).toBe(200);
    expect(await readJson(canceled)).toMatchObject({ canceled_invocations: 1, expired_buckets: 1 });

    release();
    await until(() => !invocationStates().includes('running'), 'both runs to settle');
    expect(invocationStates()).toEqual(['aborted', 'completed']);
    const bucketStates = store.db
      .prepare<[bigint], { chat_id: bigint; kind: string; state: string; error_code: string | null }>(
        "SELECT c.telegram_chat_id AS chat_id, CASE WHEN b.id = ? THEN 'attached' ELSE 'batch' END AS kind, b.state, b.error_code FROM buckets b JOIN conversations v ON v.id = b.conversation_id JOIN chats c ON c.id = v.chat_id ORDER BY b.id",
      )
      .all(attached);
    expect(bucketStates).toEqual([
      { chat_id: 123456789n, kind: 'batch', state: 'aborted', error_code: null },
      { chat_id: -100222n, kind: 'batch', state: 'completed', error_code: null },
      { chat_id: 123456789n, kind: 'attached', state: 'expired', error_code: 'admin_cancel' },
    ]);
  } finally {
    release();
    await scheduler.stop();
    store.close();
  }
});
