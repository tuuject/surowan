/**
 * Which Chats one publish touches, and what a Chat sees before the manager has
 * reconciled: pure additions abort nothing, a removed Chat belongs to the chat
 * lifecycle, and a binding is always resolved from the published configuration.
 */

import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { expect, test } from 'vitest';
import { conversations, invocations } from '../../../src/store/schema/index.ts';
import { seedChat } from '../../memo/fixtures.ts';
import {
  CHAT_A,
  CHAT_ANY,
  CHAT_B,
  contextFor,
  fixture,
  queueInvocation,
  seedContext,
  server,
  withChangedAlpha,
} from './shared.ts';

test('adding a server aborts nothing and reaches the Chats that resolve to it', async () => {
  const f = await fixture();
  const chatA = seedChat(f.store, BigInt(CHAT_A));
  const invocationId = queueInvocation(f.store, chatA.conversationId, new Date().toISOString());
  f.scheduler.start();
  await f.whenStarted(1);

  const next = structuredClone(f.configStore.current().config);
  next.mcp = { servers: [...(next.mcp?.servers ?? []), server('gamma', join(f.directory, 'gamma.pid'))] };
  next.telegram.chats.push({ id: CHAT_ANY, instructions: '' });
  const result = await f.apply(next);

  expect(result.affectedChats).toEqual([]);
  expect(result.servers).toMatchObject({ added: ['gamma'], replaced: [], removed: [] });
  expect(f.store.orm.select().from(invocations).where(eq(invocations.id, invocationId)).get()?.state).toBe('running');
  // The new Chat has no binding, so it reaches every server; the next Invocation picks gamma up.
  expect([...f.manager.toolNamesForChat(BigInt(CHAT_ANY), next)].sort()).toEqual(
    ['alpha__echo', 'beta__echo', 'gamma__echo', 'scripted__echo'].sort(),
  );
});

test('a Chat removed together with its server is left to the chat lifecycle', async () => {
  const f = await fixture();
  const chat = seedChat(f.store, BigInt(CHAT_B));
  seedContext(f.store, chat.conversationId, 'old');
  const next = structuredClone(f.configStore.current().config);
  next.telegram.chats = next.telegram.chats.filter((entry) => entry.id !== CHAT_B);
  next.mcp = { servers: (next.mcp?.servers ?? []).filter((entry) => entry.alias !== 'beta') };
  const result = await f.apply(next);
  // The removed Chat's own rows stay until the chat-removal path handles them;
  // the MCP cutover only stops the server that left the file.
  expect(result.affectedChats).toEqual([]);
  expect(result.servers).toMatchObject({ removed: ['beta'] });
  expect(f.store.orm.select().from(conversations).where(eq(conversations.id, chat.conversationId)).get()).toBeDefined();
  expect(
    f.store.db.prepare<[], { state: string }>("SELECT state FROM mcp_server_state WHERE alias = 'beta'").get()?.state,
  ).toBe('stopped');
});

test('a new Chat resolves its binding from the published config before the manager reconciles', async () => {
  const f = await fixture();
  const chat = seedChat(f.store, BigInt(CHAT_A));
  queueInvocation(f.store, chat.conversationId, new Date(Date.now() - 60_000).toISOString());
  f.scheduler.start();
  await f.whenStarted(1);
  const release = f.hold();
  // A Chat added with `mcp: []`, published together with a change to alpha so
  // the cutover has to wait: it must reach no server, even though the manager is
  // still reconciled against the previous configuration.
  const next = withChangedAlpha(f.configStore.current().config, (config) => {
    config.telegram.chats.push({ id: CHAT_ANY, instructions: '', mcp: [] });
    // Two more new Chats: the manager knows neither yet, so only the published
    // configuration can answer. `beta` is unchanged in this publish, `alpha` is
    // the alias being replaced.
    config.telegram.chats.push({ id: CHAT_ANY + 1, instructions: '', mcp: [{ server: 'beta' }] });
    config.telegram.chats.push({ id: CHAT_ANY + 2, instructions: '', mcp: [{ server: 'alpha' }] });
  });
  const pending = await f.apply(next);
  expect(pending.settled).toBe(false);
  expect(f.manager.createTools(contextFor(0n, BigInt(CHAT_ANY), 0n), Date.now() + 30_000, next)).toEqual([]);
  expect(
    f.manager.createTools(contextFor(0n, BigInt(CHAT_ANY + 1), 0n), Date.now() + 30_000, next).map((tool) => tool.name),
  ).toEqual(['beta__echo']);
  // The alias still publishes the previous instance, whose configuration is not
  // the one this Chat resolved: no tools until the reconcile replaces it.
  expect(f.manager.createTools(contextFor(0n, BigInt(CHAT_ANY + 2), 0n), Date.now() + 30_000, next)).toEqual([]);
  // A Chat the published configuration does not list reaches nothing either.
  expect(f.manager.createTools(contextFor(0n, 987_654_321n, 0n), Date.now() + 30_000, next)).toEqual([]);
  release();
  await pending.completion;
});
