import { expect, type Page } from '@playwright/test';
import { ACTIVE_CHAT, chatRow, prepareChatsPage, saveDialog, viewOf } from './chats-fixture.ts';
import { adminUrl, e2eFetch, modelListRow, test, toast } from './helpers.ts';
import { roleToggle, setAsAgent } from './models-fixture.ts';

/**
 * A model switch takes effect at once: Invocations still running on the model
 * being replaced are stopped, after the admin agreed to it. The fixture's
 * Invocation is a database row the hook marks running in a Conversation of the
 * configured Chat, which follows the global Agent model; nothing executes it,
 * so these specs check the question, both answers and what each one wrote. The
 * stop itself is covered against a live scheduler in `test/admin/model-switch`.
 */
test.use({ signedIn: true });

async function agentOf(page: Page): Promise<{ provider: string; model: string }> {
  return (await (await page.request.get(await adminUrl('/api/providers'))).json()).agent;
}

async function withRunningSession(run: () => Promise<void>): Promise<void> {
  const { id } = await e2eFetch<{ id: string }>('/running-invocation', { method: 'POST' });
  try {
    await run();
  } finally {
    await e2eFetch(`/running-invocation/finish?id=${id}`, { method: 'POST' });
  }
}

test('a "Use as Agent" switch asks before stopping the running session, and cancelling keeps the model', async ({
  page,
}) => {
  await page.goto(await adminUrl('/providers'));
  await page.getByRole('button', { name: 'Provider vision', exact: true }).click();
  const row = modelListRow(page, 'vision-model');
  const dialog = page.getByRole('alertdialog');

  await withRunningSession(async () => {
    await setAsAgent(row);
    await expect(dialog).toContainText('Stop running invocations and switch?');
    await expect(dialog).toContainText('Invocations still running on the current model: 1');
    await page.screenshot({ path: test.info().outputPath('model-switch-confirm.png'), animations: 'disabled' });
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(roleToggle(row, 'Agent')).toHaveAttribute('aria-pressed', 'false');
    expect(await agentOf(page)).toMatchObject({ provider: 'agent', model: 'agent-model' });

    await setAsAgent(row);
    await dialog.getByRole('button', { name: 'Stop and switch', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(roleToggle(row, 'Agent')).toHaveAttribute('aria-pressed', 'true');
    expect(await agentOf(page)).toMatchObject({ provider: 'vision', model: 'vision-model' });
  });

  // Nothing runs any more, so switching back asks nothing.
  await page.getByRole('button', { name: 'Provider agent', exact: true }).click();
  await setAsAgent(modelListRow(page, 'agent-model'));
  await expect(roleToggle(modelListRow(page, 'agent-model'), 'Agent')).toHaveAttribute('aria-pressed', 'true');
  await expect(dialog).toHaveCount(0);
  expect(await agentOf(page)).toMatchObject({ provider: 'agent', model: 'agent-model' });
});

test('the Models page asks before its save stops the running session', async ({ page }) => {
  await page.goto(await adminUrl('/models'));
  const card = page.getByRole('region', { name: 'Agent model', exact: true });
  const picker = card.getByRole('combobox', { name: 'Model', exact: true });
  const dialog = page.getByRole('alertdialog');

  await withRunningSession(async () => {
    await picker.click();
    await page.getByRole('option', { name: /vision-model/ }).click();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog).toContainText('Invocations still running on the current model: 1');
    // Cancelling keeps the draft: the change is still waiting to be saved.
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('status').filter({ hasText: /unsaved change/ })).toBeVisible();
    expect(await agentOf(page)).toMatchObject({ provider: 'agent', model: 'agent-model' });

    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await dialog.getByRole('button', { name: 'Stop and switch', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'All changes saved' })).toBeVisible();
    expect(await agentOf(page)).toMatchObject({ provider: 'vision', model: 'vision-model' });
  });

  await picker.click();
  await page.getByRole('option', { name: /agent-model/ }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'All changes saved' })).toBeVisible();
  await expect(dialog).toHaveCount(0);
  expect(await agentOf(page)).toMatchObject({ provider: 'agent', model: 'agent-model' });
});

test("a Chat's own model switch asks before stopping the session running in that Chat", async ({ page }) => {
  await prepareChatsPage(page);
  const dialog = page.getByRole('alertdialog');

  await withRunningSession(async () => {
    await chatRow(page).getByRole('button', { name: 'Edit', exact: true }).click();
    await page.getByRole('combobox', { name: 'Agent model' }).selectOption({ label: 'vision / vision-model' });
    await page.getByRole('button', { name: 'Save Chat', exact: true }).click();
    await expect(dialog).toContainText('Invocations still running on the current model: 1');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    // The Chat dialog stays open with the choice, and nothing was written.
    await expect(page.getByRole('dialog')).toBeVisible();
    expect((await viewOf(page)).items.find((chat) => chat.id === ACTIVE_CHAT)?.saved?.provider).toBeNull();

    await page.getByRole('button', { name: 'Save Chat', exact: true }).click();
    await dialog.getByRole('button', { name: 'Stop and switch', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(toast(page, 'Applied').first()).toBeVisible();
    expect((await viewOf(page)).items.find((chat) => chat.id === ACTIVE_CHAT)?.active?.effective).toMatchObject({
      provider: 'vision',
      model: 'vision-model',
    });
  });

  await chatRow(page).getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByRole('combobox', { name: 'Agent model' }).selectOption({ index: 0 });
  await saveDialog(page);
  expect((await viewOf(page)).items.find((chat) => chat.id === ACTIVE_CHAT)?.saved?.provider).toBeNull();
});
