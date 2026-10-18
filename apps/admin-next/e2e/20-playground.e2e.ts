import { type APIRequestContext, expect } from '@playwright/test';
import { adminUrl, e2eFetch, test } from './helpers.ts';

interface InvocationPayload {
  readonly id: string;
  readonly state: string;
}

/** Polls one room's invocation list until the newest run reaches a terminal state. */
async function waitForRun(request: APIRequestContext, roomId: string): Promise<InvocationPayload> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const listed = (await (
      await request.get(await adminUrl(`/api/playground/rooms/${roomId}/invocations`))
    ).json()) as { items: InvocationPayload[] };
    const latest = listed.items[0];
    if (latest !== undefined && !['queued', 'running'].includes(latest.state)) {
      return latest;
    }
    if (Date.now() > deadline) {
      throw new Error(`the room run did not settle: ${JSON.stringify(latest)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * The Playground API as the panel uses it (T09). The page itself arrives with
 * T11, which extends this spec with the UI cases; what is asserted here is the
 * server contract: a session is required, a programmatic key is not one, the
 * seeded rooms are visible with their held input, one room's ids never answer
 * for another room, and a create is idempotent by key.
 */
test.use({ signedIn: true });

interface SeedPayload {
  readonly rooms: readonly { readonly id: string; readonly title: string }[];
}

function roomAt(seed: SeedPayload, index: number): { readonly id: string; readonly title: string } {
  const room = seed.rooms[index];
  if (room === undefined) {
    throw new Error(`the E2E seed has no room at index ${index}`);
  }
  return room;
}

test('the playground API is session-only and never answers an API key', async ({ request }) => {
  const anonymous = await request.get(await adminUrl('/api/playground/rooms'), {
    headers: { cookie: '' },
  });
  expect(anonymous.status()).toBe(401);

  const withKey = await request.get(await adminUrl('/api/playground/rooms'), {
    headers: { authorization: 'Bearer pwk_e2e_not_a_real_key' },
  });
  expect(withKey.status()).toBe(401);

  const authorized = await request.get(await adminUrl('/api/playground/rooms'));
  expect(authorized.status()).toBe(200);
});

test('creates a room once per request key and reads it back with its held input', async ({ request }) => {
  const seed = await e2eFetch<SeedPayload>('/playground-seed');
  expect(seed.rooms.length).toBeGreaterThanOrEqual(2);

  const first = roomAt(seed, 0);
  const second = roomAt(seed, 1);
  const listed = await (await request.get(await adminUrl('/api/playground/rooms'))).json();
  const titles = listed.items.map((room: { title: string }) => room.title);
  expect(titles).toContain(first.title);
  expect(titles).toContain(second.title);

  const detail = await (await request.get(await adminUrl(`/api/playground/rooms/${first.id}`))).json();
  expect(detail.room.title).toBe(first.title);
  expect(detail.room.pending).toBe(1);
  expect(detail.participants.map((member: { name: string }) => member.name)).toEqual(['Ada']);

  const timeline = await (await request.get(await adminUrl(`/api/playground/rooms/${first.id}/messages`))).json();
  expect(timeline.items).toHaveLength(1);
  expect(timeline.items[0]).toMatchObject({ text: 'first room message', input_state: 'held' });

  const key = `e2e-create-${Date.now()}`;
  const created = await request.post(await adminUrl('/api/playground/rooms'), {
    data: { title: 'E2E Created Room', request_key: key },
  });
  expect(created.status()).toBe(201);
  const createdBody = await created.json();
  const replay = await request.post(await adminUrl('/api/playground/rooms'), {
    data: { title: 'E2E Created Room', request_key: key },
  });
  expect(replay.status()).toBe(200);
  expect((await replay.json()).room.id).toBe(createdBody.room.id);

  const conflicting = await request.post(await adminUrl('/api/playground/rooms'), {
    data: { title: 'Different title', request_key: key },
  });
  expect(conflicting.status()).toBe(409);
  expect((await conflicting.json()).error).toBe('input_conflict');
});

test('one room id never answers for another room', async ({ request }) => {
  const seed = await e2eFetch<SeedPayload>('/playground-seed');
  const first = roomAt(seed, 0);
  const second = roomAt(seed, 1);

  const secondRoom = await (await request.get(await adminUrl(`/api/playground/rooms/${second.id}`))).json();
  const secondMember = secondRoom.participants[0].id as string;

  const foreignSender = await request.post(await adminUrl(`/api/playground/rooms/${first.id}/messages`), {
    data: { request_key: `e2e-foreign-${Date.now()}`, sender_id: secondMember, text: 'not my room' },
  });
  expect(foreignSender.status()).toBe(404);
  expect((await foreignSender.json()).error).toBe('unknown_sender');

  const unknownRoom = await request.get(await adminUrl('/api/playground/rooms/999999'));
  expect(unknownRoom.status()).toBe(404);
  const malformed = await request.get(await adminUrl('/api/playground/rooms/007'));
  expect(malformed.status()).toBe(400);
});

test('a Release runs the real scheduler and the room shows the bot output', async ({ request }) => {
  const seed = await e2eFetch<SeedPayload>('/playground-seed');
  const roomId = roomAt(seed, 0).id;
  const state = await (await request.get(await adminUrl(`/api/playground/rooms/${roomId}`))).json();
  const throughSeq = String(BigInt(state.room.next_seq) - 1n);
  await e2eFetch('/playground-model', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ steps: [{ send: 'the room answers' }] }),
  });

  const released = await request.post(await adminUrl(`/api/playground/rooms/${roomId}/releases`), {
    data: { request_key: `e2e-release-${Date.now()}`, revision: state.room.revision, through_seq: throughSeq },
  });
  expect(released.status()).toBe(201);
  const release = await released.json();
  expect(release.invocation_id).not.toBeNull();

  const run = await waitForRun(request, roomId);
  expect(run.state).toBe('completed');

  const timeline = await (await request.get(await adminUrl(`/api/playground/rooms/${roomId}/messages`))).json();
  const bot = timeline.items.find((item: { sent_by_bot: boolean }) => item.sent_by_bot);
  expect(bot).toMatchObject({ text: 'the room answers', send_state: 'success' });
  expect(timeline.items.find((item: { sent_by_bot: boolean }) => !item.sent_by_bot)).toMatchObject({
    input_state: 'released',
  });

  const detail = await (
    await request.get(await adminUrl(`/api/playground/rooms/${roomId}/releases/${release.release_id}`))
  ).json();
  expect(detail.attempts[0]).toMatchObject({ state: 'completed' });
  expect(detail.sends).toHaveLength(1);
  expect(detail.sends[0]).toMatchObject({ state: 'success', kind: 'text' });
});

test('an upload is validated by content and served back byte for byte', async ({ request }) => {
  const seed = await e2eFetch<SeedPayload>('/playground-seed');
  const roomId = roomAt(seed, 0).id;
  // A 1x1 PNG: small enough to inline and a real image for the store.
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );

  const uploaded = await request.post(await adminUrl(`/api/playground/rooms/${roomId}/assets`), {
    data: { content_base64: png.toString('base64'), mime: 'image/png', name: 'e2e.png' },
  });
  expect(uploaded.status()).toBe(201);
  const asset = await uploaded.json();

  const content = await request.get(await adminUrl(`/api/playground/rooms/${roomId}/assets/${asset.asset_id}/content`));
  expect(content.status()).toBe(200);
  expect(Buffer.from(await content.body()).equals(png)).toBe(true);

  const refused = await request.post(await adminUrl(`/api/playground/rooms/${roomId}/assets`), {
    data: { content_base64: Buffer.from('<svg/>').toString('base64'), mime: 'image/png' },
  });
  expect(refused.status()).toBe(422);
  expect((await refused.json()).error).toMatch(/^upload_/);
});
