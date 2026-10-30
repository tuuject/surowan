import { afterAll, expect, test, vi } from 'vitest';
import { fauxAssistantMessage } from '@earendil-works/pi-ai';
import { SqliteStore } from '../../src/adapters/local-monolith/database.ts';
import { ContextBuilder } from '../../src/context/builder/index.ts';
import { MemoPadStore } from '../../src/context/memo-pad/store.ts';
import { TelegramIngestion } from '../../src/ingress/telegram-ingestion/index.ts';
import { AgentRuntime } from '../../src/orchestration/agent-runtime/index.ts';
import { InvocationQueueService } from '../../src/orchestration/invocation-queue/index.ts';
import { SecretStore } from '../../src/platform/secrets.ts';
import { emptySystemResources } from '../../src/platform/system-resources.ts';
import { testTelegramRuntime } from '../helpers.ts';
import { cleanupFixtureDirectories, fixture, fauxAgent, update, withoutIdleWait } from './hot-inject-fixtures.ts';

afterAll(cleanupFixtureDirectories);

for (const scenario of ['unchanged', 'changed', 'later-refresh', 'failed-later', 'failed-state'] as const) {
  test(`queued memo announcements retain their checkpoint state: ${scenario}`, async () => {
    const failed = scenario === 'failed-later' || scenario === 'failed-state';
    const f = await fixture(withoutIdleWait);
    let store = f.store;
    const memoPad = new MemoPadStore(store.orm);
    const faux = fauxAgent();
    const runtime = await f.runtimeWith(faux);
    const queue = new InvocationQueueService(store, f.configStore, {
      isClosing: () => false,
      isRoundInProgress: () => false,
      queueInjection: (conversationId, bucketId) => f.conversationRuntime.queueInjection(conversationId, bucketId),
    });
    let conversationId = 0n;
    let chatId = 0n;
    let renderCount = 0;
    const renderedSeqs: bigint[] = [];
    const renderInjection = ContextBuilder.prototype.renderInjection;
    const renderSpy = vi.spyOn(ContextBuilder.prototype, 'renderInjection').mockImplementation(function (
      this: ContextBuilder,
      config,
      input,
    ) {
      const result = renderInjection.call(this, config, input);
      renderCount += 1;
      if (renderCount > 1) {
        renderedSeqs.push(input.seq);
      }
      if (renderCount === 2 && scenario !== 'unchanged') {
        memoPad.create(chatId, { summary: 'later memo', detail: 'second queued batch only', ttlSeconds: 3_600 });
        if (scenario === 'later-refresh') {
          const cached = f.conversationRuntime.cachedAgent(conversationId);
          if (cached === undefined) {
            throw new Error('Expected the running agent');
          }
          cached.header.memoRefreshPending = true;
        }
      }
      return result;
    });
    try {
      f.ingestion.ingest(update(1, 10, 'opening batch'), new Date());
      const identity = store.db
        .prepare<[], { id: bigint; chat_id: bigint }>('SELECT id, chat_id FROM conversations')
        .get()!;
      conversationId = identity.id;
      chatId = identity.chat_id;
      const [invocationId] = queue.processDue(new Date());
      if (invocationId === undefined) {
        throw new Error('Expected the opening invocation');
      }
      store.db.prepare("UPDATE invocations SET state = 'running' WHERE id = ?").run(invocationId);
      store.db.prepare("UPDATE buckets SET state = 'running'").run();
      // Observe each real state write alongside the canonical checkpoint already
      // present at that instant, including intermediate commits in one run.
      store.db.exec(`CREATE TABLE memo_commits (state_json TEXT, refresh_seq INTEGER, checkpoint_seq INTEGER);
        CREATE TRIGGER observe_memo_commit AFTER UPDATE OF memo_state_json ON conversation_contexts
        BEGIN INSERT INTO memo_commits VALUES (NEW.memo_state_json, NEW.memo_refresh_seq,
          (SELECT MAX(seq) FROM context_messages WHERE is_checkpoint = 1)); END;`);
      if (scenario === 'failed-later') {
        store.db.exec(`CREATE TRIGGER fail_later_batch BEFORE INSERT ON context_messages
          WHEN NEW.payload_json LIKE '%last queued batch%'
          BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END;`);
      }
      if (scenario === 'failed-state') {
        store.db.exec(`CREATE TRIGGER fail_memo_state BEFORE UPDATE OF memo_state_json ON conversation_contexts
          WHEN NEW.memo_state_json LIKE '%later memo%'
          BEGIN SELECT RAISE(ABORT, 'memo state write failed'); END;`);
      }
      faux.setResponses([
        () => {
          if (scenario !== 'later-refresh') {
            memoPad.create(chatId, { summary: 'first memo', detail: 'first queued batch', ttlSeconds: 3_600 });
          }
          for (const [updateId, messageId, text] of [
            [2, 11, 'first queued batch'],
            [3, 12, 'last queued batch'],
          ] as const) {
            f.ingestion.ingest(update(updateId, messageId, text), new Date());
            expect(queue.processDue(new Date())).toEqual([]);
          }
          return fauxAssistantMessage('opening answer');
        },
        () => fauxAssistantMessage('queued answer'),
        () => fauxAssistantMessage('last queued answer'),
      ]);
      const outcome = await runtime.run(invocationId, f.configStore.beginInvocation(), new AbortController().signal);
      expect(outcome.state).toBe(failed ? 'failed' : 'completed');
      expect(renderCount).toBe(3);
      expect(renderedSeqs[0]).toBe(renderedSeqs[1]);
      const checkpoints = store.db
        .prepare<[], { seq: bigint; payload_json: string }>(
          'SELECT seq, payload_json FROM context_messages WHERE is_checkpoint = 1 ORDER BY seq',
        )
        .all();
      expect(checkpoints).toHaveLength(failed ? 2 : 3);
      expect(checkpoints[0]?.payload_json).toContain('opening batch');
      expect(checkpoints[1]?.payload_json).toContain('first queued batch');
      if (!failed) {
        expect(checkpoints[2]?.payload_json).toContain('last queued batch');
      }
      if (scenario === 'later-refresh') {
        expect(checkpoints[1]?.payload_json).not.toContain('<memo_');
        expect(checkpoints[2]?.payload_json).toContain('<memo_list>');
        expect(checkpoints[2]?.seq).not.toBe(renderedSeqs[1]);
      } else {
        expect(checkpoints[1]?.payload_json).toContain('<memo_updates>');
        expect(checkpoints[1]?.payload_json).toContain('first memo');
        expect(checkpoints[1]?.payload_json).not.toContain('later memo');
        if (scenario === 'unchanged') {
          expect(checkpoints[2]?.payload_json).not.toContain('<memo_');
        }
        if (scenario === 'changed') {
          expect(checkpoints[2]?.payload_json).toContain('later memo');
        }
      }
      const commits = store.db
        .prepare<[], { state_json: string; refresh_seq: bigint; checkpoint_seq: bigint }>(
          'SELECT * FROM memo_commits ORDER BY rowid',
        )
        .all();
      expect(commits).toHaveLength(scenario === 'changed' ? 3 : 2);
      expect(commits[0]?.state_json).toBe('[]');
      expect(commits[0]?.checkpoint_seq).toBe(checkpoints[0]?.seq);
      expect(commits[1]?.checkpoint_seq).toBe(checkpoints[scenario === 'later-refresh' ? 2 : 1]?.seq);
      if (scenario !== 'later-refresh') {
        expect(commits[1]?.state_json).not.toContain('later memo');
      }
      if (scenario === 'changed') {
        expect(commits[2]?.checkpoint_seq).toBe(checkpoints[2]?.seq);
      }
      const persisted = store.db
        .prepare<[], { memo_state_json: string; memo_refresh_seq: bigint; system_prompt_hash: string }>(
          'SELECT memo_state_json, memo_refresh_seq, system_prompt_hash FROM conversation_contexts',
        )
        .get()!;
      const refreshSeq = checkpoints[scenario === 'later-refresh' ? 2 : 0]!.seq;
      expect(persisted.memo_refresh_seq).toBe(refreshSeq);
      expect(commits.at(-1)?.refresh_seq).toBe(refreshSeq);
      expect(persisted.memo_state_json).toBe(commits.at(-1)?.state_json);
      expect(persisted.memo_state_json).toContain(scenario === 'later-refresh' ? 'later memo' : 'first memo');
      if (scenario === 'changed') {
        expect(persisted.memo_state_json).toContain('later memo');
      }
      const summaries = (JSON.parse(persisted.memo_state_json) as { summary: string }[])
        .map((entry) => entry.summary)
        .sort();
      expect(summaries).toEqual(
        scenario === 'later-refresh'
          ? ['later memo']
          : scenario === 'changed'
            ? ['first memo', 'later memo']
            : ['first memo'],
      );
      if (failed) {
        expect(persisted.memo_state_json).not.toContain('later memo');
        expect(f.conversationRuntime.cachedAgent(conversationId)).toBeUndefined();
        queue.releaseUninjectedBuckets(invocationId, new Date());
        expect(
          store.db
            .prepare<[], { count: bigint }>("SELECT COUNT(*) AS count FROM invocations WHERE state = 'queued'")
            .get()?.count,
        ).toBe(1n);
        store.db.exec(`DROP TRIGGER ${scenario === 'failed-state' ? 'fail_memo_state' : 'fail_later_batch'}`);
      }
      store.db.prepare('UPDATE invocations SET state = ? WHERE id = ?').run(outcome.state, invocationId);
      store.db.prepare("UPDATE buckets SET state = ? WHERE state = 'running'").run(outcome.state);
      renderSpy.mockRestore();
      // Reopen SQLite and reconstruct both runtime and context cache. The next
      // real invocation must continue from the announced state on disk.
      store.close();
      store = await SqliteStore.open(f.config);
      const restarted = new AgentRuntime({
        store,
        configStore: f.configStore,
        secrets: new SecretStore(),
        hosts: { telegram: f.host },
        conversation: testTelegramRuntime(f.sendApi).conversation,
        bot: { id: 999n, displayName: 'Surowan', username: 'surowan' },
        systemResources: emptySystemResources(),
      });
      const nextQueue = new InvocationQueueService(store, f.configStore, restarted.conversationRuntime);
      let nextInvocationId: bigint | undefined;
      if (failed) {
        nextInvocationId = store.db
          .prepare<[], { id: bigint }>("SELECT id FROM invocations WHERE state = 'queued'")
          .get()?.id;
      } else {
        new TelegramIngestion(store, f.configStore, { id: 999 }).ingest(update(4, 13, 'after restart'), new Date());
        [nextInvocationId] = nextQueue.processDue(new Date());
      }
      if (nextInvocationId === undefined) {
        throw new Error('Expected a restart invocation');
      }
      store.db.prepare("UPDATE invocations SET state = 'running' WHERE id = ?").run(nextInvocationId);
      faux.setResponses([() => fauxAssistantMessage('restart answer')]);
      expect(
        (await restarted.run(nextInvocationId, f.configStore.beginInvocation(), new AbortController().signal)).state,
      ).toBe('completed');
      const restartCheckpoint = store.db
        .prepare<[bigint], { payload_json: string }>(
          'SELECT payload_json FROM context_messages WHERE invocation_id = ? AND is_checkpoint = 1',
        )
        .get(nextInvocationId)!;
      expect(restartCheckpoint.payload_json).not.toContain('<memo_list>');
      if (failed) {
        expect(restartCheckpoint.payload_json).toContain('<memo_updates>');
        expect(restartCheckpoint.payload_json).toContain('later memo');
        expect(
          store.db
            .prepare<[], { count: bigint }>(
              "SELECT COUNT(*) AS count FROM context_messages WHERE is_checkpoint = 1 AND payload_json LIKE '%last queued batch%'",
            )
            .get()?.count,
        ).toBe(1n);
      } else {
        expect(restartCheckpoint.payload_json).not.toContain('<memo_updates>');
      }
      const reopenedState = store.db
        .prepare<[], { memo_state_json: string; memo_refresh_seq: bigint }>(
          'SELECT memo_state_json, memo_refresh_seq FROM conversation_contexts',
        )
        .get()!;
      expect(reopenedState.memo_refresh_seq).toBe(refreshSeq);
      if (failed) {
        expect(reopenedState.memo_state_json).toContain('later memo');
      } else {
        expect(reopenedState.memo_state_json).toBe(persisted.memo_state_json);
      }
    } finally {
      renderSpy.mockRestore();
      store.close();
    }
  }, 30_000);
}
