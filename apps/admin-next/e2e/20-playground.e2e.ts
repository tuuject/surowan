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

/**
 * The Playground page (T11): the seed's rooms, the held-input timeline, a full
 * Hold -> Release round driven from the UI, room isolation, the cost switch and
 * the draft-preserving refusal path.
 */
test('the page lists the seeded rooms and holds their input until a release', async ({ page }) => {
  // The second seeded room is untouched by the API cases above: its input is
  // still held and it has no runs.
  const seed = await e2eFetch<SeedPayload>('/playground-seed');
  const untouched = roomAt(seed, 1);
  await page.goto(await adminUrl('/playground'));
  await expect(page.getByRole('heading', { name: 'Playground' })).toBeVisible();
  await page
    .getByRole('button', { name: /E2E Second Room/ })
    .first()
    .click();
  await expect(page).toHaveURL(new RegExp(`room=${untouched.id}`));
  await expect(page.getByText('second room message')).toBeVisible();
  await expect(page.getByText('Held').first()).toBeVisible();
  // Nothing runs until the release: the runs list stays empty.
  await expect(page.getByText('No runs yet.')).toBeVisible();
});

test('a room is created, held, released and answered from the page alone', async ({ page, request }) => {
  // Earlier rooms in this file may still have a run queued; it would consume
  // the scripted turn before this test's release does.
  const seed = await e2eFetch<SeedPayload>('/playground-seed');
  await expect
    .poll(
      async () => {
        for (const room of [...seed.rooms]) {
          const listed = await (
            await request.get(await adminUrl(`/api/playground/rooms/${room.id}/invocations`))
          ).json();
          if (listed.items.some((item: InvocationPayload) => ['queued', 'running'].includes(item.state))) {
            return false;
          }
        }
        return true;
      },
      { timeout: 20_000 },
    )
    .toBe(true);
  await e2eFetch('/playground-model', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ steps: [{ send: 'the room answers' }] }),
  });
  await page.goto(await adminUrl('/playground'));
  await page.getByRole('button', { name: 'New room' }).click();
  await page.getByLabel('Room title').fill(`UI Room ${Date.now()}`);
  await page.getByLabel('First identities (comma separated)').fill('Ada, Bo');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page).toHaveURL(/room=\d+/);
  await expect(page.getByText('Ada').first()).toBeVisible();

  await page.getByRole('textbox', { name: 'Message' }).fill('please answer as Ada');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText('please answer as Ada')).toBeVisible();
  await expect(page.getByText('Held').first()).toBeVisible();

  await page.getByRole('button', { name: /Release 1/ }).click();
  await expect(page.getByText('the room answers')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('Delivered').first()).toBeVisible();
  await expect(page.getByText('Completed').first()).toBeVisible();
});

test('switching rooms never shows another room content', async ({ page }) => {
  const seed = await e2eFetch<SeedPayload>('/playground-seed');
  const first = roomAt(seed, 0);
  const second = roomAt(seed, 1);
  await page.goto(await adminUrl(`/playground?room=${first.id}`));
  await expect(page.getByText('first room message')).toBeVisible();
  await page
    .getByRole('button', { name: /E2E Second Room/ })
    .first()
    .click();
  await expect(page).toHaveURL(new RegExp(`room=${second.id}`));
  await expect(page.getByText('second room message')).toBeVisible();
  await expect(page.getByText('first room message')).toHaveCount(0);
});

test('the image switch records the operator and marks the real cost', async ({ page, request }) => {
  const seed = await e2eFetch<SeedPayload>('/playground-seed');
  const room = roomAt(seed, 0);
  await page.goto(await adminUrl(`/playground?room=${room.id}`));
  const toggle = page.getByRole('switch', { name: 'Image generation' });
  await expect(toggle).not.toBeChecked();
  await toggle.click();
  await expect(page.getByText(/^Enabled \(charged\)/)).toBeVisible();
  const detail = await (await request.get(await adminUrl(`/api/playground/rooms/${room.id}`))).json();
  expect(detail.room.image_enabled).toBe(true);
  expect(detail.room.image_enabled_by).toBe('e2e-admin');
  await toggle.click();
  await expect(page.getByText(/^Disabled/)).toBeVisible();
});

test('a refused upload keeps the draft and shows the server reason', async ({ page }) => {
  const seed = await e2eFetch<SeedPayload>('/playground-seed');
  const room = roomAt(seed, 0);
  await page.goto(await adminUrl(`/playground?room=${room.id}`));
  await page.getByRole('textbox', { name: 'Message' }).fill('draft that must survive');
  await page.setInputFiles('#playground-attachment', {
    name: 'not-an-image.png',
    mimeType: 'image/png',
    buffer: Buffer.from('<svg/>'),
  });
  await expect(page.getByText(/Upload failed/)).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue('draft that must survive');
});

test('the composer stays usable on a narrow screen and every control is labeled', async ({ page }) => {
  const seed = await e2eFetch<SeedPayload>('/playground-seed');
  const room = roomAt(seed, 0);
  await page.setViewportSize({ width: 480, height: 900 });
  await page.goto(await adminUrl(`/playground?room=${room.id}`));
  await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Sending as' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send' })).toBeVisible();
  await expect(page.getByRole('switch', { name: 'Image generation' })).toBeVisible();
});

test('a lost response keeps the draft and the same key never admits twice', async ({ page, request }) => {
  const seed = await e2eFetch<SeedPayload>('/playground-seed');
  const room = roomAt(seed, 1);
  await page.goto(await adminUrl(`/playground?room=${room.id}`));
  let dropped = false;
  await page.route('**/api/playground/rooms/*/messages', async (route) => {
    if (route.request().method() !== 'POST' || dropped) {
      await route.continue();
      return;
    }
    dropped = true;
    // The server does the work; the client never sees the response.
    await route.fetch();
    await route.abort('failed');
  });
  await page.getByRole('textbox', { name: 'Message' }).fill('lost response draft');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText(/Your draft was kept/)).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue('lost response draft');

  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText('lost response draft')).toBeVisible();
  await expect(page.getByText('lost response draft')).toHaveCount(1);
  // The retry replayed the original admission instead of writing a second one.
  const detail = await (await request.get(await adminUrl(`/api/playground/rooms/${room.id}`))).json();
  expect(detail.room.pending).toBe(2);
});
