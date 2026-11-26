import { expect, type Page } from '@playwright/test';
import type { ChatsView } from '../src/lib/api/chats.ts';
import {
  ACTIVE_CHAT,
  chatRow,
  inherited,
  labelledValue,
  openChatAction,
  openChatDetails,
  prepareChatsPage,
  removeChat,
  viewOf,
} from './chats-fixture.ts';
import { test, watchPageIssues } from './helpers.ts';

/**
 * The allowlist's two layouts against the real AdminServer: a five-column table
 * where the list has room, a stacked list where it doesn't, the same summary in
 * both, and every management action reachable at every width. Each width leaves
 * a full-page screenshot in the test output as the reviewable artifact.
 */
test.use({ signedIn: true });

const CUSTOM = '-100555000201';
const INHERITING = '-100555000202';
const LONG_TITLE =
  '超长群组名称：塑料碗技术交流与日常闲聊二〇二六年冬季特别版（请勿发广告）Long_Group_Name_Without_Any_Spaces_ABCDEFGHIJKLMNOP';
const LONG_MODEL = 'Example Long Context Reasoning Model Preview 2026-11-18 (Experimental Build)';

async function write(page: Page, path: string, method: string, body: unknown): Promise<void> {
  await page.evaluate(
    async ({ path, method, body }) => {
      const view = await (await fetch('/api/chats')).json();
      const response = await fetch(path, {
        method,
        headers: { 'content-type': 'application/json', 'if-match': view.revision },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        throw new Error(`${method} ${path} failed: ${response.status} ${await response.text()}`);
      }
    },
    { path, method, body },
  );
}

/** A group that sets everything itself and one that inherits everything. */
async function seedChats(page: Page): Promise<void> {
  await write(page, '/api/chats', 'POST', {
    id: CUSTOM,
    topic_ids: ['12', '34', '56'],
    provider: 'merge',
    model: 'e2e-merge-model',
    thinking_level: 'high',
  });
  await write(page, `/api/chats/${CUSTOM}/participation`, 'PUT', {
    active_windows: [
      { start: '09:00', end: '18:00', days: [1, 2, 3, 4, 5] },
      { start: '22:00', end: '02:00', days: [5, 6] },
      { start: '10:00', end: '12:00' },
    ],
  });
  await write(page, `/api/chats/${CUSTOM}/proactive-reply`, 'PUT', {
    mode: 'custom',
    base_probability: 0.25,
    increment: 0.05,
    hard_pity: 4,
  });
  await write(page, `/api/chats/${CUSTOM}/group-memory`, 'PUT', {
    enabled: true,
    idle_minutes: 45,
    thirty_hour_clock: 'non_overlapping',
  });
  await write(page, '/api/chats', 'POST', { id: INHERITING, ...inherited });
}

/** Titles come from stored messages the fixture lacks; stretch the strings the layout has to hold. */
async function stretchText(page: Page): Promise<void> {
  await page.route('**/api/chats', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    const view = (await response.json()) as ChatsView;
    await route.fulfill({
      response,
      json: {
        ...view,
        models: view.models.map((model) => (model.provider === 'merge' ? { ...model, name: LONG_MODEL } : model)),
        items: view.items.map((item) => (item.id === CUSTOM ? { ...item, title: LONG_TITLE } : item)),
      },
    });
  });
}

async function expectNoSidewaysScroll(page: Page, label: string): Promise<void> {
  const widths = await page.evaluate(() => {
    const scrolling = document.scrollingElement ?? document.documentElement;
    const visible = [...document.querySelectorAll<HTMLElement>('main table, main [data-chat-card]')].filter(
      (element) => element.getClientRects().length > 0,
    );
    return {
      page: scrolling.scrollWidth - scrolling.clientWidth,
      overflowing: visible
        .filter((element) => (element.parentElement?.scrollWidth ?? 0) > (element.parentElement?.clientWidth ?? 0) + 1)
        .map((element) => element.tagName),
    };
  });
  expect(widths, `${label}: the page or a Chat block scrolls sideways`).toEqual({ page: 0, overflowing: [] });
}

const WIDTHS = [
  { name: 'wide desktop', width: 1440, height: 1000, table: true },
  { name: 'narrow desktop', width: 1280, height: 900, table: true },
  { name: 'tablet', width: 1024, height: 900, table: false },
  { name: 'phone', width: 390, height: 844, table: false },
  { name: 'narrow phone', width: 320, height: 720, table: false },
] as const;

test.beforeEach(async ({ page }) => {
  await prepareChatsPage(page);
});

test('the last saved Chat cannot be removed from its menu', async ({ page }) => {
  await chatRow(page).getByRole('button', { name: 'More actions', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: 'Remove', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
});

test('the table and the narrow list show the same Chats, actions and summary at every width', async ({
  page,
}, testInfo) => {
  const finish = watchPageIssues(page);
  await seedChats(page);
  await stretchText(page);
  await page.reload();

  for (const viewport of WIDTHS) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const label = `${viewport.name} ${viewport.width}px`;
    await expect(page.locator('main table'), label).toBeVisible({ visible: viewport.table });
    await expect(page.locator('main [data-chat-card]').first(), label).toBeVisible({ visible: !viewport.table });

    for (const id of [ACTIVE_CHAT, CUSTOM, INHERITING]) {
      const row = chatRow(page, id);
      await expect(row, `${label} ${id}`).toHaveCount(1);
      for (const action of ['Edit', 'More actions']) {
        // Rows below the fold count too: only the inline extent has to fit the window.
        const box = await row.getByRole('button', { name: action, exact: true }).boundingBox();
        expect(box, `${label} ${id} ${action}`).not.toBeNull();
        if (box !== null) {
          expect(box.x, `${label} ${id} ${action}`).toBeGreaterThanOrEqual(0);
          expect(box.x + box.width, `${label} ${id} ${action}`).toBeLessThanOrEqual(viewport.width);
        }
      }
    }

    // A Chat's own settings are values; inherited ones say where they come from.
    const custom = chatRow(page, CUSTOM);
    await expect(custom).toContainText(LONG_TITLE);
    await expect(custom).toContainText('Topics 12, 34, 56');
    await expect(custom).toContainText(LONG_MODEL);
    await expect(custom.getByTitle('merge / e2e-merge-model')).toBeVisible();
    const hours = labelledValue(custom, 'Active hours');
    await expect(hours.locator('p')).toHaveText(['Mon–Fri 09:00–18:00', 'Fri–Sat 22:00–02:00', '+1 more']);
    await expect(labelledValue(custom, 'Proactive replies')).toHaveText('25% first, +5% per miss, guaranteed by try 4');
    await expect(labelledValue(custom, 'Group memory')).toHaveText('On, idle 45 min, 30-hour clock');
    const plain = chatRow(page, INHERITING);
    await expect(plain).toContainText('Agent Model (inherited)');
    await expect(labelledValue(plain, 'Active hours')).toHaveText('Unrestricted');
    // Features that are off and inherited stay out of the summary.
    for (const name of ['Proactive replies', 'Entry gate', 'Group memory', 'MCP tools']) {
      await expect(labelledValue(plain, name), `${label} ${name}`).toHaveCount(0);
    }

    await expectNoSidewaysScroll(page, label);
    const screenshot = testInfo.outputPath(`chats-${viewport.width}.png`);
    await page.screenshot({ path: screenshot, fullPage: true, animations: 'disabled' });
    await testInfo.attach(`chats-${viewport.width}`, { path: screenshot, contentType: 'image/png' });
  }

  // The full settings open in place on a phone too, every inherited value marked.
  const details = await openChatDetails(page, chatRow(page, CUSTOM));
  await expect(labelledValue(details, 'Active hours')).toContainText('Daily 10:00–12:00');
  await expect(labelledValue(details, 'Timezone')).toHaveText('UTC (inherited)');
  await expect(labelledValue(details, 'Thinking effort')).toHaveText('High');
  await expect(labelledValue(details, 'MCP tools')).toHaveText('Inherit every server');
  await expectNoSidewaysScroll(page, 'narrow phone with details');
  const detailsShot = testInfo.outputPath('chats-320-details.png');
  await page.screenshot({ path: detailsShot, fullPage: true, animations: 'disabled' });
  await testInfo.attach('chats-320-details', { path: detailsShot, contentType: 'image/png' });

  // Search, clear and the row menu work from the narrow list.
  const search = page.getByRole('textbox', { name: 'Search Chat name or ID', exact: true });
  await search.fill(INHERITING);
  await search.press('Enter');
  await expect(page).toHaveURL(/[?&]search=/);
  await expect(page.locator('main [data-chat-card]')).toHaveCount(1);
  await page.getByRole('button', { name: 'Clear filter', exact: true }).click();
  await expect(search).toHaveValue('');
  await expect(page.locator('main [data-chat-card]')).toHaveCount(3);
  await openChatAction(page, chatRow(page, CUSTOM), 'Edit group memory');
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await removeChat(page, chatRow(page, INHERITING));
  await expect(chatRow(page, INHERITING)).toHaveCount(0);
  expect((await viewOf(page)).items.find((chat) => chat.id === INHERITING)?.saved ?? null).toBeNull();

  const issues = finish();
  expect(issues.pageErrors).toEqual([]);
  expect(issues.externalRequests).toEqual([]);
});

test('dark theme keeps the summary readable on a phone', async ({ page }, testInfo) => {
  await seedChats(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => {
    localStorage.setItem('admin-theme', 'dark');
  });
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(chatRow(page, CUSTOM)).toBeVisible();
  // Inherited values are quieter than the Chat's own, never the same color.
  const colors = await page.evaluate(
    ({ custom, plain }) => {
      const value = (id: string) => {
        const card = [...document.querySelectorAll('[data-chat-card]')].find((element) =>
          element.textContent?.includes(id),
        );
        const dd = card?.querySelectorAll('dd')[0]?.querySelector('p');
        return dd === null || dd === undefined ? '' : getComputedStyle(dd).color;
      };
      return { own: value(custom), inherited: value(plain) };
    },
    { custom: CUSTOM, plain: INHERITING },
  );
  expect(colors.own).not.toBe('');
  expect(colors.own).not.toBe(colors.inherited);
  const screenshot = testInfo.outputPath('chats-390-dark.png');
  await page.screenshot({ path: screenshot, fullPage: true, animations: 'disabled' });
  await testInfo.attach('chats-390-dark', { path: screenshot, contentType: 'image/png' });
});
