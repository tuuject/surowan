import { expect, measureColumnEdges, openRoute, seedLanguage, test } from './i18n-stress-helpers.ts';

/**
 * Direction handling of the shell and of Koi's own controls, asserted through
 * rendered output rather than Koi internals: the document direction, the
 * sidebar/drawer edge, mirrored chevrons, the Switch thumb and floating panel
 * placement.
 */

test.use({ signedIn: true });

test('Arabic switches the document to RTL and the navigation to the right edge', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await seedLanguage(page, 'ar');
  await openRoute(page, '/');

  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ar');

  const sidebar = page.locator('aside').first();
  await expect(sidebar).toBeVisible();
  const sidebarBox = await sidebar.boundingBox();
  expect(sidebarBox).not.toBeNull();
  if (sidebarBox === null) {
    return;
  }
  // Inline-start is the right edge in RTL: the shell's first column sits there.
  expect(Math.round(sidebarBox.x + sidebarBox.width)).toBeGreaterThanOrEqual(1436);
  expect(Math.round(sidebarBox.x)).toBeGreaterThan(720);

  // The header keeps the trailing controls on the inline-end (left) side.
  const language = page.getByRole('button', { name: 'تبديل اللغة', exact: true });
  const languageBox = await language.boundingBox();
  expect(languageBox).not.toBeNull();
  if (languageBox !== null) {
    expect(languageBox.x).toBeLessThan(720);
  }
});

test('Arabic table columns keep header and cell on the same edge', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await seedLanguage(page, 'ar');
  for (const path of ['/', '/invocations']) {
    await openRoute(page, path);
    const problems = await measureColumnEdges(page);
    expect(problems, `${path}: a cell must align with its own column header`).toEqual([]);
  }
});

/**
 * What the hardened Koi build fixes for RTL, asserted through its rendered
 * output: the mobile navigation opens from the inline-start edge, pagination and
 * breadcrumb chevrons are mirrored and pagination keeps its logical order, and a
 * Switch's thumb sits at the inline-end edge when it is on.
 */
test('Arabic mirrors Koi controls that point along the reading direction', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seedLanguage(page, 'ar');
  await openRoute(page, '/chats');

  await page.getByRole('button', { name: 'فتح التنقل', exact: true }).click();
  const drawer = page.getByRole('dialog').first();
  await expect(drawer).toBeVisible();
  // The drawer slides in; measure once its trailing edge has reached the viewport
  // edge, not mid-animation (`toBeVisible` is already true at the start).
  await expect
    .poll(() =>
      drawer.evaluate((element) => {
        const box = element.getBoundingClientRect();
        return Math.round(box.x + box.width);
      }),
    )
    .toBe(390);
  const drawerBox = await drawer.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return { x: Math.round(box.x), width: Math.round(box.width), right: Math.round(box.x + box.width) };
  });
  // `side="start"` in RTL: flush with the right edge, and the panel's left edge is
  // exactly the viewport width minus its own width (a left-opening drawer would fail both).
  expect(drawerBox.right).toBe(390);
  expect(drawerBox.x).toBe(390 - drawerBox.width);
  expect(drawerBox.width).toBeGreaterThan(200);
  expect(drawerBox.width).toBeLessThan(390);
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();

  const previous = page.getByRole('button', { name: 'الصفحة السابقة', exact: true }).first();
  const next = page.getByRole('button', { name: 'الصفحة التالية', exact: true }).first();
  await expect(previous).toBeVisible();
  const previousBox = await previous.boundingBox();
  const nextBox = await next.boundingBox();
  expect(previousBox).not.toBeNull();
  expect(nextBox).not.toBeNull();
  if (previousBox !== null && nextBox !== null) {
    // RTL row order: the first control sits at the inline-start (right) edge.
    expect(previousBox.x).toBeGreaterThan(nextBox.x);
  }
  const mirrored = async (locator: typeof previous): Promise<boolean> =>
    locator
      .locator('svg')
      .first()
      .evaluate((element) => {
        const transform = getComputedStyle(element).transform;
        return transform.startsWith('matrix(-1') || transform.includes('-1, 0, 0, 1');
      });
  expect(await mirrored(previous)).toBe(true);
  expect(await mirrored(next)).toBe(true);

  const separator = page.locator('.koi-breadcrumb__separator svg').first();
  await expect(separator).toBeVisible();
  expect(await separator.evaluate((element) => getComputedStyle(element).transform)).toContain('-1, 0, 0, 1');

  await openRoute(page, '/harness');
  const switchTrack = page.getByLabel('تذكير الإرسال').locator('xpath=..').locator('.koi-switch__thumb').first();
  await expect(switchTrack).toBeVisible();
  const thumbBox = await switchTrack.boundingBox();
  const trackBox = await page.getByLabel('تذكير الإرسال').boundingBox();
  expect(thumbBox).not.toBeNull();
  expect(trackBox).not.toBeNull();
  if (thumbBox !== null && trackBox !== null) {
    // On in RTL: the thumb rests at the inline-end (left) edge of the track.
    expect(thumbBox.x + thumbBox.width / 2).toBeLessThan(trackBox.x + trackBox.width / 2);
  }
});

test('English keeps unmirrored direction controls', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openRoute(page, '/chats');
  const separator = page.locator('.koi-breadcrumb__separator svg').first();
  await expect(separator).toBeVisible();
  const transform = await separator.evaluate((element) => getComputedStyle(element).transform);
  expect(transform === 'none' || !transform.includes('-1, 0, 0, 1')).toBe(true);
});

test('Arabic floating panels open inside the viewport, next to their trigger', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seedLanguage(page, 'ar');
  await openRoute(page, '/chats');

  const dialogTrigger = page.getByRole('button', { name: 'إضافة محادثة', exact: true });
  await dialogTrigger.click();
  const dialog = page.getByRole('dialog').first();
  await expect(dialog).toBeVisible();
  const dialogBox = await dialog.boundingBox();
  expect(dialogBox).not.toBeNull();
  if (dialogBox !== null) {
    expect(dialogBox.x).toBeGreaterThanOrEqual(0);
    expect(dialogBox.x + dialogBox.width).toBeLessThanOrEqual(390.5);
  }
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  // A Menu panel (the header language menu) opens end-aligned with its trigger.
  const languageTrigger = page.getByRole('button', { name: 'تبديل اللغة', exact: true });
  await languageTrigger.click();
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  const menuBox = await menu.boundingBox();
  const triggerBox = await languageTrigger.boundingBox();
  expect(menuBox).not.toBeNull();
  expect(triggerBox).not.toBeNull();
  if (menuBox !== null && triggerBox !== null) {
    expect(menuBox.x).toBeGreaterThanOrEqual(-0.5);
    expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(390.5);
    expect(menuBox.y).toBeGreaterThanOrEqual(triggerBox.y);
  }
  await page.keyboard.press('Escape');

  // A Select panel (the section jump control at phone width) does the same.
  await openRoute(page, '/harness');
  const jump = page.getByRole('combobox', { name: 'الانتقال إلى القسم', exact: true });
  await jump.click();
  const listbox = page.getByRole('listbox');
  await expect(listbox).toBeVisible();
  const listBox = await listbox.boundingBox();
  expect(listBox).not.toBeNull();
  if (listBox !== null) {
    expect(listBox.x).toBeGreaterThanOrEqual(-0.5);
    expect(listBox.x + listBox.width).toBeLessThanOrEqual(390.5);
  }
});

test('the language menu flips direction without a reload and remembers the choice', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openRoute(page, '/');
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  const timeOrigin = await page.evaluate(() => performance.timeOrigin);

  const pick = async (control: string, language: string): Promise<void> => {
    await page.getByRole('button', { name: control, exact: true }).click();
    await page.getByRole('menuitem', { name: language, exact: true }).click();
  };

  await pick('Switch language', 'العربية');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
  await pick('تبديل اللغة', 'English');
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  await pick('Switch language', 'العربية');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');

  // No navigation happened: the document is the same one the turn started in.
  expect(await page.evaluate(() => performance.timeOrigin)).toBe(timeOrigin);

  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
  await expect(page.getByRole('button', { name: 'تبديل اللغة', exact: true })).toBeVisible();
});

test('German and Chinese keep the LTR document direction', async ({ page }) => {
  await seedLanguage(page, 'de-DE');
  await openRoute(page, '/');
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  await expect(page.locator('html')).toHaveAttribute('lang', 'de-DE');
  await expect(page.getByRole('navigation', { name: 'Hauptnavigation', exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Sprache wechseln', exact: true }).click();
  await page.getByRole('menuitem', { name: '中文', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
});
