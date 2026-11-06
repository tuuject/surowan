import { expect, type Page } from '@playwright/test';
import { adminUrl, test } from './helpers.ts';

/**
 * The Koi shell's language switch must reach every navigation label and
 * survive a reload, and the menu must stay complete: same destinations, order
 * and hierarchy as the pre-Koi sidebar.
 */
test.use({ signedIn: true });

const EN_LABELS = [
  'Overview',
  'Warnings',
  'Tool sessions',
  'Contexts',
  'Messages',
  'Playground',
  'Memories',
  'Group memory',
  'Dictionary',
  'Alarms',
  'Bot sticker sets',
  'Image generation',
  'Image generations',
  'Image settings',
  'Models',
  'Prompts',
  'Harness tuning',
  'Web search',
  'Telegram',
  'Chats',
  'Bot admins',
  'API keys',
  'Developer',
  'Settings',
  'Panel preferences',
];

const ROUTES = [
  '/',
  '/warnings',
  '/invocations',
  '/contexts',
  '/messages',
  '/playground',
  '/memories',
  '/group-memories',
  '/dictionary',
  '/alarms',
  '/stickers',
  '/image-generate',
  '/image-generations',
  '/image-settings',
  '/models',
  '/prompts',
  '/harness',
  '/search-settings',
  '/telegram',
  '/chats',
  '/admins',
  '/api-keys',
  '/developer',
  '/settings',
  '/preferences',
];

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
];

const EN_GROUPS = [
  { label: 'Monitor', routes: ['/', '/warnings'] },
  { label: 'Activity', routes: ['/invocations', '/contexts', '/messages', '/playground'] },
  { label: 'Agent data', routes: ['/memories', '/group-memories', '/dictionary', '/alarms'] },
  { label: 'Media', routes: ['/stickers', '/image-generate', '/image-generations', '/image-settings'] },
  { label: 'Agent setup', routes: ['/models', '/prompts', '/harness', '/search-settings'] },
  { label: 'Telegram', routes: ['/telegram', '/chats', '/admins'] },
  { label: 'System', routes: ['/api-keys', '/developer', '/settings', '/preferences'] },
];

const ZH_GROUPS = [
  { label: '监控', routes: ['/', '/warnings'] },
  { label: '运行记录', routes: ['/invocations', '/contexts', '/messages', '/playground'] },
  { label: 'Agent 数据', routes: ['/memories', '/group-memories', '/dictionary', '/alarms'] },
  { label: '媒体', routes: ['/stickers', '/image-generate', '/image-generations', '/image-settings'] },
  { label: 'Agent 配置', routes: ['/models', '/prompts', '/harness', '/search-settings'] },
  { label: 'Telegram', routes: ['/telegram', '/chats', '/admins'] },
  { label: '系统', routes: ['/api-keys', '/developer', '/settings', '/preferences'] },
];

function mainNav(page: Page) {
  return page.getByRole('navigation', { name: 'Main navigation' });
}

/** Group headings and the links inside each group, in DOM order. */
async function navHierarchy(page: Page, label: string) {
  return page
    .getByRole('navigation', { name: label })
    .locator('ul[aria-labelledby]')
    .evaluateAll((lists) =>
      lists.map((list) => {
        const labelId = list.getAttribute('aria-labelledby');
        const groupLabel = labelId === null ? null : (document.getElementById(labelId)?.textContent?.trim() ?? null);
        return {
          label: groupLabel,
          routes: Array.from(list.querySelectorAll(':scope > li > a')).map((link) => link.getAttribute('href')),
        };
      }),
    );
}

test('language switch re-labels the whole navigation and persists', async ({ page }) => {
  await page.goto(await adminUrl('/'));
  const nav = mainNav(page);
  await expect(nav.getByRole('link')).toHaveText(EN_LABELS);
  const hrefs = await nav.getByRole('link').evaluateAll((links) => links.map((link) => link.getAttribute('href')));
  expect(hrefs).toEqual(ROUTES);
  expect(await navHierarchy(page, 'Main navigation')).toEqual(EN_GROUPS);

  await page.getByRole('button', { name: 'Switch language' }).click();
  await expect(page.getByRole('navigation', { name: '主导航' }).getByRole('link')).toHaveText(ZH_LABELS);
  expect(await navHierarchy(page, '主导航')).toEqual(ZH_GROUPS);
  expect(await page.evaluate(() => localStorage.getItem('admin-language'))).toBe('zh-CN');
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');

  await page.reload();
  await expect(page.getByRole('navigation', { name: '主导航' }).getByRole('link')).toHaveText(ZH_LABELS);
  expect(await navHierarchy(page, '主导航')).toEqual(ZH_GROUPS);
  await expect(page.getByRole('button', { name: '切换语言' })).toBeVisible();

  await page.getByRole('button', { name: '切换语言' }).click();
  await expect(page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link')).toHaveText(EN_LABELS);
  expect(await navHierarchy(page, 'Main navigation')).toEqual(EN_GROUPS);
  expect(await page.evaluate(() => localStorage.getItem('admin-language'))).toBe('en');
});
