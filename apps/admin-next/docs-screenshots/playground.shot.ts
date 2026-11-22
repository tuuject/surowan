/**
 * Playground screenshots: input held before a release, and the result of one.
 *
 * The rooms come from the E2E fixture (`e2e/server-fixtures.ts`) with one held
 * message each; anything typed here goes through the real composer, and the
 * release runs the real room runtime with its scripted fake model.
 */
import { docsSeedText } from '../e2e/docs-locale.ts';
import { adminUrl, e2eFetch } from '../e2e/helpers.ts';
import { captureScreenshot } from './capture.ts';
import { expect, test } from './fixtures.ts';
import { docsLabels } from './labels.ts';

interface PlaygroundPayload {
  readonly rooms: readonly { readonly id: string; readonly title: string }[];
}

async function seededRoom(index: number): Promise<{ readonly id: string; readonly title: string }> {
  const payload = await e2eFetch<PlaygroundPayload>('/playground-seed');
  const room = payload.rooms[index];
  if (room === undefined) {
    throw new Error(`the docs fixture seeded no playground room at index ${String(index)}`);
  }
  return room;
}

test('playground/hold-pending', async ({ page, docLocale }) => {
  const labels = docsLabels(docLocale);
  const seed = docsSeedText(docLocale);
  // The second seeded room is untouched by the release scenario below.
  const room = await seededRoom(1);
  await page.goto(await adminUrl(`/playground?room=${room.id}`));
  await expect(page.getByRole('region', { name: room.title, exact: true })).toBeVisible();
  await expect(page.getByText(labels.playground.holdOn, { exact: true }).first()).toBeVisible();

  // One more message through the real composer: two pending, still no run.
  await page.getByRole('textbox', { name: labels.playground.composer, exact: true }).fill(seed.playground.followUp);
  await page.getByRole('button', { name: labels.playground.send, exact: true }).click();
  await expect(page.getByText(labels.playground.pending(2), { exact: true }).first()).toBeVisible();
  // The counter and the timeline poll independently: wait for the message itself.
  const timeline = page.getByRole('region', { name: labels.playground.timelineHeading, exact: true });
  await expect(timeline.getByText(seed.playground.followUp, { exact: true })).toBeVisible();

  const runs = page.getByRole('region', { name: labels.playground.runsHeading, exact: true });
  await expect(runs.getByText(labels.playground.runsEmpty, { exact: true })).toBeVisible();

  await captureScreenshot(page, docLocale, 'playground/hold-pending');
});

test('playground/release-result', async ({ page, docLocale }) => {
  const labels = docsLabels(docLocale);
  const seed = docsSeedText(docLocale);
  const room = await seededRoom(0);
  // The room runtime's fake model publishes exactly this reply on its next turn.
  await e2eFetch('/playground-model', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ steps: [{ send: seed.playground.reply }] }),
  });

  await page.goto(await adminUrl(`/playground?room=${room.id}`));
  await expect(page.getByRole('region', { name: room.title, exact: true })).toBeVisible();
  await page.getByRole('button', { name: labels.playground.release(1), exact: true }).click();

  // The reply is the run's output; the audit link is the run's record.
  const timeline = page.getByRole('region', { name: labels.playground.timelineHeading, exact: true });
  await expect(timeline.getByText(seed.playground.reply, { exact: true })).toBeVisible({ timeout: 30_000 });
  const runs = page.getByRole('region', { name: labels.playground.runsHeading, exact: true });
  // The Audit link also exists on a run that is still queued or running; the
  // completed badge on the same row is what makes it the result shot.
  const run = runs
    .locator('li')
    .filter({ has: page.getByText(labels.playground.completed, { exact: true }) })
    .first();
  await expect(run).toBeVisible({ timeout: 30_000 });
  await expect(run.getByRole('link', { name: labels.playground.audit, exact: true })).toBeVisible();
  // Scroll so the shot holds both halves of the result: the timeline with the
  // reply and the run card with its Audit link.
  await captureScreenshot(page, docLocale, 'playground/release-result', 'viewport', { scrollTo: runs });
});
