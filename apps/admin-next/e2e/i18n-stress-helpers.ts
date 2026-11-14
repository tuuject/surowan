import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, type Page } from '@playwright/test';
import { ar, deDE, en, zhCN } from '../src/locales/resources.ts';
import { adminUrl, test } from './helpers.ts';

/**
 * Shared setup for the German/Arabic layout-stress specs (`33-i18n-stress-*.e2e.ts`).
 *
 * German and Arabic are the layout stress sample: long words and text expansion
 * (German), a real right-to-left layout and bidirectional text (Arabic). The
 * specs check the app shell and its shared components, not translations:
 * catalog integrity (keys, placeholders, plural forms) lives in
 * `src/locales/catalog.test.ts`, where it fails faster and without a browser.
 *
 * Every measured state is a settled one: the target element is visible, fonts
 * are ready and two animation frames have passed, so a measurement never lands
 * in the middle of a width transition or a skeleton swap.
 */

export { expect, test };

export type StressLanguage = 'de-DE' | 'ar';

export const LANGUAGES: readonly StressLanguage[] = ['de-DE', 'ar'];

/** The loading label per language, so the specs can wait for real content. */
const LOADING: Readonly<Record<string, string>> = {
  en: en.common.loading,
  'zh-CN': zhCN.common.loading,
  'de-DE': deDE.common.loading,
  ar: ar.common.loading,
};

export const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'tablet', width: 820, height: 1180 },
  { name: 'phone', width: 390, height: 844 },
] as const;

/** Representative routes: shell + lists + tables + forms + long-form editors. */
export const ROUTES = [
  { path: '/', slug: 'overview' },
  { path: '/warnings', slug: 'warnings' },
  { path: '/invocations', slug: 'invocations' },
  { path: '/contexts', slug: 'contexts' },
  { path: '/messages', slug: 'messages' },
  { path: '/playground', slug: 'playground' },
  { path: '/memories', slug: 'memories' },
  { path: '/group-memories', slug: 'group-memories' },
  { path: '/dictionary', slug: 'dictionary' },
  { path: '/alarms', slug: 'alarms' },
  { path: '/recurring-alarms', slug: 'recurring-alarms' },
  { path: '/image-generate', slug: 'image-generate' },
  { path: '/image-generations', slug: 'image-generations' },
  { path: '/image-settings', slug: 'image-settings' },
  { path: '/models', slug: 'models' },
  { path: '/providers', slug: 'providers' },
  { path: '/prompts', slug: 'prompts' },
  { path: '/harness', slug: 'harness' },
  { path: '/search-settings', slug: 'search-settings' },
  { path: '/telegram', slug: 'telegram' },
  { path: '/chats', slug: 'chats' },
  { path: '/admins', slug: 'admins' },
  { path: '/stickers', slug: 'stickers' },
  { path: '/api-keys', slug: 'api-keys' },
  { path: '/developer', slug: 'developer' },
  { path: '/settings', slug: 'settings' },
  { path: '/preferences', slug: 'preferences' },
] as const;

/** Screenshots are the reviewable artifact; the path is printed once per run. */
export const ARTIFACT_DIR = join(tmpdir(), 'surowan-admin-e2e-results', 'i18n-stress');

export async function seedLanguage(page: Page, language: string): Promise<void> {
  await page.addInitScript((value) => {
    try {
      localStorage.setItem('admin-language', value);
    } catch {
      // storage blocked: the specs already prove the default path
    }
  }, language);
}

/**
 * Navigates and waits until the route has actually rendered its data: `<main>`
 * is the shell and is visible while queries are pending, and fonts plus two
 * frames don't wait for the network. A page still showing a skeleton row or an
 * `aria-busy` region would be measured (and screenshotted) half-empty.
 */
export async function openRoute(page: Page, path: string): Promise<void> {
  await page.goto(await adminUrl(path));
  await expect(page.locator('main h1')).toBeVisible();
  await expect(page.locator('main [aria-busy="true"]')).toHaveCount(0);
  await expect(page.locator('main .koi-skeleton')).toHaveCount(0);
  // Pages such as Harness render their h1 at once and a plain "Loading…" paragraph
  // until the query resolves, without `aria-busy` or a skeleton.
  const language = await page.locator('html').getAttribute('lang');
  const loading = language === null ? undefined : LOADING[language];
  if (loading !== undefined) {
    await expect(page.locator('main')).not.toContainText(loading);
  }
  // Routes with a table render either real rows or the empty-state row.
  const tables = await page.locator('main table').count();
  if (tables > 0) {
    await expect(page.locator('main table tbody tr').first()).toBeVisible();
  }
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        void document.fonts.ready.then(() => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        });
      }),
  );
}

interface OverflowReport {
  readonly page: { readonly scrollWidth: number; readonly clientWidth: number };
  readonly clipped: readonly string[];
}

/**
 * Two independent failures: the page itself scrolls sideways (a child that
 * refuses to shrink), and a control paints its own text outside its box
 * (overflow visible, so the text overlaps whatever sits next to it).
 */
async function measureOverflow(page: Page): Promise<OverflowReport> {
  return page.evaluate(() => {
    const scrolling = document.scrollingElement ?? document.documentElement;
    const clipped: string[] = [];
    const candidates = document.querySelectorAll<HTMLElement>(
      'button, a[href], th, td, label, summary, [role="tab"], [role="menuitem"], [role="option"], .koi-badge__root, .koi-tag__root',
    );
    for (const element of candidates) {
      const style = getComputedStyle(element);
      if (style.visibility === 'hidden' || style.display === 'none') {
        continue;
      }
      // A table cell clips whatever doesn't fit, so its own overflow setting is
      // not a reason to skip it; controls that scroll on purpose are.
      const isCell = element.tagName === 'TD';
      if (!isCell && style.overflowX !== 'visible') {
        continue;
      }
      const text = (element.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (text.length === 0) {
        continue;
      }
      if (element.scrollWidth > element.clientWidth + 1) {
        const index = element.parentElement === null ? 0 : [...element.parentElement.children].indexOf(element);
        const header = element.closest('table')?.querySelectorAll('thead th')[isCell ? index : 0];
        clipped.push(
          `<${element.tagName.toLowerCase()}${isCell ? ` col="${header?.textContent?.slice(0, 12) ?? ''}"` : ''}> "${text.slice(0, 40)}" ${element.scrollWidth}>${element.clientWidth}`,
        );
      }
    }
    return {
      page: { scrollWidth: scrolling.scrollWidth, clientWidth: scrolling.clientWidth },
      clipped: clipped.slice(0, 8),
    };
  });
}

export async function expectNoOverflow(page: Page, label: string): Promise<void> {
  const report = await measureOverflow(page);
  expect(
    { page: report.page.scrollWidth - report.page.clientWidth, clipped: report.clipped },
    `${label}: horizontal page overflow or clipped control text`,
  ).toEqual({ page: 0, clipped: [] });
}

export interface MisalignedColumn {
  readonly column: string;
  readonly side: string;
  readonly headerOffset: number;
  readonly cellOffset: number;
}

/**
 * Column alignment: the header text and the cell content must start (or end, or
 * centre) at the same distance from the cell's edge. That is what per-cell
 * `unicode-bidi: plaintext` would break — an LTR-only cell (a badge, an id, a
 * timestamp) then aligns left in an RTL table while its header aligns right.
 */
export async function measureColumnEdges(page: Page): Promise<MisalignedColumn[]> {
  return page.evaluate(() => {
    const problems: MisalignedColumn[] = [];
    const rtl = getComputedStyle(document.documentElement).direction === 'rtl';
    const textBounds = (element: Element): { left: number; right: number } | null => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const rects = [...range.getClientRects()].filter((rect) => rect.width > 0 || rect.height > 0);
      if (rects.length === 0) {
        return null;
      }
      return {
        left: Math.min(...rects.map((rect) => rect.left)),
        right: Math.max(...rects.map((rect) => rect.right)),
      };
    };
    for (const table of document.querySelectorAll('main table')) {
      const row = table.querySelector('tbody tr');
      const headers = [...table.querySelectorAll('thead th')];
      if (row === null) {
        continue;
      }
      headers.forEach((header, index) => {
        const cell = (row as HTMLTableRowElement).cells[index];
        const label = (header.textContent ?? '').trim();
        if (cell === undefined || label.length === 0) {
          return;
        }
        const cellBox = cell.getBoundingClientRect();
        // The content *box* of an element child (a badge has its own padding);
        // bare text is measured through its glyph bounds.
        const contentElement = cell.firstElementChild;
        const contentRect = contentElement === null ? null : contentElement.getBoundingClientRect();
        const contentBounds =
          contentElement === null
            ? textBounds(cell)
            : contentRect === null || contentRect.width === 0
              ? textBounds(contentElement)
              : { left: contentRect.left, right: contentRect.right };
        const headerBounds = textBounds(header);
        if (contentBounds === null || headerBounds === null || cellBox.width === 0) {
          return;
        }
        const align = getComputedStyle(cell).textAlign;
        const side =
          align === 'center'
            ? 'center'
            : align === 'left'
              ? 'left'
              : align === 'right'
                ? 'right'
                : align === 'end'
                  ? rtl
                    ? 'left'
                    : 'right'
                  : rtl
                    ? 'right'
                    : 'left';
        const headerOffset =
          side === 'right'
            ? header.getBoundingClientRect().right - headerBounds.right
            : side === 'left'
              ? headerBounds.left - header.getBoundingClientRect().left
              : (header.getBoundingClientRect().left + header.getBoundingClientRect().right) / 2 -
                (headerBounds.left + headerBounds.right) / 2;
        const cellOffset =
          side === 'right'
            ? cellBox.right - contentBounds.right
            : side === 'left'
              ? contentBounds.left - cellBox.left
              : (cellBox.left + cellBox.right) / 2 - (contentBounds.left + contentBounds.right) / 2;
        if (Math.abs(headerOffset - cellOffset) > 4) {
          problems.push({
            column: label,
            side,
            headerOffset: Math.round(headerOffset),
            cellOffset: Math.round(cellOffset),
          });
        }
      });
    }
    return problems;
  });
}

export async function screenshot(page: Page, language: string, viewport: string, route: string): Promise<void> {
  await mkdir(ARTIFACT_DIR, { recursive: true });
  await page.screenshot({
    path: join(ARTIFACT_DIR, `${language}__${viewport}__${route}.png`),
    fullPage: true,
    animations: 'disabled',
  });
}
