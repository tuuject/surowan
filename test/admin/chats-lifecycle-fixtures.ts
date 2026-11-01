import { eq } from 'drizzle-orm';
import { afterEach, vi } from 'vitest';
import { ConfigReloader, type ImageConfigGateway } from '../../src/adapters/local-monolith/config/reload.ts';
import { applyGroupMemoryToggles, stopRemovedChats } from '../../src/adapters/local-monolith/runtime/chat-lifecycle.ts';
import { createChatsAdminHandler } from '../../src/ingress/admin/routes/chats.ts';
import { BucketScheduler, type InvocationHandler } from '../../src/orchestration/scheduler/index.ts';
import { AgentModelSwitcher } from '../../src/platform/models/switch.ts';
import { keyJarPath } from '../../src/platform/key-jar.ts';
import { SecretStore } from '../../src/platform/secrets.ts';
import { LongTaskService } from '../../src/store/long-tasks/index.ts';
import { buckets, invocationBuckets, invocations, toolCalls } from '../../src/store/schema/index.ts';
import { finishToolCall, startToolCall } from '../../src/store/store.ts';
import type { FixtureConfig } from '../helpers.ts';
import { memoFixture, seedInvocation, type MemoFixture } from '../memo/fixtures.ts';

export const cleanup: Array<() => Promise<void>> = [];

/** Registers the shared teardown; call once at the top of each lifecycle test file. */
export function useLifecycleCleanup(): void {
  afterEach(async () => {
    for (const close of cleanup.splice(0)) {
      await close();
    }
    vi.restoreAllMocks();
  });
}

export async function fixture(
  handler: (f: MemoFixture) => InvocationHandler,
  options: { transform?: (config: FixtureConfig) => void; imageConfig?: ImageConfigGateway } = {},
) {
  const f = await memoFixture(options.transform);
  const tasks = new LongTaskService(f.store.orm);
  const scheduler = new BucketScheduler(f.store, f.configStore, handler(f), undefined, tasks);
  cleanup.push(async () => {
    await scheduler.stop(0);
    await f.close();
  });
  let published = f.configStore.current().config;
  const forget = vi.fn();
  const reloader = new ConfigReloader({
    loaded: f.loaded,
    store: f.configStore,
    modelSwitcher: new AgentModelSwitcher(f.configStore),
    secrets: new SecretStore(keyJarPath(f.loaded.configPath)),
    validateAgentModel: () => undefined,
    ...(options.imageConfig === undefined ? {} : { imageConfig: options.imageConfig }),
    onPublished: async () => {
      const next = f.configStore.current().config;
      const nextIds = new Set(next.telegram.chats.map((chat) => chat.id));
      const removed = published.telegram.chats.filter((chat) => !nextIds.has(chat.id)).map((chat) => BigInt(chat.id));
      stopRemovedChats(f.store, tasks, (ids, reason) => scheduler.abortInvocations(ids, reason), forget, removed, next);
      await applyGroupMemoryToggles(f.store, scheduler, forget, published, next);
      published = next;
      scheduler.wake();
    },
  });
  const route = createChatsAdminHandler({
    store: f.store,
    configStore: f.configStore,
    configReloader: reloader,
    secrets: undefined,
    memoBlobs: f.blobs,
    scheduler,
  });
  const updateGroupMemory = async (id: bigint, body: { readonly enabled: boolean }) => {
    const response = await route.handle(
      new Request(`http://localhost/api/chats/${id}/group-memory`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'if-match': await reloader.revision() },
        body: JSON.stringify(body),
      }),
      ['chats', id.toString(), 'group-memory'],
    );
    if (response === undefined) {
      throw new Error('Group memory route was not handled');
    }
    return response;
  };
  const remove = async (id: bigint) => {
    const response = await route.handle(
      new Request(`http://localhost/api/chats/${id}`, {
        method: 'DELETE',
        headers: { 'if-match': await reloader.revision() },
      }),
      ['chats', id.toString()],
    );
    if (response === undefined) {
      throw new Error('Chat delete route was not handled');
    }
    return response;
  };
  return { ...f, tasks, scheduler, reloader, forget, updateGroupMemory, remove };
}

export function queue(f: MemoFixture, conversationId: bigint): bigint {
  const id = seedInvocation(f.store, conversationId);
  const now = new Date().toISOString();
  const invocation = f.store.orm.select().from(invocations).where(eq(invocations.id, id)).get();
  if (invocation === undefined) {
    throw new Error('Missing seeded invocation');
  }
  f.store.orm.update(invocations).set({ state: 'queued', createdAt: now }).where(eq(invocations.id, id)).run();
  f.store.orm
    .update(buckets)
    .set({ state: 'queued', firstReceivedAt: now, deadlineAt: now, createdAt: now, updatedAt: now })
    .where(eq(buckets.id, invocation.bucketId))
    .run();
  f.store.orm
    .insert(invocationBuckets)
    .values({ invocationId: id, bucketId: invocation.bucketId, attachedAt: now, injectedAt: now })
    .run();
  return id;
}

export function slowHandler() {
  const started = Promise.withResolvers<void>();
  const aborted = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const audited = vi.fn();
  cleanup.push(async () => release.resolve());
  return {
    started,
    aborted,
    release,
    audited,
    handler:
      (f: MemoFixture): InvocationHandler =>
      async (id, _snapshot, signal) => {
        const auditId = startToolCall(f.store.orm, id, 'slow-tool', 'test', '{}', false);
        signal.addEventListener('abort', () => aborted.resolve(), { once: true });
        started.resolve();
        await release.promise;
        finishToolCall(f.store.orm, auditId, 'success', 'finished after abort', null);
        const lateAuditId = startToolCall(f.store.orm, id, 'late-audit', 'test-finalize', '{}', false);
        finishToolCall(f.store.orm, lateAuditId, 'success', 'final audit persisted', null);
        audited(f.store.orm.select().from(toolCalls).where(eq(toolCalls.id, auditId)).get());
        return { state: signal.aborted ? 'aborted' : 'completed', reason: signal.aborted ? 'chat_removed' : 'done' };
      },
  };
}
