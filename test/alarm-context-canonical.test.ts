import { afterEach, describe, expect, test, vi } from 'vitest';
import { fauxAssistantMessage, type ToolResultMessage } from '@earendil-works/pi-ai';
import { ConversationContextStore } from '../src/context/context-store.ts';
import { BotCommandService } from '../src/orchestration/bot-commands.ts';
import { completeAlarmTask, getAlarmTask, insertAlarmTask } from './alarm-fixtures.ts';
import {
  CHAT_ID,
  call,
  cleanupAlarmFixtures,
  executeResults,
  futureIso,
  listItems,
  retainedMessages,
  resultText,
  runBatch,
  runtimeFixture,
  send,
  toolCallAudits,
  update,
} from './alarm-context-fixtures.ts';

afterEach(cleanupAlarmFixtures);

describe('alarm canonical context', () => {
  test('list result has one canonical result and ordinary audit; only explicit send reaches Telegram', async () => {
    const f = await runtimeFixture((config) => {
      config.developer = { record_model_payloads: true };
    });
    const scheduledAt = futureIso();
    const a1 = insertAlarmTask(f.store, 1n, 42n, 'morning', scheduledAt);
    const a2 = insertAlarmTask(f.store, 1n, 42n, 'evening', scheduledAt);
    insertAlarmTask(f.store, 1n, 99n, 'not mine', scheduledAt);
    const completed = insertAlarmTask(f.store, 1n, 42n, 'completed', scheduledAt);
    completeAlarmTask(f.store, completed);
    const cancelled = insertAlarmTask(f.store, 1n, 42n, 'cancelled', scheduledAt);
    f.tasks.scoped('alarm', 1n).cancel(cancelled, { reason: 'test' });
    const expected = [
      { id: a1.toString(), scheduled_at: scheduledAt, summary: 'morning' },
      { id: a2.toString(), scheduled_at: scheduledAt, summary: 'evening' },
    ];
    let observed: ToolResultMessage | undefined;
    f.faux.setResponses([
      (context) => {
        expect(JSON.stringify(context)).not.toContain('internal_context');
        return call('list_alarm');
      },
      (context, options) => {
        observed = executeResults(context.messages, 'list_alarm')[0];
        expect(listItems(context.messages)).toEqual(expected);
        expect(f.sends).toEqual([]);
        options?.onPayload?.({ messages: context.messages }, f.faux.getModel());
        return send('morning; evening');
      },
      fauxAssistantMessage('private done'),
    ]);
    const invocationId = await runBatch(f, 1, 'list my alarms');
    const retained = retainedMessages(f.store);
    expect(executeResults(retained, 'list_alarm')).toEqual([observed]);
    expect(observed?.details).toEqual({ action: 'call', tool: 'list_alarm' });
    expect(f.sends).toEqual(['morning; evening']);
    expect(
      f.store.db
        .prepare<[], { text: string }>("SELECT text FROM agent_messages WHERE role = 'tool_result' ORDER BY id")
        .all(),
    ).toEqual([{ text: resultText(observed!) }, { text: expect.any(String) }]);
    expect(toolCallAudits(f.store)).toEqual([
      { tool_name: 'execute', state: 'success', error_code: null },
      { tool_name: 'list_alarm', state: 'success', error_code: null },
      { tool_name: 'send', state: 'success', error_code: null },
    ]);
    expect(f.store.db.prepare("SELECT name FROM sqlite_master WHERE name = 'internal_contexts'").all()).toEqual([]);
    expect(
      f.store.db
        .prepare<[bigint], { request_json: string }>(
          'SELECT request_json FROM model_calls WHERE invocation_id = ? AND request_json IS NOT NULL',
        )
        .get(invocationId)?.request_json,
    ).toContain('morning');
    expect(JSON.stringify(retained)).not.toContain('<internal_context_history>');
  });

  test.each(['cached', 'reopened'] as const)(
    '%s model resolves deletion only from its retained tool history',
    async (mode) => {
      let f = await runtimeFixture();
      const first = insertAlarmTask(f.store, 1n, 42n, 'first', futureIso());
      const second = insertAlarmTask(f.store, 1n, 42n, 'second', futureIso(172_800_000));
      f.faux.setResponses([call('list_alarm'), fauxAssistantMessage('private list note')]);
      await runBatch(f, 1, 'list');
      const oldList = executeResults(retainedMessages(f.store), 'list_alarm')[0]!;
      const cached = f.conversationRuntime.cachedAgent(1n)?.agent;
      expect(cached).toBeDefined();
      if (mode === 'reopened') {
        await f.scheduler.stop(0);
        f.store.close();
        f = await runtimeFixture(undefined, f.directory);
        expect(f.conversationRuntime.cachedAgent(1n)).toBeUndefined();
      }
      let derivedId: string | undefined;
      f.faux.setResponses([
        (context, options) => {
          // Crucially derive the call argument from what the provider receives, not a DB query outside Faux.
          expect(executeResults(context.messages, 'list_alarm')).toEqual([oldList]);
          derivedId = listItems(context.messages)[1]?.id;
          expect(derivedId).toBeDefined();
          options?.onPayload?.({ messages: context.messages }, f.faux.getModel());
          return call('delete_alarm', { ...(derivedId === undefined ? {} : { id: derivedId }) });
        },
        (context) => {
          expect(executeResults(context.messages, 'delete_alarm')).toHaveLength(1);
          return send('second reminder cancelled');
        },
        fauxAssistantMessage('private done'),
      ]);
      await runBatch(f, 2, 'delete the second one');
      expect(derivedId).toBe(second.toString());
      expect(getAlarmTask(f.store, first)?.task_state).toBe('waiting');
      expect(getAlarmTask(f.store, second)).toMatchObject({
        task_state: 'cancelled',
        receipt_state: 'suppressed',
        cancel_reason: 'user_requested',
      });
      expect(toolCallAudits(f.store).filter((row) => row.tool_name === 'list_alarm')).toHaveLength(1);
      expect(toolCallAudits(f.store).find((row) => row.tool_name === 'delete_alarm')).toMatchObject({
        state: 'success',
      });
      expect(executeResults(retainedMessages(f.store), 'delete_alarm')).toHaveLength(1);
      expect(f.sends).toEqual(['second reminder cancelled']);
      if (mode === 'cached') {
        expect(f.conversationRuntime.cachedAgent(1n)?.agent).toBe(cached);
      } else {
        expect(f.conversationRuntime.cachedAgent(1n)?.agent).not.toBe(cached);
      }
    },
  );

  test.each(['checkpoint GC', 'topic clear'] as const)(
    '%s forgets the list in canonical history, cache and next request',
    async (mode) => {
      const f = await runtimeFixture((config) => {
        config.telegram.admins = [42];
        config.agent!.context!.retained_sends_target = 1;
        config.agent!.context!.retained_sends_max = 2;
      });
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      insertAlarmTask(f.store, 1n, 42n, 'old-list-marker', futureIso());
      f.faux.setResponses([call('list_alarm'), send('listed'), fauxAssistantMessage('private done')]);
      await runBatch(f, 1, 'list');
      const contexts = new ConversationContextStore(f.store);
      const before = contexts.header(1n)!;
      const oldListSeq = contexts
        .retained(before)
        .find(({ message }) => executeResults([message], 'list_alarm').length > 0)!.seq;
      expect(f.store.db.prepare('SELECT ref FROM context_refs').all().length).toBeGreaterThan(0);
      let nextId: number;
      if (mode === 'checkpoint GC') {
        for (const id of [2, 3]) {
          f.faux.setResponses([send(`reply ${id}`), fauxAssistantMessage('private done')]);
          await runBatch(f, id, `new batch ${id}`);
        }
        expect(log).toHaveBeenCalledWith(expect.stringContaining('"event":"context_gc"'));
        expect(contexts.header(1n)?.lastGcAt).not.toBeNull();
        nextId = 4;
      } else {
        const commands = new BotCommandService(f.store, f.configStore, f.scheduler, undefined, f.conversationRuntime);
        const commandUpdate = update(2, '/cut_topic');
        commandUpdate.message!.entities = [{ offset: 0, length: 10, type: 'bot_command' }];
        const command = f.ingestion.ingest(commandUpdate).command;
        expect(await commands.run(command!, BigInt(CHAT_ID), { id: 42n, name: 'Alice', username: 'alice' })).toContain(
          '清空',
        );
        expect(contexts.header(1n)?.headSeq).toBe(before.nextSeq);
        expect(f.conversationRuntime.cachedAgent(1n)).toBeUndefined();
        expect(log).toHaveBeenCalledWith(expect.stringContaining('"event":"context_cleared"'));
        nextId = 3;
      }
      const after = contexts.header(1n)!;
      expect(after.headSeq).toBeGreaterThan(oldListSeq);
      expect(
        f.store.db
          .prepare<[bigint], { evicted_at: string | null }>(
            'SELECT evicted_at FROM context_messages WHERE context_id = 1 AND seq = ?',
          )
          .get(oldListSeq)?.evicted_at,
      ).toEqual(expect.any(String));
      expect(
        f.store.db.prepare<[bigint]>('SELECT ref FROM context_refs WHERE source_seq < ?').all(after.headSeq),
      ).toEqual([]);
      expect(executeResults(retainedMessages(f.store), 'list_alarm')).toEqual([]);
      expect(executeResults(f.conversationRuntime.cachedAgent(1n)?.agent.state.messages ?? [], 'list_alarm')).toEqual(
        [],
      );
      insertAlarmTask(f.store, 1n, 42n, 'fresh-marker', futureIso(172_800_000));
      f.faux.setResponses([
        (context) => {
          expect(executeResults(context.messages, 'list_alarm')).toEqual([]);
          expect(JSON.stringify(context)).not.toContain('old-list-marker');
          return call('list_alarm');
        },
        (context) => {
          expect(listItems(context.messages).map((item) => item.summary)).toEqual(['old-list-marker', 'fresh-marker']);
          return fauxAssistantMessage('private fresh list');
        },
      ]);
      await runBatch(f, nextId, 'list again');
      expect(executeResults(retainedMessages(f.store), 'list_alarm')).toHaveLength(1);
      expect(toolCallAudits(f.store).filter((row) => row.tool_name === 'list_alarm')).toHaveLength(2);
    },
  );

  test.each(['completed task', 'changed caller'] as const)(
    'retained IDs do not authorize deletion after %s',
    async (mode) => {
      const f = await runtimeFixture();
      const taskId = insertAlarmTask(f.store, 1n, 42n, 'stale', futureIso());
      f.faux.setResponses([call('list_alarm'), fauxAssistantMessage('private list')]);
      await runBatch(f, 1, 'list');
      if (mode === 'completed task') {
        completeAlarmTask(f.store, taskId);
      }
      let derivedId: string | undefined;
      f.faux.setResponses([
        (context) => {
          derivedId = listItems(context.messages)[0]?.id;
          return call('delete_alarm', { ...(derivedId === undefined ? {} : { id: derivedId }) });
        },
        (context) => {
          const result = context.messages.at(-1);
          expect(result?.role).toBe('toolResult');
          if (result?.role !== 'toolResult') {
            throw new Error('Expected a rejected tool result');
          }
          expect(result.isError).toBe(true);
          expect(resultText(result)).toContain('alarm not found');
          return fauxAssistantMessage('private failure note');
        },
      ]);
      await runBatch(f, 2, 'delete that reminder', mode === 'changed caller' ? 99 : 42);
      expect(derivedId).toBe(taskId.toString());
      expect(toolCallAudits(f.store).slice(-2)).toEqual([
        { tool_name: 'execute', state: 'error', error_code: 'capability_error' },
        { tool_name: 'delete_alarm', state: 'error', error_code: 'alarm_not_found' },
      ]);
      expect(getAlarmTask(f.store, taskId)).toMatchObject(
        mode === 'completed task'
          ? { task_state: 'completed', receipt_state: 'handled' }
          : { task_state: 'waiting', receipt_state: null },
      );
      expect(f.sends).toEqual([]);
    },
  );
});
