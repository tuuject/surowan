import { ar } from '../src/locales/resources.ts';
import { adminUrl } from './helpers.ts';
import { expect, openRoute, seedLanguage, test } from './i18n-stress-helpers.ts';

/**
 * Bidirectional text: technical strings stay in reading order inside Arabic UI,
 * sentences with a timestamp keep their markup instead of printing `<time>`, and
 * the chart's label column follows its content.
 */

test.use({ signedIn: true });

test('Arabic isolates technical strings and directions its inputs', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await seedLanguage(page, 'ar');
  await openRoute(page, '/providers');

  const providers = await (await page.request.get(await adminUrl('/api/providers'))).json();
  const modelIds: string[] = (providers as { providers: Array<{ models: Array<{ id: string }> }> }).providers.flatMap(
    (provider) => provider.models.map((model) => model.id),
  );
  expect(modelIds.length).toBeGreaterThan(0);

  const isolated = page.locator('[data-model-list] bdi[dir="ltr"]');
  await expect(isolated.first()).toBeVisible();
  const texts = await isolated.allTextContents();
  // Exactly the stored id: markup isolation, no invisible control characters.
  for (const text of texts) {
    expect(modelIds).toContain(text);
    expect(text).not.toMatch(/[\u2066-\u2069]/);
  }

  // A technical input (the model id) is LTR; a free-text input follows its content.
  await page
    .locator('[data-model-list]')
    .getByRole('button', { name: /^(تعديل|Edit) / })
    .first()
    .click();
  const idInput = page.getByLabel('معرّف النموذج', { exact: true });
  await expect(idInput).toHaveAttribute('dir', 'ltr');
  const nameInput = page.getByLabel('اسم العرض', { exact: true });
  await expect(nameInput).toHaveAttribute('dir', 'auto');
  await page.keyboard.press('Escape');

  await openRoute(page, '/memories');
  await page.getByRole('button', { name: 'مذكرة جديدة', exact: true }).click();
  const summaryInput = page.getByLabel('الملخص', { exact: true }).first();
  await expect(summaryInput).toHaveAttribute('dir', 'auto');
});

test('group memory renders its timestamps instead of the catalog markup', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await seedLanguage(page, 'ar');
  await openRoute(page, '/group-memories');
  const text = (await page.locator('main').innerText()) ?? '';
  expect(text).not.toContain('<time>');
  expect(text).not.toContain('</time>');
  // And a localized time is actually there.
  await expect(page.locator('main')).toContainText(/آخر نجاح|إعادة المحاولة|حتى/);
});

/**
 * The chart's label column follows its content. Arabic short weekday names are the
 * full names (CLDR has no abbreviation), so a fixed 40px column would run them into
 * the activity track.
 */
test('Arabic weekday labels in the active-hours chart stay out of the track', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seedLanguage(page, 'ar');
  await openRoute(page, '/chats');

  // The fixture's Chat has a positive id (a private chat), and only groups show the
  // Chat-settings menu; add one so the active-hours dialog is reachable.
  const chatId = '-1001234567890';
  await page.getByRole('button', { name: 'إضافة محادثة', exact: true }).click();
  const addDialog = page.getByRole('dialog').first();
  await expect(addDialog).toBeVisible();
  await addDialog.getByLabel('معرّف محادثة Telegram', { exact: true }).fill(chatId);
  await addDialog.getByRole('button', { name: 'حفظ المحادثة', exact: true }).click();
  await expect(addDialog).toBeHidden();

  const row = page.locator('main table tbody tr').filter({ hasText: chatId }).first();
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: 'إجراءات إضافية', exact: true }).click();
  await page.getByRole('menuitem', { name: 'تعديل ساعات النشاط', exact: true }).click();

  const dialog = page.getByRole('dialog').first();
  await expect(dialog).toBeVisible();
  await dialog.getByText('لا فترات نشطة', { exact: true }).first().click();
  const note = dialog.locator('p').filter({ hasText: 'الأوقات معروضة' }).first();
  await expect(note).toBeVisible();

  const days = ar.pages.chats.weekdaysShort.split(',');
  const problems = await page.evaluate((dayNames) => {
    const out: string[] = [];
    const note = [...document.querySelectorAll('p')].find((element) =>
      (element.textContent ?? '').includes('الأوقات معروضة'),
    );
    const container = note?.previousElementSibling ?? null;
    if (container === null) {
      return ['chart container not found'];
    }
    const tracks = [...container.querySelectorAll('[dir="ltr"]')].map((element) => element.getBoundingClientRect());
    let widest = 0;
    const widths: number[] = [];
    for (const name of dayNames) {
      const label = [...container.querySelectorAll('div, span')].find(
        (element) => element.children.length === 0 && (element.textContent ?? '').trim() === name,
      );
      if (label === undefined) {
        out.push(`label ${name} not found`);
        continue;
      }
      const range = document.createRange();
      range.selectNodeContents(label);
      const text = range.getBoundingClientRect();
      const box = label.getBoundingClientRect();
      widths.push(Math.round(box.width));
      widest = Math.max(widest, Math.round(text.width));
      if (text.width > box.width + 1) {
        out.push(`label ${name} is wider than its column (${Math.round(text.width)} > ${Math.round(box.width)})`);
      }
      for (const track of tracks) {
        const overlaps =
          text.right > track.left && track.right > text.left && text.bottom > track.top && track.bottom > text.top;
        if (overlaps) {
          out.push(`label ${name} overlaps the activity track`);
        }
      }
    }
    // One content-sized column for every row and the axis: not a fixed width.
    if (new Set(widths).size > 1) {
      out.push(`label columns differ in width: ${widths.join(', ')}`);
    }
    if (widths.length > 0 && Math.abs((widths[0] ?? 0) - widest) > 2) {
      out.push(`label column ${widths[0]} does not match its widest label ${widest}`);
    }
    return out;
  }, days);
  expect(problems, 'weekday labels must be content-sized and never run into the track').toEqual([]);
});
