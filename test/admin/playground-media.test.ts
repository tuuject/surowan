/**
 * Admin Playground API: pictures, the image switch and mixed-host lists.
 *
 * Content reads serve the stored bytes, the image switch is revisioned, and a
 * room never leaks into the Telegram-scoped admin lists.
 */
import { expect, test } from 'vitest';
import { readdir } from 'node:fs/promises';
import sharp from 'sharp';
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
  request,
  roomState,
  sendMessage,
  uploadPicture,
} from './playground-fixtures.ts';
import { invocations, messages, playgroundAssets } from '../../src/store/schema/index.ts';

test('uploads a picture, serves its bytes and refuses what the store rejects', async () => {
  const f = await fixture();
  try {
    const room = await createRoom(f, 'Room', 'r');
    const png = Buffer.from(
      await sharp({ create: { width: 3, height: 2, channels: 3, background: { r: 4, g: 5, b: 6 } } })
        .png()
        .toBuffer(),
    );

    const uploaded = await f.server.handle(
      post(
        `/api/playground/rooms/${room.id}/assets`,
        { content_base64: png.toString('base64'), mime: 'image/png', name: 'room.png' },
        f.cookie,
      ),
    );
    expect(uploaded.status).toBe(201);
    const asset = await readJson<{ asset_id: string; mime: string; byte_size: number }>(uploaded);
    expect(asset).toMatchObject({ mime: 'image/png', byte_size: png.byteLength });

    const staged = await readJson<{ items: { asset_id: string }[] }>(
      await f.server.handle(get(`/api/playground/rooms/${room.id}/assets`, f.cookie)),
    );
    expect(staged.items.map((item) => item.asset_id)).toEqual([asset.asset_id]);

    const content = await f.server.handle(
      get(`/api/playground/rooms/${room.id}/assets/${asset.asset_id}/content`, f.cookie),
    );
    expect(content.status).toBe(200);
    expect(content.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await content.arrayBuffer()).equals(png)).toBe(true);

    // The upload is not a message yet: it waits as a staged asset the room's
    // sweep may drop once it is an hour old.
    expect(f.store.orm.select().from(playgroundAssets).all()).toHaveLength(1);
    expect(f.store.orm.select().from(messages).all()).toHaveLength(0);
    const roomDetail = await roomState(f, room.id);
    expect(roomDetail.staged_assets.map((item) => item.asset_id)).toEqual([asset.asset_id]);

    const notAnImage = await f.server.handle(
      post(
        `/api/playground/rooms/${room.id}/assets`,
        {
          content_base64: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64'),
          mime: 'image/png',
        },
        f.cookie,
      ),
    );
    expect(notAnImage.status).toBe(422);
    expect((await readJson<{ error: string }>(notAnImage)).error).toMatch(/^upload_/);
    expect(f.store.orm.select().from(playgroundAssets).all()).toHaveLength(1);
    const files = await readdir(f.assetsRoot, { recursive: true });
    expect(files.filter((entry) => entry.endsWith('.png'))).toHaveLength(1);

    // One element over the size cap is refused by itself (no "at least one" rule).
    const oversized = await f.server.handle(
      post(
        `/api/playground/rooms/${room.id}/assets`,
        { content_base64: Buffer.alloc(10 * 1024 * 1024 + 1, 7).toString('base64'), mime: 'image/png' },
        f.cookie,
      ),
    );
    expect(oversized.status).toBe(422);
    expect(await readJson(oversized)).toMatchObject({ error: 'upload_too_large' });
    expect(f.store.orm.select().from(playgroundAssets).all()).toHaveLength(1);

    // Content reads are authenticated like every other playground route.
    const anonymous = await f.server.handle(
      request(`/api/playground/rooms/${room.id}/assets/${asset.asset_id}/content`),
    );
    expect(anonymous.status).toBe(401);
  } finally {
    f.store.close();
  }
});

test('flips the image switch with a revision and keeps it attributed', async () => {
  const f = await fixture();
  try {
    const room = await createRoom(f, 'Room', 'r');
    const enabled = await f.server.handle(
      put(`/api/playground/rooms/${room.id}/capabilities`, { image_enabled: true, revision: room.revision }, f.cookie),
    );
    expect(enabled.status).toBe(200);
    expect(await readJson(enabled)).toMatchObject({
      room: { image_enabled: true, image_enabled_by: 'owner', revision: '2' },
    });

    const stale = await f.server.handle(
      put(`/api/playground/rooms/${room.id}/capabilities`, { image_enabled: false, revision: room.revision }, f.cookie),
    );
    expect(stale.status).toBe(409);
    expect(await readJson(stale)).toMatchObject({ error: 'room_revision_mismatch' });
    expect(f.rooms.room(BigInt(room.id)).imageEnabled).toBe(true);

    // Setting the value it already has is a no-op, so a retried request does
    // not fail on the revision it just created.
    const idempotent = await f.server.handle(
      put(`/api/playground/rooms/${room.id}/capabilities`, { image_enabled: true, revision: room.revision }, f.cookie),
    );
    expect(idempotent.status).toBe(200);
    expect(await readJson(idempotent)).toMatchObject({ room: { revision: '2' } });
  } finally {
    f.store.close();
  }
});

test('mixed room data does not break the existing Telegram-scoped lists', async () => {
  const f = await fixture();
  try {
    const room = await createRoom(f, 'Mixed', 'r');
    const ada = await addMember(f, room.id, 'Ada', 'm-1');
    await sendMessage(f, room.id, { request_key: 'msg-1', sender_id: ada, text: 'hello room' });
    const state = await roomState(f, room.id);
    const released = await readJson<{ invocation_id: string }>(
      await release(f, room.id, {
        request_key: 'rel-1',
        revision: state.room.revision,
        through_seq: latestSeq(state),
      }),
    );
    expect(released.invocation_id).not.toBeNull();

    for (const path of [
      '/api/invocations',
      '/api/contexts',
      '/api/messages',
      '/api/chats',
      '/api/memories?state=active',
      '/api/overview',
      '/api/usage',
    ]) {
      const response = await f.server.handle(get(path, f.cookie));
      expect(response.status, `${path} must survive mixed hosts`).toBe(200);
    }

    // The Telegram-scoped lists do not present the room as a Telegram chat, and
    // the room's run is not a Telegram run.
    const invocationsList = await readJson<{ items: { chat?: { id?: string } }[] }>(
      await f.server.handle(get('/api/invocations', f.cookie)),
    );
    expect(invocationsList.items.every((item) => item.chat?.id !== room.id)).toBe(true);
    const chatsList = await readJson<{ items: { id?: string }[] }>(await f.server.handle(get('/api/chats', f.cookie)));
    expect(chatsList.items.some((item) => item.id === room.id)).toBe(false);
    const messagesList = await readJson<{ items: { chat_id?: string; chat?: { id?: string } }[] }>(
      await f.server.handle(get('/api/messages', f.cookie)),
    );
    expect(messagesList.items.some((item) => (item.chat_id ?? item.chat?.id) === room.id)).toBe(false);
  } finally {
    f.store.close();
  }
});

test('the timeline gives each message only its own pictures', async () => {
  const f = await fixture();
  try {
    const room = await createRoom(f, 'Room', 'r', [{ name: 'Ada' }]);
    const ada = (await roomState(f, room.id)).participants[0]!.id;
    const picture = await uploadPicture(f, room.id, 4);
    await sendMessage(f, room.id, { request_key: 'img', sender_id: ada, text: 'look', asset_ids: [picture] });
    await sendMessage(f, room.id, { request_key: 'txt-1', sender_id: ada, text: 'nice' });
    await sendMessage(f, room.id, { request_key: 'txt-2', sender_id: ada, text: 'yes' });
    const timeline = await readJson<{ items: { text: string; media: { asset_id: string }[] }[] }>(
      await f.server.handle(get(`/api/playground/rooms/${room.id}/messages`, f.cookie)),
    );
    expect(timeline.items.map((item) => [item.text, item.media.map((entry) => entry.asset_id)])).toEqual([
      ['yes', []],
      ['nice', []],
      ['look', [picture]],
    ]);
  } finally {
    f.store.close();
  }
});

test('a picture message replays from its key after retention removed the picture', async () => {
  const f = await fixture();
  try {
    const room = await createRoom(f, 'Room', 'r', [{ name: 'Ada' }]);
    const ada = (await roomState(f, room.id)).participants[0]!.id;
    const picture = await uploadPicture(f, room.id, 9);
    const body = { request_key: 'img', sender_id: ada, text: 'look', asset_ids: [picture] };
    const admitted = await readJson<{ input_id: string; seq: string }>(await sendMessage(f, room.id, body));
    const state = await roomState(f, room.id);
    await release(f, room.id, { request_key: 'rel', revision: state.room.revision, through_seq: latestSeq(state) });

    // Retention drops the released message (the input row stays as a
    // tombstone), and the sweep then drops the picture nothing references.
    f.store.orm.delete(invocations).run();
    f.store.orm.delete(messages).run();
    await f.assets.sweep({ staleAfterMs: -1 });
    expect(f.store.orm.select().from(playgroundAssets).all()).toHaveLength(0);

    const replay = await sendMessage(f, room.id, body);
    expect(replay.status).toBe(200);
    expect(await readJson(replay)).toMatchObject({ input_id: admitted.input_id, seq: admitted.seq, admitted: false });
    // Other content under the same key is still a conflict.
    const changed = await sendMessage(f, room.id, { ...body, text: 'changed' });
    expect(changed.status).toBe(409);
  } finally {
    f.store.close();
  }
});
