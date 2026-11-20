import { expect } from '@playwright/test';
import { chatRow, expectNoChatAction, inherited, openChatAction, prepareChatsPage, viewOf } from './chats-fixture.ts';
import { gateConfigText, resetDecisionGate } from './decision-gate-fixture.ts';
import { test } from './helpers.ts';

/**
 * The per-Chat entry gate dialog on the Chats page, against the real
 * AdminServer: an override shows in the row and is saved into that Chat's
 * section, "inherit" sends `null` and removes it again, and enabling without a
 * global key is refused by the server. Each test starts from the fixture
 * allowlist with no global gate section.
 */
test.use({ signedIn: true });

const GROUP = '-100555000113';
const QUESTION = 'Would this group want a reply?';
const GLOBAL_KEY = '{{SECRET_4c9jx7nw}}';

test.beforeEach(async ({ page }) => {
  await prepareChatsPage(page);
  await resetDecisionGate(page);
  await page.evaluate(
    async ({ id, settings }) => {
      const view = await (await fetch('/api/chats')).json();
      const response = await fetch('/api/chats', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'if-match': view.revision },
        body: JSON.stringify({ id, ...settings }),
      });
      if (!response.ok) {
        throw new Error(`Adding the group Chat failed: ${response.status}`);
      }
    },
    { id: GROUP, settings: inherited },
  );
  await page.reload();
  await expect(groupRow(page)).toBeVisible();
});

function groupRow(page: import('@playwright/test').Page) {
  return page.locator('table tbody tr').filter({ has: page.getByText(GROUP, { exact: true }) });
}

async function openDialog(page: import('@playwright/test').Page) {
  await openChatAction(page, groupRow(page), 'Edit entry gate');
  return page.getByRole('dialog');
}

async function seedChatGate(
  page: import('@playwright/test').Page,
  patch: Readonly<Record<string, unknown>>,
): Promise<void> {
  await page.evaluate(
    async ({ id, body }) => {
      const view = await (await fetch('/api/chats')).json();
      const response = await fetch(`/api/chats/${id}/decision-gate`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'if-match': view.revision },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        throw new Error(`Seeding the Chat gate failed: ${response.status} ${await response.text()}`);
      }
    },
    { id: GROUP, body: patch },
  );
  await page.reload();
  await expect(groupRow(page)).toBeVisible();
}

async function seedGlobalKey(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(async (key) => {
    const view = await (await fetch('/api/decision-gate')).json();
    const response = await fetch('/api/decision-gate', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'if-match': view.revision },
      body: JSON.stringify({ api_key: key }),
    });
    if (!response.ok) {
      throw new Error(`Seeding the global key failed: ${response.status} ${await response.text()}`);
    }
  }, GLOBAL_KEY);
  // The global write moved the config revision; the captured Chats view must
  // carry the current one before the dialog sends its own write.
  await page.reload();
  await expect(groupRow(page)).toBeVisible();
}

function savedGroupGate(view: Awaited<ReturnType<typeof viewOf>>) {
  return view.items.find((chat) => chat.id === GROUP)?.saved?.decision_gate ?? null;
}

test('a Chat that enables the gate without a global key gets the server error', async ({ page }) => {
  // Private chats never gate, so their menu has no entry gate action.
  await expectNoChatAction(page, chatRow(page), 'Edit entry gate');
  await expect(groupRow(page).getByRole('cell').nth(5)).toHaveText('Inherits the global setting');

  const dialog = await openDialog(page);
  // Inherited fields show the global values and cannot be edited until the
  // Chat overrides them.
  await expect(dialog.getByRole('switch', { name: 'Enabled', exact: true })).not.toBeChecked();
  await expect(dialog.getByRole('switch', { name: 'Enabled', exact: true })).toBeDisabled();
  await expect(dialog.getByLabel('Mode', { exact: true })).toHaveValue('shadow');
  await expect(dialog.getByLabel('Threshold', { exact: true })).toHaveValue('0.57');
  await expect(dialog.getByLabel('Question', { exact: true })).toHaveValue(/Would the bot/);

  await dialog.getByRole('checkbox', { name: 'Set Enabled for this Chat', exact: true }).check();
  await dialog.getByRole('switch', { name: 'Enabled', exact: true }).check();
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('decision_gate_invalid');
  expect(savedGroupGate(await viewOf(page))).toBeNull();
  expect(await gateConfigText()).not.toContain('decision_gate');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
});

test('overrides save into the Chat, show in the row, and inherit again', async ({ page }) => {
  await seedGlobalKey(page);
  let dialog = await openDialog(page);
  await dialog.getByRole('checkbox', { name: 'Set Enabled for this Chat', exact: true }).check();
  await dialog.getByRole('switch', { name: 'Enabled', exact: true }).check();
  await dialog.getByRole('checkbox', { name: 'Set Mode for this Chat', exact: true }).check();
  await dialog.getByLabel('Mode', { exact: true }).selectOption('enforce');
  await dialog.getByRole('checkbox', { name: 'Set Threshold for this Chat', exact: true }).check();
  await dialog.getByLabel('Threshold', { exact: true }).fill('0.8');
  await dialog.getByRole('checkbox', { name: 'Set Question for this Chat', exact: true }).check();
  await dialog.getByLabel('Question', { exact: true }).fill(QUESTION);
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  expect(savedGroupGate(await viewOf(page))).toEqual({
    enabled: true,
    mode: 'enforce',
    threshold: 0.8,
    instructions: QUESTION,
  });
  expect(await gateConfigText()).toMatch(/"id":\s*-100555000113[\s\S]{0,400}"decision_gate"/);
  await expect(groupRow(page).getByRole('cell').nth(5)).toHaveText('On (Enforce)');

  await page.reload();
  await expect(groupRow(page).getByRole('cell').nth(5)).toHaveText('On (Enforce)');

  dialog = await openDialog(page);
  for (const field of ['Enabled', 'Mode', 'Threshold', 'Question']) {
    await expect(dialog.getByRole('checkbox', { name: `Set ${field} for this Chat`, exact: true })).toBeChecked();
  }
  await expect(dialog.getByLabel('Threshold', { exact: true })).toHaveValue('0.8');
  await expect(dialog.getByLabel('Question', { exact: true })).toHaveValue(QUESTION);
  for (const field of ['Enabled', 'Mode', 'Threshold', 'Question']) {
    await dialog.getByRole('checkbox', { name: `Set ${field} for this Chat`, exact: true }).uncheck();
  }
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(savedGroupGate(await viewOf(page))).toBeNull();
  await expect(groupRow(page).getByRole('cell').nth(5)).toHaveText('Inherits the global setting');

  // With the Chat override gone and the global section cleared, the file has no
  // gate at all: the override was removed rather than left as an empty object.
  await resetDecisionGate(page);
  expect(await gateConfigText()).not.toContain('decision_gate');
});

test('unchecking an override shows the inherited global value', async ({ page }) => {
  await seedGlobalKey(page);
  await seedChatGate(page, {
    enabled: true,
    mode: 'enforce',
    threshold: 0.8,
    instructions: QUESTION,
  });
  const dialog = await openDialog(page);
  const override = (field: string) => dialog.getByRole('checkbox', { name: `Set ${field} for this Chat`, exact: true });

  await override('Enabled').uncheck();
  await expect(dialog.getByRole('switch', { name: 'Enabled', exact: true })).not.toBeChecked();
  await override('Enabled').check();
  await expect(dialog.getByRole('switch', { name: 'Enabled', exact: true })).toBeChecked();

  await override('Mode').uncheck();
  await expect(dialog.getByLabel('Mode', { exact: true })).toHaveValue('shadow');
  await override('Mode').check();
  await expect(dialog.getByLabel('Mode', { exact: true })).toHaveValue('enforce');

  await override('Threshold').uncheck();
  await expect(dialog.getByLabel('Threshold', { exact: true })).toHaveValue('0.57');
  await override('Threshold').check();
  await expect(dialog.getByLabel('Threshold', { exact: true })).toHaveValue('0.8');

  await override('Question').uncheck();
  await expect(dialog.getByLabel('Question', { exact: true })).toHaveValue(/Would the bot/);
  await override('Question').check();
  await expect(dialog.getByLabel('Question', { exact: true })).toHaveValue(QUESTION);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
});

test('only changed fields are sent, and an untouched dialog sends nothing', async ({ page }) => {
  await seedGlobalKey(page);
  await seedChatGate(page, {
    enabled: true,
    mode: 'enforce',
    threshold: 0.8,
    instructions: QUESTION,
  });
  const writes: unknown[] = [];
  page.on('request', (request) => {
    if (request.method() === 'PUT' && request.url().includes(`/api/chats/${GROUP}/decision-gate`)) {
      writes.push(request.postDataJSON());
    }
  });

  let dialog = await openDialog(page);
  await dialog.getByLabel('Threshold', { exact: true }).fill('0.9');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(writes).toEqual([{ threshold: 0.9 }]);

  await page.reload();
  await expect(groupRow(page)).toBeVisible();
  writes.length = 0;
  dialog = await openDialog(page);
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(writes).toEqual([]);
});

test('an enabled-only override is just On, without naming a mode', async ({ page }) => {
  await seedGlobalKey(page);
  await page.evaluate(async () => {
    const view = await (await fetch('/api/decision-gate')).json();
    const response = await fetch('/api/decision-gate', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'if-match': view.revision },
      body: JSON.stringify({ mode: 'enforce' }),
    });
    if (!response.ok) {
      throw new Error(`Enabling the global gate failed: ${response.status}`);
    }
  });
  await page.reload();
  await seedChatGate(page, { enabled: true });
  await expect(groupRow(page).getByRole('cell').nth(5)).toHaveText('On');
});

test('the open dialog is the review artifact', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await seedGlobalKey(page);
  let dialog = await openDialog(page);
  await dialog.getByRole('checkbox', { name: 'Set Enabled for this Chat', exact: true }).check();
  await dialog.getByRole('switch', { name: 'Enabled', exact: true }).check();
  await dialog.getByRole('checkbox', { name: 'Set Mode for this Chat', exact: true }).check();
  await dialog.getByLabel('Mode', { exact: true }).selectOption('enforce');
  await dialog.getByRole('checkbox', { name: 'Set Threshold for this Chat', exact: true }).check();
  await dialog.getByLabel('Threshold', { exact: true }).fill('0.7');
  await dialog.getByRole('checkbox', { name: 'Set Question for this Chat', exact: true }).check();
  await dialog.getByLabel('Question', { exact: true }).fill(QUESTION);
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(groupRow(page).getByRole('cell').nth(5)).toHaveText('On (Enforce)');

  dialog = await openDialog(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('checkbox', { name: 'Set Enabled for this Chat', exact: true })).toBeChecked();
  await expect(dialog.getByLabel('Threshold', { exact: true })).toHaveValue('0.7');
  await expect(page.getByRole('menu')).toHaveCount(0);
  const screenshot = testInfo.outputPath('chats-decision-gate.png');
  await page.screenshot({ path: screenshot, fullPage: true, animations: 'disabled' });
  await testInfo.attach('chats-decision-gate', { path: screenshot, contentType: 'image/png' });
});
