import { expect, type Page } from '@playwright/test';
import { adminUrl, test } from './helpers.ts';

/** Parent/children navigation, language switching and all three shell surfaces. */
test.use({ signedIn: true });

interface NavGroup {
  readonly label: string;
  readonly routes: readonly string[];
  readonly labels: readonly string[];
}

const EN_GROUPS: readonly NavGroup[] = [
  {
    label: 'Monitor',
    routes: ['/', '/warnings'],
    labels: ['Overview', 'Warnings'],
  },
  {
    label: 'Activity',
    routes: ['/invocations', '/contexts', '/messages', '/playground'],
    labels: ['Tool sessions', 'Contexts', 'Messages', 'Playground'],
  },
  {
    label: 'Agent data',
    routes: ['/memories', '/group-memories', '/dictionary', '/alarms'],
    labels: ['Memories', 'Group memory', 'Dictionary', 'Alarms'],
  },
  {
    label: 'Media',
    routes: ['/stickers', '/image-generate', '/image-generations', '/image-settings'],
    labels: ['Bot sticker sets', 'Image generation', 'Image generations', 'Image settings'],
  },
  {
    label: 'Agent setup',
    routes: ['/models', '/prompts', '/harness', '/search-settings'],
    labels: ['Models', 'Prompts', 'Harness tuning', 'Web search'],
  },
  {
    label: 'Telegram',
    routes: ['/telegram', '/chats', '/admins'],
    labels: ['Telegram', 'Chats', 'Bot admins'],
  },
  {
    label: 'System',
    routes: ['/api-keys', '/developer', '/settings', '/preferences'],
    labels: ['API keys', 'Developer', 'Settings', 'Panel preferences'],
  },
] as const;

const ZH_GROUP_LABELS = ['监控', '运行记录', '数据', '媒体', 'Agent', 'Telegram', '系统'] as const;
const ZH_LABELS = [
  '概览',
  '警告',
  '调用记录',
  '上下文',
  '消息',
  '虚拟群聊',
  '记忆',
  '群聊记忆',
  '辞典',
  '告警',
  'Bot 贴纸包',
  '图片生成',
  '生图记录',
  '图片设置',
  '模型',
  'Prompt',
  'Harness 微调',
  '网络搜索',
  'Telegram',
  '会话',
  'Bot 管理员',
  'API 密钥',
  '开发者',
  '设置',
  '面板偏好',
] as const;

function mainNav(page: Page, label = 'Main navigation') {
  return page.getByRole('navigation', { name: label, exact: true });
}

async function setGroup(page: Page, label: string, open: boolean, navLabel = 'Main navigation') {
  const trigger = mainNav(page, navLabel).getByRole('button', { name: label, exact: true });
  if ((await trigger.getAttribute('aria-expanded')) !== String(open)) {
    await trigger.click();
  }
  await expect(trigger).toHaveAttribute('aria-expanded', String(open));
  return trigger;
}

async function expectGroupRoutes(page: Page, group: NavGroup, navLabel = 'Main navigation') {
  const nav = mainNav(page, navLabel);
  const trigger = nav.getByRole('button', { name: group.label, exact: true });
  await expect(trigger).toHaveAttribute('aria-controls', /.+/);
  const panelId = await trigger.getAttribute('aria-controls');
  if (panelId === null) {
    throw new Error(`Missing disclosure panel for ${group.label}`);
  }
  const panel = nav.locator(`[id="${panelId}"]`);
  await expect(panel.locator('a[href]')).toHaveText(group.labels);
  const hrefs = await panel.locator('a[href]').evaluateAll((links) => links.map((link) => link.getAttribute('href')));
  expect(hrefs).toEqual(group.routes);
  for (const route of group.routes) {
    await expect(panel.locator(`a[href="${route}"]`)).toBeVisible();
  }
}

test('seven parent groups collapse, expand, preserve order and open the current route group', async ({ page }) => {
  await page.goto(await adminUrl('/memories'));
  const nav = mainNav(page);
  const parents = nav.getByRole('button', {
    name: /^(Monitor|Activity|Agent data|Media|Agent setup|Telegram|System)$/,
  });
  await expect(parents).toHaveCount(7);
  await expect(parents).toHaveText(EN_GROUPS.map((group) => group.label));
  expect(EN_GROUPS.flatMap((group) => group.routes)).toHaveLength(25);
  await expect(nav.getByRole('button', { name: 'Agent data', exact: true }).locator('svg').first()).toBeVisible();

  const current = nav.getByRole('button', { name: 'Agent data', exact: true });
  const inactive = nav.getByRole('button', { name: 'Monitor', exact: true });
  await expect(current).toHaveAttribute('aria-expanded', 'true');
  await expect(inactive).toHaveAttribute('aria-expanded', 'false');
  expect(await current.getAttribute('class')).not.toEqual(await inactive.getAttribute('class'));
  await expect(nav.locator('a[href="/memories"]')).toHaveAttribute('aria-current', 'page');

  for (const group of EN_GROUPS) {
    const trigger = await setGroup(page, group.label, true);
    await expectGroupRoutes(page, group);
    await trigger.focus();
    await page.keyboard.press('Enter');
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await expect(nav.locator(`a[href="${group.routes[0]}"]`)).toBeHidden();
    await page.keyboard.press('Space');
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await expectGroupRoutes(page, group);
  }
  await expect(nav.getByRole('link')).toHaveCount(25);
});

test('language switch re-labels parents and children immediately and persists', async ({ page }) => {
  await page.goto(await adminUrl('/'));
  for (const group of EN_GROUPS) {
    await setGroup(page, group.label, true);
  }
  const nav = mainNav(page);
  await expect(nav.getByRole('link')).toHaveText(EN_GROUPS.flatMap((group) => [...group.labels]));
  await page.getByRole('button', { name: 'Switch language' }).click();

  const zhNav = mainNav(page, '主导航');
  for (const [index, label] of ZH_GROUP_LABELS.entries()) {
    const group = EN_GROUPS[index];
    if (group === undefined) {
      throw new Error(`Missing navigation fixture at ${index}`);
    }
    await expect(zhNav.getByRole('button', { name: label, exact: true })).toHaveAttribute('aria-expanded', 'true');
    await expectGroupRoutes(
      page,
      {
        ...group,
        label,
        labels: ZH_LABELS.slice(
          EN_GROUPS.slice(0, index).reduce((sum, item) => sum + item.labels.length, 0),
          EN_GROUPS.slice(0, index + 1).reduce((sum, item) => sum + item.labels.length, 0),
        ),
      },
      '主导航',
    );
  }
  await expect(zhNav.getByRole('link')).toHaveText(ZH_LABELS);
  expect(await page.evaluate(() => localStorage.getItem('admin-language'))).toBe('zh-CN');
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');

  await page.reload();
  await expect(mainNav(page, '主导航').getByRole('button', { name: 'Agent 数据', exact: true })).toBeVisible();
  for (const [index, label] of ZH_GROUP_LABELS.entries()) {
    const group = EN_GROUPS[index];
    if (group === undefined) {
      throw new Error(`Missing navigation fixture at ${index}`);
    }
    await setGroup(page, label, true, '主导航');
    await expectGroupRoutes(
      page,
      {
        ...group,
        label,
        labels: ZH_LABELS.slice(
          EN_GROUPS.slice(0, index).reduce((sum, item) => sum + item.labels.length, 0),
          EN_GROUPS.slice(0, index + 1).reduce((sum, item) => sum + item.labels.length, 0),
        ),
      },
      '主导航',
    );
  }
  await expect(mainNav(page, '主导航').getByRole('link')).toHaveText(ZH_LABELS);
  await page.getByRole('button', { name: '切换语言' }).click();
  await expect(mainNav(page).getByRole('button', { name: 'Monitor', exact: true })).toBeVisible();
  for (const group of EN_GROUPS) {
    await setGroup(page, group.label, true);
    await expectGroupRoutes(page, group);
  }
  await expect(mainNav(page).getByRole('link')).toHaveText(EN_GROUPS.flatMap((group) => [...group.labels]));
  expect(await page.evaluate(() => localStorage.getItem('admin-language'))).toBe('en');
});

test('horizontal navigation uses parent flyouts with the same child routes', async ({ page }) => {
  await page.goto(await adminUrl('/'));
  await page.getByRole('button', { name: 'Switch to horizontal navigation' }).click();
  const nav = mainNav(page);
  const parent = nav.getByRole('button', { name: 'Agent data', exact: true });
  await parent.click();
  const memories = page.getByRole('menuitem', { name: 'Memories', exact: true });
  await expect(memories).toBeVisible();
  await expect(memories).toHaveAttribute('href', '/memories');
  await memories.click();
  await expect(page).toHaveURL(/\/memories$/);
  const activeClass = await nav.getByRole('button', { name: 'Agent data', exact: true }).getAttribute('class');
  const inactiveClass = await nav.getByRole('button', { name: 'Monitor', exact: true }).getAttribute('class');
  expect(activeClass).not.toEqual(inactiveClass);
});

test('collapsed rail keeps parent flyouts and localized children', async ({ page }) => {
  await page.goto(await adminUrl('/memories'));
  await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();
  const nav = mainNav(page);
  await nav.getByRole('button', { name: 'Agent data', exact: true }).click();
  const dictionary = page.getByRole('menuitem', { name: 'Dictionary', exact: true });
  await expect(dictionary).toBeVisible();
  await expect(dictionary).toHaveAttribute('href', '/dictionary');
  await dictionary.click();
  await expect(page).toHaveURL(/\/dictionary$/);

  await page.getByRole('button', { name: 'Switch language' }).click();
  await mainNav(page, '主导航').getByRole('button', { name: 'Agent 数据', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: '辞典', exact: true })).toBeVisible();
});

test('mobile drawer keeps parent disclosure, active route and keyboard-accessible children', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(await adminUrl('/memories'));
  await page.getByRole('button', { name: 'Open navigation' }).click();
  const nav = mainNav(page);
  const current = nav.getByRole('button', { name: 'Agent data', exact: true });
  await expect(current).toHaveAttribute('aria-expanded', 'true');
  await expect(nav.locator('a[href="/memories"]')).toHaveAttribute('aria-current', 'page');

  const monitor = await setGroup(page, 'Monitor', true);
  await expect(monitor).toBeFocused();
  const warnings = nav.locator('a[href="/warnings"]');
  await expect(warnings).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(nav.locator('a[href="/"]')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(warnings).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/warnings$/);
  await expect(mainNav(page)).toHaveCount(0);
});
