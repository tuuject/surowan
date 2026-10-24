import { afterAll, describe, expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { loadConfig } from '../src/adapters/local-monolith/config.ts';
import { SqliteStore } from '../src/adapters/local-monolith/database.ts';
import { PlaygroundIngress } from '../src/ingress/playground.ts';
import { PlaygroundStore } from '../src/store/playground.ts';
import {
  buckets,
  invocationMessages,
  invocations,
  media,
  messageRevisions,
  messages,
  playgroundAssets,
  playgroundInputs,
  playgroundRetries,
  roomParticipants,
  senders,
} from '../src/store/schema.ts';
import { purgeExpiredData } from '../src/store/store.ts';
import type { RawConfig } from '../src/platform/config.ts';
import { writeTestConfig } from './helpers.ts';
import { PlaygroundError } from '../src/store/playground/shared.ts';

const directories: string[] = [];

afterAll(async () => {
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
  );
});

async function fixture(): Promise<{
  store: SqliteStore;
  config: RawConfig;
  room: { chatId: bigint; conversationId: bigint; members: readonly { senderId: bigint; name: string }[] };
}> {
  const directory = await mkdtemp(join(tmpdir(), 'surowan-playground-ingest-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(directory, configPath);
  const loaded = await loadConfig(configPath);
  const store = await SqliteStore.open(loaded.config);
  const playground = new PlaygroundStore(store.orm);
  const room = playground.createRoom({
    title: 'Test Room',
    members: [{ name: 'Alice', role: 'admin' }, { name: 'Bob' }],
  });
  return { store, room, config: loaded.config };
}

function expectCode(run: () => unknown, code: string): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(PlaygroundError);
    expect((error as PlaygroundError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

describe('playground ingestion', () => {
  test('admits each request key once and keeps held inputs invisible', async () => {
    const { store, room } = await fixture();
    const playground = new PlaygroundStore(store.orm);

    const first = playground.submit(room.chatId, {
      requestKey: 'req-1',
      senderId: room.members[0]!.senderId,
      text: 'hello',
    });
    const replay = playground.submit(room.chatId, {
      requestKey: 'req-1',
      senderId: room.members[0]!.senderId,
      text: 'hello',
    });
    const second = playground.submit(room.chatId, {
      requestKey: 'req-2',
      senderId: room.members[1]!.senderId,
      text: 'hi',
    });

    expect(first.admitted).toBe(true);
    expect(replay.admitted).toBe(false);
    expect(replay.seq).toBe(first.seq);
    expect(second.seq).toBe(first.seq + 1n);
    expect(playground.status(room.chatId).held).toHaveLength(2);
    // A held input has no bucket, invocation or snapshot.
    expect(store.orm.select().from(buckets).all()).toHaveLength(0);
    expect(store.orm.select().from(invocations).all()).toHaveLength(0);
    expect(store.orm.select().from(invocationMessages).all()).toHaveLength(0);
    expectCode(
      () =>
        playground.submit(room.chatId, {
          requestKey: 'req-1',
          senderId: room.members[0]!.senderId,
          text: 'different body',
        }),
      'input_conflict',
    );
  });

  test('a release at the wrong revision is refused and keeps the hold', async () => {
    const { store, room } = await fixture();
    const playground = new PlaygroundStore(store.orm);
    playground.submit(room.chatId, {
      requestKey: 'req-1',
      senderId: room.members[0]!.senderId,
      text: 'hello',
    });
    const roomState = playground.room(room.chatId);

    expectCode(
      () => playground.release(room.chatId, { releaseKey: 'rel-1', revision: roomState.revision - 1n }),
      'room_revision_mismatch',
    );
    expect(playground.room(room.chatId).hold).toBe(true);
    expect(store.orm.select().from(buckets).all()).toHaveLength(0);
  });

  test('a release seals one queued invocation with a frozen room snapshot', async () => {
    const { store, room } = await fixture();
    const playground = new PlaygroundStore(store.orm);
    const alice = room.members[0]!.senderId;
    playground.submit(room.chatId, { requestKey: 'req-1', senderId: alice, text: 'first' });
    playground.submit(room.chatId, { requestKey: 'req-2', senderId: alice, text: 'second' });
    const revision = playground.room(room.chatId).revision;

    const release = playground.release(room.chatId, { releaseKey: 'rel-1', revision });
    expect(release.replayed).toBe(false);
    expect(release.invocationId).not.toBeNull();
    const bucket = store.orm.select().from(buckets).all()[0];
    expect(bucket?.state).toBe('queued');
    const invocation = store.orm.select().from(invocations).all()[0];
    expect(invocation?.state).toBe('queued');
    const snapshots = store.orm.select().from(invocationMessages).all();
    expect(snapshots).toHaveLength(2);
    expect(snapshots.map((row) => row.snapshotFormat)).toEqual([
      'plasticwan.invocation-snapshot.playground.v1',
      'plasticwan.invocation-snapshot.playground.v1',
    ]);
    expect(JSON.parse(snapshots[0]!.snapshotJson)).toMatchObject({
      host: 'playground',
      message_id: '1',
      text: 'first',
      sender: { ref: `member_${alice}`, name: 'Alice' },
    });

    const replay = playground.release(room.chatId, { releaseKey: 'rel-1', revision });
    expect(replay.replayed).toBe(true);
    expect(replay.invocationId).toBe(release.invocationId);
    expect(store.orm.select().from(invocations).all()).toHaveLength(1);
  });

  test('a competing release on the same revision is refused', async () => {
    const { store, room } = await fixture();
    const playground = new PlaygroundStore(store.orm);
    playground.submit(room.chatId, {
      requestKey: 'req-1',
      senderId: room.members[0]!.senderId,
      text: 'hello',
    });
    const revision = playground.room(room.chatId).revision;
    playground.release(room.chatId, { releaseKey: 'rel-a', revision });
    expectCode(() => playground.release(room.chatId, { releaseKey: 'rel-b', revision }), 'release_conflict');
    expect(store.orm.select().from(invocations).all()).toHaveLength(1);
  });

  test('a later input opens a new batch and only it is sealed', async () => {
    const { store, room } = await fixture();
    const playground = new PlaygroundStore(store.orm);
    const alice = room.members[0]!.senderId;
    playground.submit(room.chatId, { requestKey: 'req-1', senderId: alice, text: 'first' });
    playground.release(room.chatId, { releaseKey: 'rel-1', revision: playground.room(room.chatId).revision });
    const later = playground.submit(room.chatId, { requestKey: 'req-2', senderId: alice, text: 'later' });
    const release = playground.release(room.chatId, {
      releaseKey: 'rel-2',
      revision: playground.room(room.chatId).revision,
    });
    expect(later.admitted).toBe(true);
    expect(release.throughSeq).toBe(later.seq);
    const secondInvocation = store.orm.select().from(invocations).all()[1];
    const snapshots = store.orm
      .select()
      .from(invocationMessages)
      .where(eq(invocationMessages.invocationId, secondInvocation!.id))
      .all();
    expect(snapshots.map((row) => JSON.parse(row.snapshotJson).text)).toEqual(['later']);
  });

  test('an admitted message points at its own revision', async () => {
    const { store, room } = await fixture();
    const playground = new PlaygroundStore(store.orm);
    playground.submit(room.chatId, {
      requestKey: 'req-1',
      senderId: room.members[0]!.senderId,
      text: 'hello',
    });
    const message = store.orm.select().from(messages).where(eq(messages.chatId, room.chatId)).get();
    if (message === undefined) {
      throw new Error('the input was not admitted');
    }
    const revision = store.orm.select().from(messageRevisions).where(eq(messageRevisions.messageId, message.id)).get();
    // Every reader joins the current revision, so an admitted message without
    // the pointer would be invisible to the timeline and to any audit view.
    expect(message.currentRevisionId).toBe(revision?.id);
    expect(revision?.text).toBe('hello');
  });

  test('an empty release only closes the hold', async () => {
    const { store, room } = await fixture();
    const playground = new PlaygroundStore(store.orm);
    const revision = playground.room(room.chatId).revision;
    const release = playground.release(room.chatId, { releaseKey: 'rel-empty', revision });
    expect(release.invocationId).toBeNull();
    expect(playground.room(room.chatId).hold).toBe(false);
    expect(store.orm.select().from(invocations).all()).toHaveLength(0);
  });

  test('a retry copies a clean terminated snapshot and refuses side effects', async () => {
    const { store, room } = await fixture();
    const playground = new PlaygroundStore(store.orm);
    playground.submit(room.chatId, {
      requestKey: 'req-1',
      senderId: room.members[0]!.senderId,
      text: 'hello',
    });
    const release = playground.release(room.chatId, {
      releaseKey: 'rel-1',
      revision: playground.room(room.chatId).revision,
    });
    const invocationId = release.invocationId!;
    store.orm
      .update(invocations)
      .set({ state: 'failed', errorCode: 'crashed', finishedAt: '2026-10-17T10:01:00.000Z' })
      .where(eq(invocations.id, invocationId))
      .run();

    const retry = playground.retry(room.chatId, { releaseId: release.releaseId, attemptKey: 'try-1' });
    expect(retry.invocationId).not.toBe(invocationId);
    const copied = store.orm
      .select()
      .from(invocationMessages)
      .where(eq(invocationMessages.invocationId, retry.invocationId))
      .all();
    expect(copied).toHaveLength(1);
    const replay = playground.retry(room.chatId, { releaseId: release.releaseId, attemptKey: 'try-1' });
    expect(replay.replayed).toBe(true);
    expect(replay.invocationId).toBe(retry.invocationId);

    // A latest attempt with a side effect is refused.
    store.orm
      .update(invocations)
      .set({ state: 'failed', sendsUsed: 1n })
      .where(eq(invocations.id, retry.invocationId))
      .run();
    expectCode(
      () => playground.retry(room.chatId, { releaseId: release.releaseId, attemptKey: 'try-2' }),
      'retry_refused',
    );
  });

  test('a second attempt key cannot queue a release that is already being retried', async () => {
    const { store, room } = await fixture();
    const playground = new PlaygroundStore(store.orm);
    playground.submit(room.chatId, {
      requestKey: 'req-1',
      senderId: room.members[0]!.senderId,
      text: 'hello',
    });
    const release = playground.release(room.chatId, {
      releaseKey: 'rel-1',
      revision: playground.room(room.chatId).revision,
    });
    store.orm
      .update(invocations)
      .set({ state: 'failed', errorCode: 'crashed', finishedAt: '2026-10-17T10:01:00.000Z' })
      .where(eq(invocations.id, release.invocationId!))
      .run();
    const first = playground.retry(room.chatId, { releaseId: release.releaseId, attemptKey: 'try-1' });

    // The first attempt is still queued: the original stays failed and clean,
    // but it is no longer the attempt that decides.
    expectCode(
      () => playground.retry(room.chatId, { releaseId: release.releaseId, attemptKey: 'try-2' }),
      'retry_refused',
    );
    // Once that attempt failed cleanly, the next one retries it, not the original.
    store.orm.update(invocations).set({ state: 'failed' }).where(eq(invocations.id, first.invocationId)).run();
    const second = playground.retry(room.chatId, { releaseId: release.releaseId, attemptKey: 'try-2' });
    const recorded = store.orm
      .select({ retryOf: playgroundRetries.retryOfInvocationId })
      .from(playgroundRetries)
      .where(eq(playgroundRetries.invocationId, second.invocationId))
      .get();
    expect(recorded?.retryOf).toBe(first.invocationId);
    expect(store.orm.select().from(invocations).all()).toHaveLength(3);
  });

  test('only a human member of the room may submit', async () => {
    const { store, room } = await fixture();
    const playground = new PlaygroundStore(store.orm);
    const other = playground.createRoom({ title: 'Other Room', members: [{ name: 'Mallory' }] });
    const bot = store.orm
      .insert(senders)
      .values({ hostKind: 'playground', displayName: 'Bot', isBot: true, updatedAt: '2026-10-17T10:00:00.000Z' })
      .returning({ id: senders.id })
      .get()!;
    store.orm
      .insert(roomParticipants)
      .values({ chatId: room.chatId, senderId: bot.id, role: 'admin', joinedAt: '2026-10-17T10:00:00.000Z' })
      .run();

    for (const senderId of [other.members[0]!.senderId, bot.id, 999_999n]) {
      expectCode(
        () => playground.submit(room.chatId, { requestKey: `req-${senderId}`, senderId, text: 'hi' }),
        'unknown_sender',
      );
    }
    expect(playground.status(room.chatId).held).toHaveLength(0);
    expect(playground.room(room.chatId).nextSeq).toBe(1n);
  });

  test('a message cannot carry an asset of another room', async () => {
    const { store, room } = await fixture();
    const playground = new PlaygroundStore(store.orm);
    const other = playground.createRoom({ title: 'Other Room', members: [{ name: 'Mallory' }] });
    const sha256 = 'a'.repeat(64);
    store.orm
      .insert(playgroundAssets)
      .values({
        id: 'b'.repeat(32),
        chatId: other.chatId,
        sha256,
        mime: 'image/png',
        byteSize: 10n,
        width: 1n,
        height: 1n,
        storagePath: `${other.chatId}/${'b'.repeat(32)}.png`,
        state: 'staged',
        createdAt: '2026-10-17T10:00:00.000Z',
      })
      .run();
    const asset = { assetId: 'b'.repeat(32), sha256, mime: 'image/png', byteSize: 10, width: 1, height: 1 };

    for (const item of [asset, { ...asset, assetId: 'c'.repeat(32) }]) {
      expectCode(
        () =>
          playground.submit(room.chatId, {
            requestKey: `req-${item.assetId}`,
            senderId: room.members[0]!.senderId,
            text: '',
            media: [item],
          }),
        'unknown_asset',
      );
    }
    expect(store.orm.select().from(media).all()).toHaveLength(0);
    expect(store.orm.select().from(playgroundAssets).get()?.state).toBe('staged');
  });

  test('retention expires a held input visibly and keeps its request key', async () => {
    const { store, room, config } = await fixture();
    const playground = new PlaygroundStore(store.orm);
    const alice = room.members[0]!.senderId;
    playground.submit(room.chatId, { requestKey: 'req-old', senderId: alice, text: 'long held' });

    purgeExpiredData(store.orm, config, new Date(Date.now() + (config.retention.online_days + 1) * 86_400_000));

    const status = playground.status(room.chatId);
    expect(status.held).toHaveLength(0);
    expect(status.expiredInputs).toBe(1);
    const tombstone = store.orm.select().from(playgroundInputs).all();
    expect(tombstone).toMatchObject([{ requestKey: 'req-old', state: 'expired', messageId: null }]);
    // The key still names the first admission: neither its replay nor a new
    // body under it admits a second message.
    expect(playground.submit(room.chatId, { requestKey: 'req-old', senderId: alice, text: 'long held' })).toMatchObject(
      { admitted: false, seq: 1n },
    );
    expectCode(
      () => playground.submit(room.chatId, { requestKey: 'req-old', senderId: alice, text: 'other' }),
      'input_conflict',
    );
    // An expired input is never sealed by a later release.
    const release = playground.release(room.chatId, {
      releaseKey: 'rel-1',
      revision: playground.room(room.chatId).revision,
    });
    expect(release.invocationId).toBeNull();
  });

  test('queued work expires visibly instead of re-releasing', async () => {
    const { store, room } = await fixture();
    const playground = new PlaygroundStore(store.orm);
    playground.submit(room.chatId, {
      requestKey: 'req-1',
      senderId: room.members[0]!.senderId,
      text: 'hello',
    });
    playground.release(room.chatId, { releaseKey: 'rel-1', revision: playground.room(room.chatId).revision });
    const later = new Date(Date.now() + 10 * 60_000);
    expect(playground.expireQueued(later)).toBe(1);
    const release = playground.status(room.chatId).releases[0];
    expect(release?.invocationState).toBe('failed');
    expect(release?.invocationErrorCode).toBe('queued_expired');
  });

  test('a released snapshot keeps the time each input was admitted', async () => {
    const { store, room } = await fixture();
    let now = new Date('2026-10-17T10:00:00.000Z');
    const playground = new PlaygroundStore(store.orm, () => now);
    const alice = room.members[0]!.senderId;
    playground.submit(room.chatId, { requestKey: 'req-1', senderId: alice, text: 'early' });
    now = new Date('2026-10-17T11:30:00.000Z');
    playground.submit(room.chatId, { requestKey: 'req-2', senderId: alice, text: 'later' });
    now = new Date('2026-10-17T14:00:00.000Z');
    playground.release(room.chatId, { releaseKey: 'rel-1', revision: playground.room(room.chatId).revision });

    const sentAt = store.orm
      .select()
      .from(invocationMessages)
      .all()
      .map((row) => JSON.parse(row.snapshotJson).sent_at);
    expect(sentAt).toEqual(['2026-10-17T10:00:00.000Z', '2026-10-17T11:30:00.000Z']);
  });

  test('the ingress refuses ids SQLite cannot bind or a number already rounded', async () => {
    const { store, room } = await fixture();
    const ingress = new PlaygroundIngress(store.orm);
    for (const senderId of ['9223372036854775808', '99999999999999999999', 2 ** 53 + 2, -1, 1.5]) {
      await expect(
        ingress.submit(room.chatId, { requestKey: `req-${senderId}`, senderId, text: 'hi' }),
      ).rejects.toMatchObject({ code: 'input_conflict' });
    }
    await expect(
      ingress.submit(room.chatId, { requestKey: 'req-max', senderId: '9223372036854775807', text: 'hi' }),
    ).rejects.toMatchObject({ code: 'unknown_sender' });
  });

  test('the ingress validates keys and decimal ids before writing', async () => {
    const { store, room } = await fixture();
    const ingress = new PlaygroundIngress(store.orm);
    await expect(
      ingress.submit(room.chatId, { requestKey: 'req-1', senderId: 'nope', text: 'hi' }),
    ).rejects.toMatchObject({ code: 'input_conflict' });
    const submitted = await ingress.submit(room.chatId, {
      requestKey: 'req-1',
      senderId: room.members[0]!.senderId,
      text: 'hi',
    });
    expect(submitted.admitted).toBe(true);
    expect(ingress.status(room.chatId).held).toHaveLength(1);
  });
});
