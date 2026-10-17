import { afterAll, describe, expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { loadConfig } from '../src/adapters/local-monolith/config.ts';
import { SqliteStore } from '../src/adapters/local-monolith/database.ts';
import { PlaygroundIngress } from '../src/ingress/playground.ts';
import { PlaygroundError, PlaygroundStore } from '../src/store/playground.ts';
import { buckets, invocationMessages, invocations } from '../src/store/schema.ts';
import { writeTestConfig } from './helpers.ts';

const directories: string[] = [];

afterAll(async () => {
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
  );
});

async function fixture(): Promise<{
  store: SqliteStore;
  room: { chatId: bigint; conversationId: bigint; members: readonly { senderId: bigint; name: string }[] };
}> {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-playground-ingest-'));
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
  return { store, room };
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

    // A retried invocation with a side effect is refused.
    store.orm.update(invocations).set({ sendsUsed: 1n }).where(eq(invocations.id, invocationId)).run();
    store.orm.update(invocations).set({ state: 'failed' }).where(eq(invocations.id, retry.invocationId)).run();
    expectCode(
      () => playground.retry(room.chatId, { releaseId: release.releaseId, attemptKey: 'try-2' }),
      'retry_refused',
    );
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
