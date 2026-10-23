/**
 * Admin Playground API: Releases, invocations and retries.
 *
 * A Release seals a boundary once per key, queues at most one attempt, and a
 * retry names one attempt of one Release.
 */
import { expect, test } from 'vitest';
import {
  addMember,
  createRoom,
  fixture,
  get,
  latestSeq,
  post,
  put,
  readJson,
  release,
  roomState,
  sendMessage,
} from './admin-playground-fixtures.ts';
import { invocations, rooms } from '../src/store/schema.ts';

test('holds, releases once per key and refuses a stale boundary', async () => {
  const f = await fixture();
  try {
    const room = await createRoom(f, 'Room', 'r');
    const ada = await addMember(f, room.id, 'Ada', 'm-1');

    // An empty release seals nothing, queues nothing and still closes the hold.
    const fresh = await roomState(f, room.id);
    const empty = await release(f, room.id, {
      request_key: 'rel-empty',
      revision: fresh.room.revision,
      through_seq: latestSeq(fresh),
    });
    expect(empty.status).toBe(201);
    expect(await readJson(empty)).toMatchObject({ invocation_id: null, replayed: false });
    expect(f.store.orm.select().from(invocations).all()).toHaveLength(0);

    const emptyReplay = await release(f, room.id, {
      request_key: 'rel-empty',
      revision: fresh.room.revision,
      through_seq: latestSeq(fresh),
    });
    expect(emptyReplay.status).toBe(200);
    expect(await readJson(emptyReplay)).toMatchObject({ replayed: true, invocation_id: null });

    await sendMessage(f, room.id, { request_key: 'msg-1', sender_id: ada, text: 'one' });
    await sendMessage(f, room.id, { request_key: 'msg-2', sender_id: ada, text: 'two' });

    // Hold is open-only: closing it is a Release.
    const throughHold = await f.server.handle(put(`/api/playground/rooms/${room.id}/hold`, { hold: false }, f.cookie));
    expect(throughHold.status).toBe(400);
    expect(await readJson(throughHold)).toMatchObject({ error: 'release_required' });
    const opened = await f.server.handle(put(`/api/playground/rooms/${room.id}/hold`, {}, f.cookie));
    expect(opened.status).toBe(200);
    const afterHold = await roomState(f, room.id);
    expect(afterHold.room.hold).toBe(true);

    // A boundary that is not the room's latest input is refused.
    const stale = await release(f, room.id, {
      request_key: 'rel-1',
      revision: afterHold.room.revision,
      through_seq: '1',
    });
    expect(stale.status).toBe(409);
    expect(await readJson(stale)).toMatchObject({ error: 'release_conflict' });

    const released = await release(f, room.id, {
      request_key: 'rel-1',
      revision: afterHold.room.revision,
      through_seq: latestSeq(afterHold),
    });
    expect(released.status).toBe(201);
    const releaseBody = await readJson<{ release_id: string; invocation_id: string; through_seq: string }>(released);
    expect(releaseBody.invocation_id).not.toBeNull();
    expect(f.store.orm.select().from(invocations).all()).toHaveLength(1);

    const replayAfterReal = await release(f, room.id, {
      request_key: 'rel-1',
      revision: afterHold.room.revision,
      through_seq: latestSeq(afterHold),
    });
    expect(replayAfterReal.status).toBe(200);
    expect(await readJson(replayAfterReal)).toMatchObject({
      replayed: true,
      invocation_id: releaseBody.invocation_id,
    });
    expect(f.store.orm.select().from(invocations).all()).toHaveLength(1);

    const detail = await readJson<{
      release: { through_seq: string; invocation_id: string };
      attempts: { id: string; state: string }[];
      sends: unknown[];
    }>(await f.server.handle(get(`/api/playground/rooms/${room.id}/releases/${releaseBody.release_id}`, f.cookie)));
    expect(detail.release).toMatchObject({
      through_seq: latestSeq(afterHold),
      invocation_id: releaseBody.invocation_id,
    });
    expect(detail.attempts).toHaveLength(1);
    expect(detail.attempts[0]).toMatchObject({ id: releaseBody.invocation_id, state: 'queued' });
    expect(detail.sends).toEqual([]);

    const listed = await readJson<{ items: { id: string }[] }>(
      await f.server.handle(get(`/api/playground/rooms/${room.id}/invocations`, f.cookie)),
    );
    expect(listed.items).toHaveLength(1);
    const one = await readJson<{ invocation: { id: string } }>(
      await f.server.handle(get(`/api/playground/rooms/${room.id}/invocations/${releaseBody.invocation_id}`, f.cookie)),
    );
    expect(one.invocation.id).toBe(releaseBody.invocation_id);

    // A retry is refused while nothing terminal happened, and says why.
    const refusedRetry = await f.server.handle(
      post(
        `/api/playground/rooms/${room.id}/releases/${releaseBody.release_id}/retry`,
        { attempt_key: 'try-1' },
        f.cookie,
      ),
    );
    expect(refusedRetry.status).toBe(409);
    expect(await readJson(refusedRetry)).toMatchObject({ error: 'retry_refused' });
  } finally {
    f.store.close();
  }
});

test('bot output between preparing and sending a Release does not move its boundary', async () => {
  const f = await fixture();
  try {
    const room = await createRoom(f, 'Room', 'r', [{ name: 'Ada' }]);
    const ada = (await roomState(f, room.id)).participants[0]!.id;
    await sendMessage(f, room.id, { request_key: 'msg-1', sender_id: ada, text: 'one' });
    const prepared = await roomState(f, room.id);
    expect(prepared.room.latest_input_seq).toBe('1');
    // An earlier run's reply takes the next room sequence (the host does this)
    // without changing the revision.
    f.store.orm
      .update(rooms)
      .set({ nextSeq: BigInt(prepared.room.next_seq) + 1n })
      .run();
    const released = await release(f, room.id, {
      request_key: 'rel',
      revision: prepared.room.revision,
      through_seq: latestSeq(prepared),
    });
    expect(released.status).toBe(201);
    expect(await readJson(released)).toMatchObject({ through_seq: '1' });
  } finally {
    f.store.close();
  }
});

test('an attempt key names one retry of one release', async () => {
  const f = await fixture();
  try {
    const room = await createRoom(f, 'Room', 'r', [{ name: 'Ada' }]);
    const ada = (await roomState(f, room.id)).participants[0]!.id;
    await sendMessage(f, room.id, { request_key: 'msg-1', sender_id: ada, text: 'one' });
    const state = await roomState(f, room.id);
    const first = await readJson<{ release_id: string; invocation_id: string }>(
      await release(f, room.id, { request_key: 'rel', revision: state.room.revision, through_seq: latestSeq(state) }),
    );
    // A terminal attempt that did nothing is the one retry accepts.
    f.store.orm.update(invocations).set({ state: 'failed', finishedAt: new Date().toISOString() }).run();
    const retryPath = (releaseId: string) => `/api/playground/rooms/${room.id}/releases/${releaseId}/retry`;
    const retried = await f.server.handle(post(retryPath(first.release_id), { attempt_key: 'try-1' }, f.cookie));
    expect(retried.status).toBe(201);
    const retriedBody = await readJson<{ invocation_id: string }>(retried);
    // Both attempts name the Release a retry is addressed by.
    const attempts = await readJson<{ items: { id: string; release_id: string | null }[] }>(
      await f.server.handle(get(`/api/playground/rooms/${room.id}/invocations`, f.cookie)),
    );
    expect(attempts.items.map((item) => [item.id, item.release_id])).toEqual([
      [retriedBody.invocation_id, first.release_id],
      [first.invocation_id, first.release_id],
    ]);
    const replay = await f.server.handle(post(retryPath(first.release_id), { attempt_key: 'try-1' }, f.cookie));
    expect(replay.status).toBe(200);
    expect(await readJson(replay)).toMatchObject({ replayed: true, invocation_id: retriedBody.invocation_id });

    // The same key sent to another release - unknown or not - is refused,
    // never answered with the first release's attempt.
    const invocationsBefore = f.store.orm.select().from(invocations).all().length;
    for (const releaseId of ['999999', (BigInt(first.release_id) + 1n).toString()]) {
      const foreign = await f.server.handle(post(retryPath(releaseId), { attempt_key: 'try-1' }, f.cookie));
      expect(foreign.status).toBe(409);
      expect(await readJson(foreign)).toMatchObject({ error: 'input_conflict' });
    }
    expect(f.store.orm.select().from(invocations).all()).toHaveLength(invocationsBefore);
  } finally {
    f.store.close();
  }
});

test('a release key replays only the revision it released', async () => {
  const f = await fixture();
  try {
    const room = await createRoom(f, 'Room', 'r', [{ name: 'Ada' }]);
    const ada = (await roomState(f, room.id)).participants[0]!.id;
    await sendMessage(f, room.id, { request_key: 'msg-1', sender_id: ada, text: 'one' });
    const before = await roomState(f, room.id);
    const first = await release(f, room.id, {
      request_key: 'rel',
      revision: before.room.revision,
      through_seq: latestSeq(before),
    });
    expect(first.status).toBe(201);

    await sendMessage(f, room.id, { request_key: 'msg-2', sender_id: ada, text: 'two' });
    const after = await roomState(f, room.id);
    expect(after.held).toHaveLength(1);
    const reused = await release(f, room.id, {
      request_key: 'rel',
      revision: after.room.revision,
      through_seq: latestSeq(after),
    });
    expect(reused.status).toBe(409);
    expect(await readJson(reused)).toMatchObject({ error: 'input_conflict' });
    // The newer input is still held and nothing else was queued for it.
    expect((await roomState(f, room.id)).held.map((entry) => entry.seq)).toEqual(after.held.map((entry) => entry.seq));
    expect(f.store.orm.select().from(invocations).all()).toHaveLength(1);
  } finally {
    f.store.close();
  }
});
