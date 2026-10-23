import { expect } from '@playwright/test';
import { adminUrl, e2eFetch, test } from './helpers.ts';
import { type InvocationPayload, type SeedPayload, roomAt } from './playground-fixtures.ts';

/**
 * The Playground page (T11): the seed's rooms, the held-input timeline, a full
 * Hold -> Release round driven from the UI, room isolation, the cost switch and
 * the draft-preserving refusal path.
 */
test.use({ signedIn: true });

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
  const title = `UI Room ${Date.now()}`;
  await page.getByLabel('Room title').fill(title);
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

  // The run is audited on the shared invocation pages, under the room's identity.
  await page.getByRole('link', { name: 'Audit' }).first().click();
  await expect(page).toHaveURL(/\/invocations\/\d+$/);
  await expect(page.getByText('Playground room')).toBeVisible();
  await expect(page.getByText('please answer as Ada').first()).toBeVisible();
  await page.getByRole('tab', { name: 'Room sends (1)' }).click();
  await expect(page.getByRole('columnheader', { name: 'Room message' })).toBeVisible();

  await page.goto(await adminUrl('/invocations'));
  await page.getByRole('combobox', { name: 'Host' }).click();
  await page.getByRole('option', { name: 'Playground' }).click();
  await expect(page.getByText(title)).toBeVisible();
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

test('an image over the size limit is refused before it is uploaded', async ({ page }) => {
  const seed = await e2eFetch<SeedPayload>('/playground-seed');
  const room = roomAt(seed, 0);
  await page.goto(await adminUrl(`/playground?room=${room.id}`));
  const uploads: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().includes('/assets')) {
      uploads.push(request.url());
    }
  });
  await page.setInputFiles('#playground-attachment', {
    name: 'huge.png',
    mimeType: 'image/png',
    buffer: Buffer.alloc(10 * 1024 * 1024 + 1),
  });
  await expect(page.getByText('An image may be at most 10 MiB.')).toBeVisible();
  expect(uploads).toEqual([]);
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

test('a replay in flight keeps its key: the recovery action waits for it', async ({ page, request }) => {
  const created = await request.post(await adminUrl('/api/playground/rooms'), {
    data: { title: 'E2E Replay Room', members: [{ name: 'Ada' }], request_key: 'e2e-replay-room' },
  });
  const { room } = (await created.json()) as { room: { id: string } };
  await page.goto(await adminUrl(`/playground?room=${room.id}`));
  let attempt = 0;
  let releaseReplay = (): void => {};
  const replayHeld = new Promise<void>((resolve) => {
    releaseReplay = resolve;
  });
  await page.route('**/api/playground/rooms/*/messages', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue();
      return;
    }
    attempt += 1;
    if (attempt === 1) {
      await route.fetch();
      await route.abort('failed');
      return;
    }
    await replayHeld;
    await route.continue();
  });
  await page.getByRole('textbox', { name: 'Message' }).fill('replayed draft');
  await page.getByRole('button', { name: 'Send' }).click();
  const recover = page.getByRole('button', { name: 'Edit as a new message' });
  await expect(recover).toBeEnabled();

  await page.getByRole('button', { name: 'Send' }).click();
  await expect.poll(() => attempt).toBe(2);
  await expect(recover).toBeDisabled();
  releaseReplay();
  await expect(page.getByText('Message admitted')).toBeVisible();
});

test('the room list follows the pending count after a send', async ({ page, request }) => {
  const created = await request.post(await adminUrl('/api/playground/rooms'), {
    data: { title: 'E2E Pending Room', members: [{ name: 'Ada' }], request_key: 'e2e-pending-room' },
  });
  const { room } = (await created.json()) as { room: { id: string } };
  await page.goto(await adminUrl(`/playground?room=${room.id}`));
  const entry = page.getByRole('button', { name: /E2E Pending Room/ }).first();
  await expect(entry).toContainText('0 pending');

  await page.getByRole('textbox', { name: 'Message' }).fill('counted message');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(entry).toContainText('1 pending');
});

test('Back and Forward never carry a draft into another room', async ({ page }) => {
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
  await page.getByRole('textbox', { name: 'Message' }).fill('draft for the second room');

  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`room=${first.id}`));
  await expect(page.getByText('first room message')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue('');

  await page.goForward();
  await expect(page).toHaveURL(new RegExp(`room=${second.id}`));
  await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue('');
});

test('an identity name with spaces or CJK characters is accepted', async ({ page, request }) => {
  const seed = await e2eFetch<SeedPayload>('/playground-seed');
  const room = roomAt(seed, 0);
  await page.goto(await adminUrl(`/playground?room=${room.id}`));
  for (const name of ['Ada Lovelace', '小明']) {
    await page.getByLabel('Name', { exact: true }).fill(name);
    // Wait for this identity's own response: a toast left by the previous
    // one would otherwise satisfy the check while this POST is in flight.
    const added = page.waitForResponse(
      (response) => response.request().method() === 'POST' && response.url().endsWith('/participants'),
    );
    await page.getByRole('button', { name: 'Add identity' }).click();
    expect((await added).status()).toBe(201);
  }
  const detail = await (await request.get(await adminUrl(`/api/playground/rooms/${room.id}`))).json();
  const names = detail.participants.map((member: { name: string }) => member.name);
  expect(names).toEqual(expect.arrayContaining(['Ada Lovelace', '小明']));
});

test('a refused room creation shows the server reason', async ({ page }) => {
  await page.goto(await adminUrl('/playground'));
  await page.getByRole('button', { name: 'New room' }).click();
  // Titles are capped at 120 characters; the page leaves the check to the server.
  await page.getByLabel('Room title').fill('x'.repeat(121));
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByText(/Request failed: invalid_body/)).toBeVisible();
  await expect(page.getByLabel('Room title')).toHaveValue('x'.repeat(121));
});
