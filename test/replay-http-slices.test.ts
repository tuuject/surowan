import { fauxAssistantMessage, fauxToolCall, withoutInitialSystemMessage } from '@earendil-works/pi-ai';
import { eq } from 'drizzle-orm';
import { afterEach, expect, test } from 'vitest';
import { hostSends, invocationMessages, messages } from '../src/store/schema.ts';
import {
  cleanupFixtures,
  expectSessionActivityOnly,
  fixture,
  productionTables,
  runCli,
  setupAdminSession,
} from './replay-http-fixtures.ts';

/**
 * Scene slicing over real HTTP: the window injected into the replay, the
 * strict `before_send_id` selection contract, and the paid-call gate.
 */

afterEach(cleanupFixtures);

test('bot-sliced CLI replay injects its window immediately and validates selection before model work', async () => {
  const f = await fixture();
  const admin = await setupAdminSession(f.baseUrl);
  const env = { SUROWAN_ENDPOINT: f.baseUrl, SUROWAN_API_KEY: admin.key };
  const send = f.store.orm.select().from(hostSends).get()!;
  f.store.orm.update(messages).set({ sentByBot: true }).where(eq(messages.id, f.seed.messageIds[0]!)).run();
  const frozen = f.store.orm
    .select()
    .from(invocationMessages)
    .where(eq(invocationMessages.invocationId, f.seed.invocationA))
    .get()!;
  const snapshot = JSON.parse(frozen.snapshotJson) as Record<string, unknown>;
  f.store.orm
    .update(invocationMessages)
    .set({
      snapshotJson: JSON.stringify({
        ...snapshot,
        reply_to_message_id: '900',
        reply_snapshot: { sender: 'Bot', content: 'old answer outside window' },
      }),
    })
    .where(eq(invocationMessages.invocationId, f.seed.invocationA))
    .run();
  const before = productionTables(f.rows());
  const selection = ['--before-send', send.id.toString()];
  const preflight = await runCli(['invocation', 'preflight', '4001', ...selection, '--json'], env);
  expect(preflight.code, preflight.stderr).toBe(0);
  expect(JSON.parse(preflight.stdout)).toMatchObject({
    available: true,
    scene: {
      cutoff_at: send.createdAt,
      message_count: 1,
      history_count: 0,
      slice: { before_send_id: send.id.toString(), before_message_id: '902', after_bot_message_id: '900' },
    },
  });
  expect(f.faux.state.callCount).toBe(0);
  f.faux.setResponses([
    (context) => {
      expect(withoutInitialSystemMessage(context.messages)).toHaveLength(1);
      const text = JSON.stringify(context.messages);
      expect(text).toContain('plain text message with a reply');
      for (const excluded of [
        'old answer outside window',
        'first caption',
        're:900',
        'Hello from the seeded invocation',
        'private reasoning',
      ]) {
        expect(text).not.toContain(excluded);
      }
      return fauxAssistantMessage(
        [fauxToolCall('send', { text: 'synthetic slice answer', reply_to_message_id: '901' })],
        { stopReason: 'toolUse' },
      );
    },
    fauxAssistantMessage('private finish'),
  ]);
  const replay = await runCli(['invocation', 'replay', '4001', ...selection, '--confirm-paid', '--json'], env);
  expect(replay.code, replay.stderr).toBe(0);
  expect(JSON.parse(replay.stdout)).toMatchObject({
    error: null,
    send_count: 1,
    overrides: { global_prompt: false, group_prompt: false },
    scene: {
      message_count: 1,
      history_count: 0,
      slice: { before_send_id: send.id.toString() },
    },
  });
  expect(f.faux.state.callCount).toBe(2);
  for (const params of [
    'before_send_id=0',
    'before_send_id=9223372036854775808',
    'before_send_id=1&before_send_id=2',
    'unknown=1',
  ]) {
    const invalid = await fetch(`${f.baseUrl}/api/invocations/4001/replay-preflight?${params}`, {
      headers: { authorization: `Bearer ${admin.key}` },
    });
    expect(invalid.status).toBe(400);
  }
  const empty = await runCli(
    ['invocation', 'replay', '4001', '--before-send', '999999', '--confirm-paid', '--json'],
    env,
  );
  expect(empty.code).toBe(1);
  expect(empty.stderr).toContain('replay_slice_target_invalid');
  for (const input of [
    { before_send_id: 1 },
    { before_send_id: '0' },
    { before_send_id: '9223372036854775808' },
    { before_send_id: send.id.toString(), extra: true },
  ]) {
    const invalid = await fetch(`${f.baseUrl}/api/invocations/4001/replay`, {
      method: 'POST',
      headers: { authorization: `Bearer ${admin.key}`, 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    expect(invalid.status).toBe(400);
  }
  const invalidTarget = await fetch(`${f.baseUrl}/api/invocations/4001/replay`, {
    method: 'POST',
    headers: { authorization: `Bearer ${admin.key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ before_send_id: '999999' }),
  });
  expect(invalidTarget.status).toBe(409);
  expect(await invalidTarget.json()).toMatchObject({ error: 'replay_slice_target_invalid' });
  const sessionReplay = await fetch(`${f.baseUrl}/api/invocations/4001/replay`, {
    method: 'POST',
    headers: { cookie: admin.cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ before_send_id: send.id.toString() }),
  });
  expect(sessionReplay.status).toBe(405);
  expect(await sessionReplay.json()).toMatchObject({ error: 'method_not_allowed' });
  expect(f.faux.state.callCount).toBe(2);
  expectSessionActivityOnly(before, productionTables(f.rows()));
}, 120_000);

test('a sliced replay without --confirm-paid is refused before any request', async () => {
  const f = await fixture();
  const admin = await setupAdminSession(f.baseUrl);
  const env = { SUROWAN_ENDPOINT: f.baseUrl, SUROWAN_API_KEY: admin.key };
  const send = f.store.orm.select().from(hostSends).get()!;
  const before = f.rows();
  const refused = await runCli(['invocation', 'replay', '4001', '--before-send', send.id.toString(), '--json'], env);
  expect(refused.code).toBe(2);
  expect(refused.stdout).toBe('');
  expect(JSON.parse(refused.stderr)).toEqual({
    error: 'confirm_paid_required',
    message: 'invocation replay --before-send requires --confirm-paid to confirm the billed model call',
  });
  // No HTTP request reached the server at all: not even the free preflight ran,
  // so nothing moved — including the API key's last_used_at clock — and the
  // model was never asked to bill anything.
  expect(f.rows()).toEqual(before);
  expect(f.faux.state.callCount).toBe(0);
}, 120_000);
