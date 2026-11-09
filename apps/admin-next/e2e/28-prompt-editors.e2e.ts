import { expect, type Page } from '@playwright/test';
import { adminUrl, test, watchPageIssues } from './helpers.ts';

test.use({ signedIn: true });

const MARKDOWN = '# Persona\n\nBe **warm** and concise.\n- 用中文回复。';

async function imageReads(page: Page) {
  await page.route('**/api/image/status', (route) => route.fulfill({ json: { enabled: true, models: [] } }));
  for (const resource of ['prompts', 'images']) {
    await page.route(`**/api/image/${resource}?*`, (route) =>
      route.fulfill({ json: { items: [], total: 0, limit: 50, offset: 0 } }),
    );
  }
}

test('Markdown highlighting follows system and manual themes without losing the draft or undo history', async ({
  page,
}, testInfo) => {
  const finish = watchPageIssues(page);
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto(await adminUrl('/prompts'));
  const editor = page.getByRole('textbox', { name: 'Prompt', exact: true });
  const frame = page.locator('.cm-editor');
  await expect(editor).toHaveAttribute('id', 'prompt-text');
  await expect(editor).toHaveAttribute('aria-multiline', 'true');
  await expect(editor).toHaveAccessibleDescription(
    'Applies from the next invocation; affected Conversation Contexts rebuild on their next run.',
  );
  await page
    .locator('label')
    .filter({ hasText: /^Prompt$/ })
    .click();
  await expect(editor).toBeFocused();
  await editor.fill(MARKDOWN);
  await expect(editor.locator('.cm-line')).toHaveText(MARKDOWN.split('\n'));
  const heading = editor.locator('.cm-line').first().locator('span').first();
  const strong = editor.locator('.cm-line').nth(2).locator('span').filter({ hasText: 'warm' });
  await expect(heading).toHaveCSS('font-weight', '700');
  await expect(strong).toHaveCSS('font-weight', '700');
  const lightBackground = await frame.evaluate((element) => getComputedStyle(element).backgroundColor);
  const lightHeading = await heading.evaluate((element) => getComputedStyle(element).color);
  expect(lightHeading).not.toBe(await editor.evaluate((element) => getComputedStyle(element).color));
  await frame.screenshot({ path: testInfo.outputPath('prompt-editor-light.png') });

  await editor.focus();
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(editor).toBeFocused();
  await expect(editor.locator('.cm-line')).toHaveText(MARKDOWN.split('\n'));
  await expect
    .poll(() => frame.evaluate((element) => getComputedStyle(element).backgroundColor))
    .not.toBe(lightBackground);
  await expect.poll(() => heading.evaluate((element) => getComputedStyle(element).color)).not.toBe(lightHeading);
  await frame.screenshot({ path: testInfo.outputPath('prompt-editor-dark.png') });

  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(frame).toHaveCSS('background-color', lightBackground);
  await editor.press('ControlOrMeta+z');
  await expect(editor).toHaveText('Participate safely.');
  await editor.press(process.platform === 'darwin' ? 'Meta+Shift+z' : 'Control+y');
  await expect(editor.locator('.cm-line')).toHaveText(MARKDOWN.split('\n'));
  await page.getByRole('button', { name: 'Toggle theme: System', exact: true }).click();
  await page.getByRole('button', { name: 'Toggle theme: Light', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(editor.locator('.cm-line')).toHaveText(MARKDOWN.split('\n'));
  await editor.focus();
  await editor.press('Tab');
  await expect(page.locator('#prompt-note')).toBeFocused();
  const issues = finish();
  expect(issues.pageErrors).toEqual([]);
  expect(issues.consoleErrors).toEqual([]);
  expect(issues.writeApiCalls).toEqual([]);
});

test('a multiline Markdown prompt saves verbatim, reloads and restores from history', async ({ page }) => {
  const finish = watchPageIssues(page);
  await page.goto(await adminUrl('/prompts'));
  const editor = page.getByRole('textbox', { name: 'Prompt', exact: true });
  await editor.fill(MARKDOWN);
  await page.getByRole('button', { name: 'Save and apply', exact: true }).click();
  await expect(page.locator('table tbody tr')).toHaveCount(2);
  const saved = await page.request.get(await adminUrl('/api/prompts/global?source=file'));
  expect(saved.ok()).toBe(true);
  expect((await saved.json()).prompt).toBe(MARKDOWN);
  await page.reload();
  await expect(editor.locator('.cm-line')).toHaveText(MARKDOWN.split('\n'));
  await page.locator('table tbody tr', { hasText: 'v1' }).getByRole('button', { name: 'Restore' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Restore version' }).click();
  await expect(editor).toHaveText('Participate safely.');
  const restored = await page.request.get(await adminUrl('/api/prompts/global?source=file'));
  expect((await restored.json()).prompt).toBe('Participate safely.');
  const issues = finish();
  expect(issues.pageErrors).toEqual([]);
  expect(issues.consoleErrors).toEqual([]);
});

test('the generation editor sends Markdown and reference placeholders intact to the preview', async ({ page }) => {
  const finish = watchPageIssues(page);
  await imageReads(page);
  const prompt = '# Garden\n\nUse **watercolor** {{prompt:style}} with {{image:reference}}.';
  await page.route('**/api/image/generations/resolve', async (route) => {
    expect(route.request().method()).toBe('POST');
    expect(route.request().postDataJSON()).toMatchObject({ prompt });
    await route.fulfill({ json: { finalPrompt: 'A watercolor garden with the reference image.' } });
  });
  await page.goto(await adminUrl('/image-generate'));
  const editor = page.getByRole('textbox', { name: 'Generate Prompt', exact: true });
  await expect(page.getByRole('button', { name: 'Resolve preview', exact: true })).toBeDisabled();
  await editor.fill(prompt);
  await expect(editor.locator('.cm-line')).toHaveText(prompt.split('\n'));
  await page.getByRole('button', { name: 'Resolve preview', exact: true }).click();
  await expect(page.locator('pre')).toHaveText('A watercolor garden with the reference image.');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const issues = finish();
  expect(issues.pageErrors).toEqual([]);
  expect(issues.consoleErrors).toEqual([]);
});
