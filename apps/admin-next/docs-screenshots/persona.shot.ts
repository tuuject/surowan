/**
 * First-persona screenshots: the saved global prompt and the Playground scene
 * that shows what it produces.
 *
 * The prompt is the one the server booted with (`agent-system-prompt.md`),
 * recorded as the first prompt version at startup; the Playground reply comes
 * from the room runtime's scripted model, released through the real page.
 */
import { docsSeedText } from '../e2e/docs-locale.ts';
import { adminUrl, e2eFetch } from '../e2e/helpers.ts';
import { captureScreenshot } from './capture.ts';
import { expect, test } from './fixtures.ts';
import { docsLabels } from './labels.ts';

interface PlaygroundPayload {
  readonly rooms: readonly { readonly id: string; readonly title: string }[];
}

test('first-persona/prompt-editor', async ({ page, docLocale }) => {
  const labels = docsLabels(docLocale);
  const seed = docsSeedText(docLocale);
  await page.goto(await adminUrl('/prompts'));

  // The editor holds the persona the deployment started with, and its version
  // history already has the external (file) version recorded by the server.
  const editor = page.getByRole('textbox', { name: labels.prompts.promptLabel, exact: true });
  await expect(editor).toHaveText(seed.globalPrompt);
  await expect(page.getByText(labels.prompts.historyTitle, { exact: true })).toBeVisible();
  const newest = page.locator('table tbody tr').first();
  await expect(newest).toContainText('v1');
  await expect(newest).toContainText(labels.prompts.applied);
  await expect(newest).toContainText(labels.prompts.external);

  // The editor card ends at the save button; the history table below stays out
  // of a shot that is about the saved persona and its applied version.
  const personaPanel = page.getByRole('region', { name: labels.prompts.globalScope, exact: true });
  await expect(personaPanel).toBeVisible();
  await captureScreenshot(page, docLocale, 'first-persona/prompt-editor', personaPanel);
});

test('first-persona/playground-scene', async ({ page, docLocale }) => {
  const labels = docsLabels(docLocale);
  const seed = docsSeedText(docLocale);
  const playground = await e2eFetch<PlaygroundPayload>('/playground-seed');
  const room = playground.rooms[0];
  if (room === undefined) {
    throw new Error('the docs fixture seeded no playground room');
  }
  // The room runtime's fake model publishes exactly this reply on its next turn.
  await e2eFetch('/playground-model', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ steps: [{ send: seed.playground.reply }] }),
  });

  await page.goto(await adminUrl(`/playground?room=${room.id}`));
  await expect(page.getByRole('region', { name: room.title, exact: true })).toBeVisible();
  const timeline = page.getByRole('region', { name: labels.playground.timelineHeading, exact: true });
  await expect(timeline.getByText(seed.playground.rooms[0]?.message ?? '', { exact: true })).toBeVisible();

  // A release is the only way the room runs; the reply really arrives from the run.
  await page.getByRole('button', { name: labels.playground.release(1), exact: true }).click();
  await expect(timeline.getByText(seed.playground.reply, { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(timeline.getByText(seed.playground.botName).first()).toBeVisible();

  await captureScreenshot(page, docLocale, 'first-persona/playground-scene', timeline);
});
