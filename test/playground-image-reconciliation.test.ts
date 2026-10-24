/**
 * Quota limits, reconciliation and host eligibility: reconciliation never settles a
 * generation that can still run, and a process never executes or recovers work of
 * a host it does not serve.
 *
 * Split out of `test/playground-image.test.ts`; the header there describes the
 * full acceptance chain these cases exercise.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { createOpenRouterAdapter } from '@surowan/image-service';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, test } from 'vitest';
import { loadConfig } from '../src/adapters/local-monolith/config.ts';
import { SqliteStore } from '../src/adapters/local-monolith/database.ts';
import { generationEligibilityForHosts } from '../src/image/host-eligibility.ts';
import { createImageService } from '../src/image/service.ts';
import { keyJarPath } from '../src/platform/key-jar.ts';
import { SecretStore } from '../src/platform/secrets.ts';
import { chats, conversations, imageGenerationAttempts, imageGenerations } from '../src/store/schema.ts';
import {
  cleanups,
  directories,
  enableRoomImage,
  generationRows,
  playgroundImageFixture,
  providerPng,
  providerResponse,
  receiptRows,
  releaseRoomInput,
  runInvocation,
  settledGeneration,
  settledTask,
  submitGeneration,
  taskRows,
  writeImageFixture,
} from './playground-image-fixtures.ts';

describe('playground image generation', () => {
  test('a quota refusal creates no generation and starts no provider call', async () => {
    const f = await playgroundImageFixture();
    const invocationId = releaseRoomInput(f, 'ask-quota');
    enableRoomImage(f, true);
    await submitGeneration(f, invocationId, 'call-a');
    await submitGeneration(f, invocationId, 'call-b');
    await submitGeneration(f, invocationId, 'call-c');
    await expect(submitGeneration(f, invocationId, 'call-d')).rejects.toThrow(/quota/i);

    expect(generationRows(f)).toHaveLength(3);
    expect(taskRows(f)).toHaveLength(3);
    await expect.poll(() => f.providerCalls.length).toBe(3);

    // A retried tool call at the limit replays its own generation instead of
    // being refused: replays create nothing, so they are not metered.
    const replayed = await submitGeneration(f, invocationId, 'call-b');
    expect(replayed.replayed).toBe(true);
    expect(generationRows(f)).toHaveLength(3);
    expect(taskRows(f)).toHaveLength(3);
    expect(f.providerCalls).toHaveLength(3);
  });

  test('a running generation is not settled by reconciliation', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = await playgroundImageFixture({ beforeProvider: () => gate });
    const invocationId = releaseRoomInput(f, 'ask-gate');
    enableRoomImage(f, true);
    f.faux.setResponses([
      () =>
        fauxAssistantMessage(
          fauxToolCall(
            'execute',
            { action: 'call', tool: 'image_generate', input: { prompt: 'a quiet harbor' } },
            { id: 'call-gate' },
          ),
          { stopReason: 'toolUse' },
        ),
      () => fauxAssistantMessage('submitted'),
    ]);
    await runInvocation(f, invocationId);
    await expect.poll(() => generationRows(f)[0]?.status).toBe('running');

    // A reconciling pass (the startup path) must leave the task waiting: the
    // worker's finished listener settles it with the real result, and a task
    // settles exactly once.
    f.bridge.reconcile();
    expect(taskRows(f)[0]?.state).toBe('waiting');
    expect(receiptRows(f)).toEqual([]);

    release?.();
    const generationId = await settledGeneration(f);
    await settledTask(f);
    const receipt = receiptRows(f)[0];
    expect(receipt?.status).toBe('completed');
    const delivery = JSON.parse(String(receipt?.resultJson)) as { generation_id: string; outputs: unknown[] };
    expect(delivery.generation_id).toBe(generationId);
    expect(delivery.outputs).toHaveLength(1);
  });

  test('a standalone process never executes or recovers work of a host it does not serve', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'surowan-standalone-image-'));
    directories.push(directory);
    const configPath = join(directory, 'config.jsonc');
    await writeImageFixture(directory, configPath);
    const loaded = await loadConfig(configPath);
    const store = await SqliteStore.open(loaded.config);
    cleanups.push(() => store.close());
    const now = new Date().toISOString();
    store.orm
      .insert(chats)
      .values({
        id: 100n,
        hostKind: 'telegram',
        telegramChatId: 100n,
        canonicalChatId: 100n,
        type: 'private',
        updatedAt: now,
      })
      .run();
    store.orm.insert(conversations).values({ id: 42n, chatId: 100n, createdAt: now, updatedAt: now }).run();
    store.orm
      .insert(chats)
      .values({
        id: 200n,
        hostKind: 'playground',
        telegramChatId: null,
        canonicalChatId: null,
        type: 'group',
        updatedAt: now,
      })
      .run();
    store.orm.insert(conversations).values({ id: 43n, chatId: 200n, createdAt: now, updatedAt: now }).run();

    const eligible = generationEligibilityForHosts(store, ['playground'], () => true);
    expect(eligible({ id: 'x', actorId: 'agent:42' })).toBe(false);
    expect(eligible({ id: 'x', actorId: 'agent:43' })).toBe(true);
    // An actor that is not one conversation's agent belongs to no host, and a
    // malformed actor id is not one either.
    expect(eligible({ id: 'x', actorId: 'admin:root' })).toBe(true);
    expect(eligible({ id: 'x', actorId: 'agent:0042' })).toBe(true);

    const calls: string[] = [];
    const providerFetch: typeof fetch = async (_input, init) => {
      calls.push(String(init?.body));
      return providerResponse(await providerPng());
    };
    const openService = () => {
      const service = createImageService(store, loaded.config, {
        providerAdapter: createOpenRouterAdapter({ fetchImpl: providerFetch }),
        executionEligibility: eligible,
      });
      cleanups.push(() => service.stop());
      return service;
    };
    const agentActor = (conversationId: bigint) => ({
      id: `agent:${conversationId.toString()}`,
      name: 'agent',
      source: 'agent' as const,
      scopes: [],
      privileged: true,
    });
    const input = (prompt: string) => ({
      authoredPrompt: prompt,
      modelId: 'gpt-image-1',
      aspectRatio: 'auto' as const,
      resolution: 'auto' as const,
      outputCount: 1,
      inputImages: [] as string[],
    });
    const service = openService();
    service.publishConfig(await service.prepareConfig(loaded.config, new SecretStore(keyJarPath(configPath))));
    const telegram = service.core.generations.create(input('telegram work'), agentActor(42n), 'tg-live');
    service.core.generations.create(input('playground work'), agentActor(43n), 'pg-live');

    // The room's generation runs; the Telegram one is never even claimed.
    await expect
      .poll(
        () =>
          store.orm
            .select()
            .from(imageGenerations)
            .all()
            .find((row) => row.id !== telegram.generation.id)?.status,
      )
      .toBe('succeeded');
    expect(
      store.orm.select().from(imageGenerations).where(eq(imageGenerations.id, telegram.generation.id)).get()?.status,
    ).toBe('queued');
    expect(
      store.orm
        .select()
        .from(imageGenerationAttempts)
        .where(eq(imageGenerationAttempts.generationId, telegram.generation.id))
        .all(),
    ).toEqual([]);
    expect(calls).toHaveLength(1);

    // A Telegram generation left running by a crash, and a fresh Playground one
    // queued while this process was stopping: a restart must recover the second
    // and leave the first exactly as it was.
    await service.stop();
    store.orm.run(sql`UPDATE image_generations SET status = 'running' WHERE id = ${telegram.generation.id}`);
    const crashQueued = service.core.generations.create(input('queued while stopping'), agentActor(42n), 'tg-queued');
    const restart = openService();
    restart.publishConfig(await restart.prepareConfig(loaded.config, new SecretStore(keyJarPath(configPath))));
    await restart.core.worker.stop();
    expect(
      store.orm.select().from(imageGenerations).where(eq(imageGenerations.id, telegram.generation.id)).get()?.status,
    ).toBe('running');
    expect(
      store.orm.select().from(imageGenerations).where(eq(imageGenerations.id, crashQueued.generation.id)).get()?.status,
    ).toBe('queued');
    expect(calls).toHaveLength(1);
  });
});
