/**
 * Admin Playground API: room, identity and message admission.
 *
 * Every write carries a request key and is answered from it; the room detail
 * and timeline report the counters the store really holds.
 */
import { expect, test } from 'vitest';
import {
  addMember,
  createRoom,
  fixture,
  get,
  latestSeq,
  post,
  readJson,
  release,
  request,
  roomState,
  sendMessage,
} from './admin-playground-fixtures.ts';
import { playgroundInputs, playgroundMutations, rooms } from '../src/store/schema.ts';

test('creates rooms and identities under request keys', async () => {
  const f = await fixture();
  try {
    const created = await createRoom(f, 'Room', 'room-1', [{ name: 'Ada' }]);
    const detail = await roomState(f, created.id);
    expect(detail.room).toMatchObject({ title: 'Room', hold: true, image_enabled: false, revision: '1' });
    expect(detail.participants.map((entry) => entry.name)).toEqual(['Ada']);

    const replay = await f.server.handle(
      post('/api/playground/rooms', { title: 'Room', members: [{ name: 'Ada' }], request_key: 'room-1' }, f.cookie),
    );
    expect(replay.status).toBe(200);
    expect(await readJson(replay)).toMatchObject({ replayed: true, room: { id: created.id } });
    expect(f.store.orm.select().from(playgroundMutations).all()).toHaveLength(1);

    const conflicting = await f.server.handle(
      post('/api/playground/rooms', { title: 'Other', request_key: 'room-1' }, f.cookie),
    );
    expect(conflicting.status).toBe(409);
    expect(await readJson(conflicting)).toMatchObject({ error: 'input_conflict' });
    expect(f.store.orm.select().from(rooms).all()).toHaveLength(1);

    const member = await addMember(f, created.id, 'Bo', 'member-1');
    const memberReplay = await f.server.handle(
      post(`/api/playground/rooms/${created.id}/participants`, { name: 'Bo', request_key: 'member-1' }, f.cookie),
    );
    expect(memberReplay.status).toBe(200);
    expect(await readJson(memberReplay)).toMatchObject({ replayed: true, member: { id: member } });

    // The same key in another room is a different admission, not a replay.
    const other = await createRoom(f, 'Second', 'room-2');
    const otherMember = await addMember(f, other.id, 'Bo', 'member-1');
    expect(otherMember).not.toBe(member);
    expect(f.store.orm.select().from(playgroundMutations).all()).toHaveLength(4);
  } finally {
    f.store.close();
  }
});

test('admits messages under request keys and refuses a reused key with other content', async () => {
  const f = await fixture();
  try {
    const room = await createRoom(f, 'Room', 'r');
    const ada = await addMember(f, room.id, 'Ada', 'm-1');

    const first = await sendMessage(f, room.id, { request_key: 'msg-1', sender_id: ada, text: 'hello' });
    expect(first.status).toBe(201);
    const admitted = await readJson<{ input_id: string; seq: string; revision: string; admitted: boolean }>(first);
    expect(admitted).toMatchObject({ seq: '1', admitted: true });

    const replay = await sendMessage(f, room.id, { request_key: 'msg-1', sender_id: ada, text: 'hello' });
    expect(replay.status).toBe(200);
    expect(await readJson(replay)).toMatchObject({ input_id: admitted.input_id, admitted: false });

    const bo = await addMember(f, room.id, 'Bo', 'm-bo');
    for (const changed of [
      { sender_id: ada, text: 'different' },
      { sender_id: bo, text: 'hello' },
      { sender_id: ada, text: 'hello', reply_to_seq: admitted.seq },
    ]) {
      const conflict = await sendMessage(f, room.id, { request_key: 'msg-1', ...changed });
      expect(conflict.status).toBe(409);
      expect(await readJson(conflict)).toMatchObject({ error: 'input_conflict' });
    }
    expect(f.store.orm.select().from(playgroundInputs).all()).toHaveLength(1);

    // A sender of another room is not a member of this one.
    const other = await createRoom(f, 'Other', 'r2');
    const stranger = await addMember(f, other.id, 'Eve', 'm-2');
    const foreign = await sendMessage(f, room.id, { request_key: 'msg-2', sender_id: stranger, text: 'hi' });
    expect(foreign.status).toBe(404);
    expect(await readJson(foreign)).toMatchObject({ error: 'unknown_sender' });
    expect(f.store.orm.select().from(playgroundInputs).all()).toHaveLength(1);

    const timeline = await readJson<{
      items: {
        seq: string;
        text: string;
        input_state: string;
        sender: { id: string; name: string; is_bot: boolean };
      }[];
      has_more: boolean;
      status: { pending: number; revision: string; next_seq: string };
    }>(await f.server.handle(get(`/api/playground/rooms/${room.id}/messages`, f.cookie)));
    expect(timeline.items).toHaveLength(1);
    expect(timeline.items[0]).toMatchObject({
      seq: '1',
      text: 'hello',
      input_state: 'held',
      sender: { id: ada, name: 'Ada', is_bot: false },
    });
    expect(timeline.status).toMatchObject({ pending: 1, revision: '2' });

    // The timeline pages backwards by the room's own sequence numbers, so a
    // page boundary stays stable while new messages arrive.
    await sendMessage(f, room.id, { request_key: 'msg-3', sender_id: ada, text: 'third' });
    const firstPage = await readJson<{
      items: { seq: string; text: string }[];
      has_more: boolean;
    }>(await f.server.handle(get(`/api/playground/rooms/${room.id}/messages?limit=1`, f.cookie)));
    expect(firstPage.items.map((item) => item.seq)).toEqual(['2']);
    expect(firstPage.has_more).toBe(true);
    const secondPage = await readJson<{
      items: { seq: string; text: string }[];
      has_more: boolean;
    }>(
      await f.server.handle(
        get(`/api/playground/rooms/${room.id}/messages?limit=1&before=${firstPage.items[0]!.seq}`, f.cookie),
      ),
    );
    expect(secondPage.items.map((item) => item.text)).toEqual(['hello']);
    expect(secondPage.has_more).toBe(false);
  } finally {
    f.store.close();
  }
});

test('a room-creation replay and the room detail report the real counters', async () => {
  const f = await fixture();
  try {
    const room = await createRoom(f, 'Room', 'r', [{ name: 'Ada' }, { name: 'Bob' }]);
    const ada = (await roomState(f, room.id)).participants[0]!.id;
    await sendMessage(f, room.id, { request_key: 'msg-1', sender_id: ada, text: 'one' });
    const state = await roomState(f, room.id);
    expect(state.room).toMatchObject({ member_count: 2, held_count: 1, queued_invocations: 0, running_invocations: 0 });
    await release(f, room.id, { request_key: 'rel', revision: state.room.revision, through_seq: latestSeq(state) });

    const replay = await f.server.handle(
      post(
        '/api/playground/rooms',
        { title: 'Room', members: [{ name: 'Ada' }, { name: 'Bob' }], request_key: 'r' },
        f.cookie,
      ),
    );
    expect(replay.status).toBe(200);
    expect((await readJson<{ room: unknown; replayed: boolean }>(replay)).room).toMatchObject({
      id: room.id,
      member_count: 2,
      held_count: 0,
      queued_invocations: 1,
      running_invocations: 0,
    });
    expect((await roomState(f, room.id)).room).toMatchObject({ queued_invocations: 1, running_invocations: 0 });
  } finally {
    f.store.close();
  }
});

test('a message at the character limit is admitted whatever its encoded size', async () => {
  const f = await fixture();
  try {
    const room = await createRoom(f, 'Room', 'r', [{ name: 'Ada' }]);
    const ada = (await roomState(f, room.id)).participants[0]!.id;
    // 16K CJK characters are ~48 KB of UTF-8; escaped they are ~96 KB.
    const text = '字'.repeat(16_384);
    const utf8 = await sendMessage(f, room.id, { request_key: 'cjk', sender_id: ada, text });
    expect(utf8.status).toBe(201);
    const escaped = await f.server.handle(
      request(`/api/playground/rooms/${room.id}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: f.cookie },
        body: `{"request_key":"esc","sender_id":"${ada}","text":"${'\\u5b57'.repeat(16_384)}"}`,
      }),
    );
    expect(escaped.status).toBe(201);
    const over = await sendMessage(f, room.id, { request_key: 'over', sender_id: ada, text: `${text}x` });
    expect(over.status).toBe(400);
  } finally {
    f.store.close();
  }
});

test('a room with every member at the name limit fits its creation request', async () => {
  const f = await fixture();
  try {
    const members = Array.from({ length: 64 }, (_, index) => ({ name: `${'名'.repeat(117)}${index + 100}` }));
    const created = await createRoom(f, '名'.repeat(120), 'r', members);
    expect((await roomState(f, created.id)).participants).toHaveLength(64);
  } finally {
    f.store.close();
  }
});
