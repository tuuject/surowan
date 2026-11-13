import { expect } from '@playwright/test';
import { adminUrl, clickNav, e2eFetch, test } from './helpers.ts';

test.use({ signedIn: true });

async function harnessApi(page: import('@playwright/test').Page) {
  return (await (await page.request.get(await adminUrl('/api/harness'))).json()) as {
    saved: Record<string, unknown>;
    active: Record<string, unknown>;
  };
}

const SECTION_TITLES = [
  'Budget and concurrency',
  'Send behavior',
  'Rate limits',
  'Context',
  'Proactive replies',
] as const;

test('Harness scrollspy follows downward scrolling until the real scroll limit', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(await adminUrl('/harness'));
  const nav = page.getByRole('navigation', { name: 'Form sections' });
  await expect(nav).toBeVisible();
  await page.mouse.move(1100, 450);
  for (const id of ['budget', 'send', 'rateLimits', 'context']) {
    const delta = await page
      .locator(`[data-form-section="${id}"]`)
      .evaluate((el) => el.getBoundingClientRect().top - Number.parseFloat(getComputedStyle(el).scrollMarginTop) + 1);
    if (delta > 0) {
      await page.mouse.wheel(0, delta);
    }
    await expect(nav.locator('[aria-current="location"]')).toHaveText(
      SECTION_TITLES[['budget', 'send', 'rateLimits', 'context'].indexOf(id)] ?? '',
    );
  }
  // Put the final section fully on screen while Context still crosses the header line.
  const delta = await page
    .locator('[data-form-section="proactiveReply"]')
    .evaluate((el) => el.getBoundingClientRect().bottom - window.innerHeight + 1);
  await page.mouse.wheel(0, delta);
  await expect
    .poll(() =>
      page
        .locator('[data-form-section="proactiveReply"]')
        .evaluate((el) => el.getBoundingClientRect().bottom <= window.innerHeight),
    )
    .toBe(true);
  expect(
    await page.locator('[data-form-section="context"]').evaluate((el) => {
      const rect = el.getBoundingClientRect();
      const line = Number.parseFloat(getComputedStyle(el).scrollMarginTop);
      const scroller = document.scrollingElement;
      return (
        rect.top < line &&
        rect.bottom > line &&
        scroller !== null &&
        scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop > 1
      );
    }),
  ).toBe(true);
  await expect(nav.locator('[aria-current="location"]')).toHaveText('Context');
  await page.screenshot({ path: testInfo.outputPath('harness-context-before-scroll-limit.png') });
  await page.mouse.wheel(0, await page.evaluate(() => document.documentElement.scrollHeight));
  await expect(nav.locator('[aria-current="location"]')).toHaveText('Proactive replies');
});

for (const { scrollend, reducedMotion } of [
  { scrollend: true, reducedMotion: 'reduce' },
  { scrollend: false, reducedMotion: 'reduce' },
  { scrollend: false, reducedMotion: 'no-preference' },
] as const) {
  test(`Harness releases an aligned jump before scrollbar scrolling (scrollend=${scrollend}, motion=${reducedMotion})`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ reducedMotion });
    if (!scrollend) {
      await page.addInitScript(() => {
        window.addEventListener('scrollend', (event) => event.stopImmediatePropagation(), true);
      });
    }
    await page.goto(await adminUrl('/harness'));
    const nav = page.getByRole('navigation', { name: 'Form sections' });
    const send = nav.getByRole('button', { name: 'Send behavior', exact: true });
    await send.click();
    await expect
      .poll(() =>
        page
          .locator('[data-form-section="send"]')
          .evaluate((el) =>
            Math.abs(el.getBoundingClientRect().top - Number.parseFloat(getComputedStyle(el).scrollMarginTop)),
          ),
      )
      .toBeLessThanOrEqual(1);
    // Wait for the first jump to settle, then click the already aligned target.
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        }),
    );
    const aligned = await page.evaluate(() => document.scrollingElement?.scrollTop);
    await send.click();
    expect(await page.evaluate(() => document.scrollingElement?.scrollTop)).toBe(aligned);
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        }),
    );
    await page.locator('[data-form-section="rateLimits"]').evaluate((el) => {
      const scroller = document.scrollingElement;
      if (scroller) {
        scroller.scrollTop +=
          el.getBoundingClientRect().top - Number.parseFloat(getComputedStyle(el).scrollMarginTop) + 1;
      }
    });
    await expect(nav.locator('[aria-current="location"]')).toHaveText('Rate limits');
  });
}

test('Harness section navigation jumps, focuses headings and follows scrolling', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(await adminUrl('/harness'));
  const nav = page.getByRole('navigation', { name: 'Form sections' });
  await expect(nav.getByRole('button')).toHaveText(SECTION_TITLES);
  await expect(page.getByRole('combobox', { name: 'Jump to section' })).toBeHidden();
  for (const title of SECTION_TITLES) {
    const entry = nav.getByRole('button', { name: title, exact: true });
    await entry.click();
    await expect(entry).toHaveAttribute('aria-current', 'location');
    const heading = page.getByRole('heading', { name: title, exact: true });
    await expect(heading).toBeFocused();
    await expect(heading).toBeInViewport();
    expect(
      await heading.evaluate((el) => {
        const header = document.querySelector('header');
        return el.getBoundingClientRect().top >= (header?.getBoundingClientRect().bottom ?? 0);
      }),
    ).toBe(true);
  }
  // User scrolling releases the last jump's selection, including at the short final section.
  await page.mouse.move(1100, 450);
  await page.mouse.wheel(0, -20000);
  await expect(nav.getByRole('button', { name: SECTION_TITLES[0], exact: true })).toHaveAttribute(
    'aria-current',
    'location',
  );

  await page.getByLabel('Reference lifetime (hours)').fill('721');
  const context = nav.getByRole('button', { name: /^Context/ });
  await expect(context).toHaveAccessibleName(/Context\s*, needs correction/);
  await page.getByLabel('Reference lifetime (hours)').fill('24');
  await expect(context).toHaveAccessibleName(/Context\s*, unsaved changes/);
  await page.getByRole('button', { name: 'Discard changes' }).click();
  await expect(context).toHaveAccessibleName('Context');
  await page.screenshot({ path: testInfo.outputPath('harness-section-navigation-wide.png'), fullPage: true });
});

test('Harness section dropdown responds to container width and shows validation marks', async ({ page }, testInfo) => {
  // The viewport is wider than 720px, but the expanded sidebar leaves a narrow form container.
  await page.setViewportSize({ width: 1000, height: 900 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(await adminUrl('/harness'));
  const nav = page.getByRole('navigation', { name: 'Form sections' });
  const menu = page.getByRole('combobox', { name: 'Jump to section' });
  await expect(nav).toBeHidden();
  await expect(menu).toContainText('Budget and concurrency');
  await menu.click();
  await expect(page.getByRole('listbox').getByRole('option')).toHaveText(SECTION_TITLES);
  await page.getByRole('option', { name: 'Context', exact: true }).click();
  await expect(menu).toContainText('Context');
  await expect(page.getByRole('heading', { name: 'Context', exact: true })).toBeInViewport();
  await page.getByLabel('Reference lifetime (hours)').fill('721');
  await expect(menu).toContainText('needs correction');
  await menu.click();
  await expect(page.getByRole('option', { name: /Context\s*, needs correction/ })).toBeVisible();
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();
  await expect(nav).toBeVisible();
  await expect(menu).toBeHidden();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(nav).toBeHidden();
  await expect(menu).toBeVisible();
  await menu.click();
  await page.getByRole('option', { name: 'Proactive replies', exact: true }).click();
  await expect(menu).toContainText('Proactive replies');
  await expect(page.getByRole('heading', { name: 'Proactive replies', exact: true })).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath('harness-section-navigation-mobile.png'), fullPage: true });
});

test('Harness navigation fits both languages and themes at desktop and phone widths', async ({ page }, testInfo) => {
  await page.goto(await adminUrl('/harness'));
  await expect(page.getByLabel('Daily token budget')).toBeVisible();
  for (const language of ['en', 'zh-CN']) {
    if (language === 'zh-CN') {
      await page.getByRole('button', { name: 'Switch language' }).click();
    }
    for (const theme of ['light', 'dark']) {
      await page.evaluate((value) => {
        document.documentElement.dataset.theme = value;
        document.documentElement.dataset.palette = 'rose';
      }, theme);
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 900 });
        const title = language === 'en' ? 'Budget and concurrency' : '预算与并发';
        const nav = page.getByRole('navigation', { name: language === 'en' ? 'Form sections' : '表单分区' });
        const menu = page.getByRole('combobox', { name: language === 'en' ? 'Jump to section' : '跳转到分区' });
        const control = width === 1440 ? nav.getByRole('button').first() : menu;
        await expect(control).toBeVisible();
        await expect(width === 1440 ? menu : nav).toBeHidden();
        await expect(control).toContainText(title);
        // Portal tooltips can retain their old coordinates until resize positioning finishes.
        await expect
          .poll(() => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth))
          .toBeLessThanOrEqual(0);
        await page.screenshot({ path: testInfo.outputPath(`harness-nav-${language}-${theme}-${width}.png`) });
      }
    }
  }
});

test('Harness tuning saves several fields at once and hot-applies them', async ({ page }, testInfo) => {
  await page.goto(await adminUrl('/'));
  await clickNav(page, 'Agent setup', 'Harness tuning');
  const ttl = page.getByLabel('Reference lifetime (hours)');
  const cache = page.getByLabel('Memory cache size');
  const nudge = page.getByRole('switch', { name: 'Send reminder' });
  const save = page.getByRole('button', { name: 'Save and apply' });
  await expect(ttl).toHaveValue('72');
  await expect(nudge).toBeChecked();
  await expect(page.getByLabel('Max text length')).toHaveValue('');
  await expect(save).toBeDisabled();
  await page.screenshot({ path: testInfo.outputPath('harness-desktop.png'), fullPage: true });

  await ttl.fill('24');
  await cache.fill('2');
  await nudge.click();
  await expect(page.getByText('3 unsaved changes')).toBeVisible();
  await save.click();
  await expect(page.getByText('No unsaved changes')).toBeVisible();
  await expect(ttl).toHaveValue('24');
  const applied = await harnessApi(page);
  expect(applied.saved).toMatchObject({
    'context.ref_ttl_hours': 24,
    'context.agent_cache_size': 2,
    send_nudge_enabled: false,
  });
  expect(applied.active).toEqual(applied.saved);

  await page.reload();
  await expect(ttl).toHaveValue('24');
  await expect(nudge).not.toBeChecked();
  // Discarding restores the saved file values.
  await ttl.fill('48');
  await page.getByRole('button', { name: 'Discard changes' }).click();
  await expect(ttl).toHaveValue('24');
});

test('Harness tuning flags invalid input locally and reports cross-field errors from the server', async ({ page }) => {
  await page.goto(await adminUrl('/harness'));
  const ttl = page.getByLabel('Reference lifetime (hours)');
  await ttl.fill('721');
  await expect(page.getByText('Must be at most 720')).toBeVisible();
  await expect(page.getByText('Fix the highlighted fields before saving.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save and apply' })).toBeDisabled();
  await ttl.fill('72');

  // Schema-valid on its own, invalid next to retained_sends_max = 3.
  await page.getByLabel('Retained sends target').fill('3');
  await page.getByRole('button', { name: 'Save and apply' }).click();
  await expect(page.getByRole('alert')).toContainText('retained_sends_target must be smaller than retained_sends_max');
  expect((await harnessApi(page)).saved).toMatchObject({ 'context.retained_sends_target': 2 });
});

test('Harness tuning shows the running value when a save was written but not applied', async ({ page }) => {
  await page.goto(await adminUrl('/harness'));
  await e2eFetch('/fail-next-config-apply', { method: 'POST' });
  await page.getByLabel('History messages').fill('9');
  await page.getByRole('button', { name: 'Save and apply' }).click();
  await expect(page.getByRole('alert')).toContainText('updated but not applied');
  await expect(page.getByLabel('History messages')).toHaveValue('9');
  await expect(page.getByRole('status').filter({ hasText: 'Running: 20' })).toBeVisible();

  await clickNav(page, 'System', 'Settings');
  await page.getByRole('button', { name: 'Apply config file' }).click();
  await expect(page.getByText('agent.history_messages', { exact: false })).toBeVisible();
  await clickNav(page, 'Agent setup', 'Harness tuning');
  await expect(page.getByRole('status').filter({ hasText: 'Running:' })).toHaveCount(0);
});

test('Harness tuning edits the empty-text strategy and fallback list', async ({ page }) => {
  await page.goto(await adminUrl('/harness'));
  const strategy = page.getByRole('combobox', { name: 'Empty-text sends' });
  const texts = page.getByLabel('Fallback texts');
  await expect(strategy).toHaveValue('reject');
  await expect(texts).toHaveValue('……');

  await texts.fill('  \n ');
  await expect(page.getByText('Enter at least one line')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save and apply' })).toBeDisabled();

  await strategy.selectOption('random_text');
  await texts.fill('……\n 嗯 \n\n啊这');
  await expect(page.getByText('2 unsaved changes')).toBeVisible();
  await page.getByRole('button', { name: 'Save and apply' }).click();
  await expect(page.getByText('No unsaved changes')).toBeVisible();
  await expect(texts).toHaveValue('……\n嗯\n啊这');
  const applied = await harnessApi(page);
  expect(applied.saved).toMatchObject({
    send_empty_text_strategy: 'random_text',
    send_empty_text_fallback_texts: ['……', '嗯', '啊这'],
  });
  expect(applied.active).toEqual(applied.saved);
});

test('Harness tuning edits the global proactive reply defaults', async ({ page }) => {
  await page.goto(await adminUrl('/harness'));
  const enabled = page.getByRole('switch', { name: 'Schedule proactive replies' });
  const base = page.getByLabel('First-try chance');
  const pity = page.getByLabel('Maximum tries');
  // Absent from the fixture file: the runtime defaults are shown.
  await expect(enabled).not.toBeChecked();
  await expect(base).toHaveValue('0.2');
  await expect(page.getByLabel('Increase after each miss')).toHaveValue('0.1');
  await expect(pity).toHaveValue('8');

  await base.fill('1.5');
  await expect(page.getByText('Must be at most 1')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save and apply' })).toBeDisabled();

  await enabled.click();
  await base.fill('0.35');
  await pity.fill('5');
  await page.getByRole('button', { name: 'Save and apply' }).click();
  await expect(page.getByText('No unsaved changes')).toBeVisible();
  const applied = await harnessApi(page);
  expect(applied.saved).toMatchObject({
    'proactive_reply.enabled': true,
    'proactive_reply.base_probability': 0.35,
    'proactive_reply.increment': 0.1,
    'proactive_reply.hard_pity': 5,
  });
  expect(applied.active).toEqual(applied.saved);
});
