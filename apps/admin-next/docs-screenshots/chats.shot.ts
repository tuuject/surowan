/**
 * Chats-page screenshots: the four per-Chat dialogs a group Chat owns.
 *
 * The dialogs exist only for groups, so every test drives the docs seed's group
 * Chat (store row plus allowlist entry, see `e2e/server-docs.ts`). Each state
 * is saved through the dialog, read back through `/api/chats`, and then opened
 * again for the shot: what the image shows is the stored value, not the draft.
 */
import type { Page } from '@playwright/test';
import type { ChatEntry, ChatsView } from '../src/lib/api/chats.ts';
import { adminUrl } from '../e2e/helpers.ts';
import { DOCS_IDS } from '../e2e/server-docs-ids.ts';
import { captureScreenshot } from './capture.ts';
import { apiJson, expect, test } from './fixtures.ts';
import { docsLabels, type DocsLabels } from './labels.ts';

const GROUP = DOCS_IDS.groupChatHostId.toString();

async function chatsView(page: Page): Promise<ChatsView> {
  return await apiJson<ChatsView>(page, await adminUrl('/api/chats'));
}

function savedChat(view: ChatsView): ChatEntry['saved'] {
  const chat = view.items.find((item) => item.id === GROUP);
  expect(chat, `Chat ${GROUP} is missing from the allowlist`).toBeDefined();
  return chat?.saved ?? null;
}

function groupRow(page: Page) {
  return page.locator('table tbody tr').filter({ hasText: GROUP });
}

async function openChatDialog(page: Page, labels: DocsLabels, action: string): Promise<void> {
  const row = groupRow(page);
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: labels.chats.moreActions, exact: true }).click();
  await page.getByRole('menuitem', { name: action, exact: true }).click();
}

test('chats/active-hours-ask-only', async ({ page, docLocale }) => {
  const labels = docsLabels(docLocale);
  await page.goto(await adminUrl('/chats'));
  await expect(page.getByRole('heading', { name: labels.chats.title, exact: true })).toBeVisible();

  await openChatDialog(page, labels, labels.chats.editActiveHours);
  let dialog = page.getByRole('dialog', { name: labels.chats.activeHours.title, exact: true });
  await expect(dialog.getByRole('radio', { name: labels.chats.activeHours.unrestricted })).toBeChecked();
  await dialog.getByRole('radio', { name: labels.chats.activeHours.askOnly, exact: true }).click();
  await dialog.getByRole('button', { name: labels.chats.dialogSave, exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  expect(savedChat(await chatsView(page))?.participation).toEqual({ ask_only: true });
  await expect(groupRow(page)).toContainText(labels.chats.activeHours.askOnly);

  // Reopened: the radio shows the mode the server stored.
  await openChatDialog(page, labels, labels.chats.editActiveHours);
  dialog = page.getByRole('dialog', { name: labels.chats.activeHours.title, exact: true });
  await expect(dialog.getByRole('radio', { name: labels.chats.activeHours.askOnly, exact: true })).toBeChecked();
  await expect(page.locator('[data-koi-toast]')).toHaveCount(0);

  await captureScreenshot(page, docLocale, 'chats/active-hours-ask-only', dialog);
});

test('chats/proactive-reply', async ({ page, docLocale }) => {
  const labels = docsLabels(docLocale);
  await page.goto(await adminUrl('/chats'));

  await openChatDialog(page, labels, labels.chats.editProactiveReply);
  let dialog = page.getByRole('dialog', { name: labels.chats.proactive.title, exact: true });
  await dialog.getByRole('radio', { name: labels.chats.proactive.custom, exact: true }).click();
  await dialog.getByLabel(labels.chats.proactive.base, { exact: true }).fill('25');
  await dialog.getByLabel(labels.chats.proactive.increment, { exact: true }).fill('5');
  await dialog.getByLabel(labels.chats.proactive.pity, { exact: true }).fill('4');
  await dialog.getByRole('button', { name: labels.chats.dialogSave, exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  expect(savedChat(await chatsView(page))?.proactive_reply).toEqual({
    enabled: true,
    base_probability: 0.25,
    increment: 0.05,
    hard_pity: 4,
  });
  // The row follows the same query the dialog reads: wait for the saved summary
  // so reopening cannot mount the form on the pre-save view.
  await expect(groupRow(page)).toContainText(labels.chats.proactive.summary(25, 5, 4));

  await openChatDialog(page, labels, labels.chats.editProactiveReply);
  dialog = page.getByRole('dialog', { name: labels.chats.proactive.title, exact: true });
  await expect(dialog.getByRole('radio', { name: labels.chats.proactive.custom, exact: true })).toBeChecked();
  await expect(dialog.getByLabel(labels.chats.proactive.base, { exact: true })).toHaveValue('25');
  await expect(dialog.getByLabel(labels.chats.proactive.pity, { exact: true })).toHaveValue('4');
  await expect(page.locator('[data-koi-toast]')).toHaveCount(0);

  await captureScreenshot(page, docLocale, 'chats/proactive-reply', dialog);
});

test('chats/entry-gate-override', async ({ page, docLocale }) => {
  const labels = docsLabels(docLocale);
  const question = docLocale === 'zh-CN' ? '这个群希望被回复吗？' : 'Would this group want a reply?';
  // A Chat override may enable the gate only when the global key exists; the
  // global form stores it in the keychain, which is a real config write.
  await page.goto(await adminUrl('/'));
  await page.evaluate(async () => {
    const view = (await (await fetch('/api/decision-gate')).json()) as { revision: string };
    const response = await fetch('/api/decision-gate', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'if-match': view.revision },
      body: JSON.stringify({ api_key: 'docs-chat-gate-key' }),
    });
    if (!response.ok) {
      throw new Error(`Seeding the global gate key failed: ${response.status}`);
    }
  });
  await page.goto(await adminUrl('/chats'));
  await expect(groupRow(page)).toBeVisible();

  await openChatDialog(page, labels, labels.chats.editEntryGate);
  let dialog = page.getByRole('dialog', { name: labels.chats.entryGate.title, exact: true });
  await dialog.getByRole('checkbox', { name: labels.chats.entryGate.setEnabled, exact: true }).check();
  await dialog.getByRole('switch', { name: labels.tuning.gate.enabled, exact: true }).check();
  await dialog.getByRole('checkbox', { name: labels.chats.entryGate.setMode, exact: true }).check();
  await dialog.getByLabel(labels.chats.entryGate.mode, { exact: true }).selectOption('enforce');
  await dialog.getByRole('checkbox', { name: labels.chats.entryGate.setThreshold, exact: true }).check();
  await dialog.getByLabel(labels.chats.entryGate.threshold, { exact: true }).fill('0.8');
  await dialog.getByRole('checkbox', { name: labels.chats.entryGate.setQuestion, exact: true }).check();
  await dialog.getByLabel(labels.chats.entryGate.question, { exact: true }).fill(question);
  await dialog.getByRole('button', { name: labels.chats.dialogSave, exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  expect(savedChat(await chatsView(page))?.decision_gate).toEqual({
    enabled: true,
    mode: 'enforce',
    threshold: 0.8,
    instructions: question,
  });
  await expect(groupRow(page)).toContainText(labels.chats.entryGate.enforceSummary);

  await openChatDialog(page, labels, labels.chats.editEntryGate);
  dialog = page.getByRole('dialog', { name: labels.chats.entryGate.title, exact: true });
  await expect(dialog.getByLabel(labels.chats.entryGate.threshold, { exact: true })).toHaveValue('0.8');
  await expect(dialog.getByLabel(labels.chats.entryGate.question, { exact: true })).toHaveValue(question);
  await expect(page.locator('[data-koi-toast]')).toHaveCount(0);

  await captureScreenshot(page, docLocale, 'chats/entry-gate-override', dialog);
});
