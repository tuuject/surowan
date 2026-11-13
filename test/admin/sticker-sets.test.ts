/**
 * Telegram → Sticker sets: `telegram.sticker_sets` edited in place and
 * hot-applied through the production publish hook.
 *
 * Ways this can fail, each pinned below:
 * - a write without, or with a stale, revision overwrites someone else's edit;
 * - an alias or name the schema rejects reaches the file (and fails the apply),
 *   or a pasted t.me link is stored verbatim;
 * - the same Telegram set is added twice under two spellings or two aliases;
 * - an update re-points an alias at another Telegram set;
 * - a rename creates a second store row, losing the synchronized index;
 * - the change stays restart-only, so the running process keeps the old list;
 * - adding or removing a set leaves running Telegram replies on the old catalog,
 *   or a rename/note edit stops them, or a Playground room run is stopped;
 * - a removed set's row (and index) is deleted instead of kept for a re-add.
 */
import { expect, test } from 'vitest';
import { join } from 'node:path';
import { loadConfig } from '../../src/adapters/local-monolith/config/index.ts';
import { readConfigRevision } from '../../src/adapters/local-monolith/config/file.ts';
import { ConfigReloader } from '../../src/adapters/local-monolith/config/reload.ts';
import { publishStickerSets } from '../../src/adapters/local-monolith/runtime/sticker-sets.ts';
import { AdminServer } from '../../src/ingress/admin/index.ts';
import { AgentModelSwitcher } from '../../src/platform/models/switch.ts';
import { SecretStore } from '../../src/platform/secrets.ts';
import { buckets, invocations } from '../../src/store/schema/index.ts';
import { seedAdminConversation } from '../fixtures/admin-seed-conversation.ts';
import { T } from '../fixtures/admin-seed-data.ts';
import { seedPlaygroundRoom } from '../fixtures/playground-room.ts';
import { fixture, PASSWORD, post, readJson, request, sessionCookie } from './fixtures.ts';

function runningTelegramInvocation(store: Awaited<ReturnType<typeof fixture>>['store']): bigint {
  const now = new Date().toISOString();
  const bucket = store.orm
    .insert(buckets)
    .values({
      conversationId: T.conversation,
      state: 'running',
      firstReceivedAt: now,
      deadlineAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: buckets.id })
    .get();
  const invocation = store.orm
    .insert(invocations)
    .values({
      bucketId: bucket?.id ?? 0n,
      conversationId: T.conversation,
      state: 'running',
      configHash: 'test',
      promptVersion: 1n,
      startedAt: now,
      createdAt: now,
    })
    .returning({ id: invocations.id })
    .get();
  if (invocation === undefined) {
    throw new Error('failed to seed a running invocation');
  }
  return invocation.id;
}

test('sticker set API adds, renames, notes and removes sets with hot apply', async () => {
  const { store, loaded, configStore, directory } = await fixture();
  const configPath = join(directory, 'config.jsonc');
  seedAdminConversation(store.orm);
  const telegramRun = runningTelegramInvocation(store);
  const room = seedPlaygroundRoom(store);
  const aborts: { ids: readonly bigint[]; reason: string }[] = [];
  let refreshes = 0;
  let publishedConfig = configStore.current().config;
  const configReloader = new ConfigReloader({
    loaded,
    store: configStore,
    modelSwitcher: new AgentModelSwitcher(configStore),
    secrets: new SecretStore(),
    validateAgentModel: () => undefined,
    onPublished: () => {
      const next = configStore.current().config;
      publishStickerSets(
        {
          store,
          abortInvocations: (ids, reason) => {
            aborts.push({ ids, reason });
            return ids.length;
          },
          stickers: () => ({ refresh: async () => void refreshes++ }),
          onRefreshFailed: () => undefined,
        },
        publishedConfig,
        next,
      );
      publishedConfig = next;
    },
  });
  const server = new AdminServer({ store, configStore, configReloader });
  try {
    expect((await server.handle(request('/api/sticker-sets'))).status).toBe(401);
    const cookie = sessionCookie(
      await server.handle(post('/api/auth/setup', { username: 'owner', password: PASSWORD })),
    );
    let revision = await readConfigRevision(configPath);
    const write = (path: string, method: string, body?: unknown, ifMatch: string | null = revision): Request =>
      request(path, {
        method,
        headers: {
          cookie,
          ...(ifMatch === null ? {} : { 'if-match': ifMatch }),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });

    const empty = await readJson(await server.handle(request('/api/sticker-sets', { headers: { cookie } })));
    expect(empty).toEqual({ items: [], revision });

    const cats = { name: 'https://t.me/addstickers/CatPack', alias: 'cats', note: '  Teasing friends  ' };
    expect((await server.handle(write('/api/sticker-sets', 'POST', cats, null))).status).toBe(400);
    const stale = await server.handle(write('/api/sticker-sets', 'POST', cats, 'stale'));
    expect(stale.status).toBe(409);
    expect(await readJson(stale)).toMatchObject({ error: 'config_conflict' });
    const badAlias = await server.handle(write('/api/sticker-sets', 'POST', { ...cats, alias: '1cats' }));
    expect(await readJson(badAlias)).toMatchObject({ error: 'invalid_body' });
    const badName = await server.handle(write('/api/sticker-sets', 'POST', { ...cats, name: 'cat pack!' }));
    expect(await readJson(badName)).toMatchObject({ error: 'invalid_sticker_set_name' });
    const longNote = await server.handle(write('/api/sticker-sets', 'POST', { ...cats, note: 'x'.repeat(501) }));
    expect(await readJson(longNote)).toMatchObject({ error: 'invalid_note' });
    expect(aborts).toEqual([]);

    const added = await readJson(await server.handle(write('/api/sticker-sets', 'POST', cats)));
    expect(added.apply.applied).toContain('telegram.sticker_sets');
    // Hot: the running configuration already has the set, and the file keeps it.
    expect(configStore.current().config.telegram.sticker_sets).toEqual([
      { alias: 'cats', name: 'CatPack', note: 'Teasing friends' },
    ]);
    expect((await loadConfig(configPath)).config.telegram.sticker_sets).toEqual([
      { alias: 'cats', name: 'CatPack', note: 'Teasing friends' },
    ]);
    expect(added.items).toHaveLength(1);
    expect(added.items[0]).toMatchObject({
      alias: 'cats',
      telegram_name: 'CatPack',
      note: 'Teasing friends',
      configured: true,
      sync_state: 'pending',
    });
    const setId: string = added.items[0].id;
    // Adding a set stops the running Telegram reply only; the room run goes on.
    expect(aborts).toEqual([{ ids: [telegramRun], reason: 'sticker_sets_changed' }]);
    expect(aborts.flatMap((abort) => abort.ids)).not.toContain(room.invocationId);
    expect(refreshes).toBe(1);
    revision = added.revision;

    const sameSet = await server.handle(write('/api/sticker-sets', 'POST', { name: 'catpack', alias: 'other' }));
    expect(sameSet.status).toBe(409);
    expect(await readJson(sameSet)).toMatchObject({ error: 'sticker_set_exists' });
    const sameAlias = await server.handle(write('/api/sticker-sets', 'POST', { name: 'DogPack', alias: 'cats' }));
    expect(await readJson(sameAlias)).toMatchObject({ error: 'sticker_set_alias_taken' });

    const repoint = await server.handle(write('/api/sticker-sets/cats', 'PUT', { name: 'DogPack' }));
    expect(repoint.status).toBe(400);
    expect(await readJson(repoint)).toMatchObject({ error: 'sticker_set_name_immutable' });
    expect((await server.handle(write('/api/sticker-sets/nope', 'PUT', { note: 'x' }))).status).toBe(404);

    const renamed = await readJson(
      await server.handle(write('/api/sticker-sets/cats', 'PUT', { alias: 'kitties', note: 'Cute moments only' })),
    );
    expect(renamed.items).toHaveLength(1);
    expect(renamed.items[0]).toMatchObject({ id: setId, alias: 'kitties', note: 'Cute moments only' });
    // A rename reaches the next catalog; it stops nothing.
    expect(aborts).toHaveLength(1);
    revision = renamed.revision;

    const unchanged = await readJson(
      await server.handle(write('/api/sticker-sets/kitties', 'PUT', { note: 'Cute moments only' })),
    );
    expect(unchanged.apply.applied).toEqual([]);
    const noteCleared = await readJson(await server.handle(write('/api/sticker-sets/kitties', 'PUT', { note: null })));
    expect(noteCleared.items[0]).toMatchObject({ id: setId, note: null });
    expect(configStore.current().config.telegram.sticker_sets).toEqual([{ alias: 'kitties', name: 'CatPack' }]);
    revision = noteCleared.revision;

    expect((await server.handle(write('/api/sticker-sets/cats', 'DELETE'))).status).toBe(404);
    const removed = await readJson(await server.handle(write('/api/sticker-sets/kitties', 'DELETE')));
    expect(configStore.current().config.telegram.sticker_sets).toBeUndefined();
    // The row and its index stay for a re-add; only the configured flag drops.
    expect(removed.items).toEqual([expect.objectContaining({ id: setId, configured: false })]);
    expect(aborts).toHaveLength(2);
    expect(aborts[1]).toEqual({ ids: [telegramRun], reason: 'sticker_sets_changed' });
  } finally {
    store.close();
  }
});
