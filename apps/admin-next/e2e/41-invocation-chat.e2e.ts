import { writeFile } from 'node:fs/promises';
import { expect, type Page } from '@playwright/test';
import { adminUrl, test, watchPageIssues } from './helpers.ts';
import { assertNoPageIssues, expandOverview, overviewCard, REVIEW_STORAGE_KEY } from './review-helpers.ts';

/**
 * The Overview as a chat, on the seeded long-lived run 4100 (see
 * `test/fixtures/admin-seed-chat-run.ts`): retained history, two batches the
 * model read and one it never did, a collapsed step group naming the skill and
 * the capability it used, a `send` and a two-part `send_reply`. The review entry
 * appears on hover or keyboard focus, and a comment is stored at its place in
 * the conversation. Artifacts: desktop, phone and Chinese screenshots plus a
 * JSON outline of what the Overview rendered.
 */
test.use({ signedIn: true });

const RUN = '/invocations/4100';

function overview(page: Page) {
  return page.getByRole('tabpanel', { name: /Overview/ });
}

async function outline(page: Page): Promise<unknown> {
  return overview(page).evaluate((panel) =>
    [...panel.querySelectorAll('[role="separator"], details[data-chat-disclosure] > summary, article')]
      .filter((node) => node.closest('details:not([open])') === null || node.tagName === 'SUMMARY')
      .map((node) => ({
        kind: node.getAttribute('role') === 'separator' ? 'divider' : node.tagName.toLowerCase(),
        text: (node.textContent ?? '').replace(/\s+/g, ' ').trim(),
      })),
  );
}

test('a long-lived run reads as batches of messages, folded steps and replies', async ({ page }, testInfo) => {
  const finishWatching = watchPageIssues(page);
  await page.goto(await adminUrl(RUN));
  await expect(page.getByText('Invocation 4100').first()).toBeVisible();
  const panel = overview(page);

  // Batches: two read, one that never reached the model, then the end of the run.
  await expect(panel.getByRole('separator')).toHaveCount(4);
  await expect(panel.getByText('Messages queued', { exact: true })).toHaveCount(2);
  await expect(panel.getByText('Messages queued, not handed to the model', { exact: true })).toBeVisible();
  await expect(panel.getByText('Run finished', { exact: true })).toBeVisible();

  // Members and replies are bubbles; a send_reply shows every part it sent.
  for (const text of [
    'Can you fetch the weather page?',
    'and keep it short',
    'Sunny and 22°C today.',
    'Thanks! A sticker too, please',
    'Sticker stk_e2e_sun',
    'Here you go!',
    'One more question for later',
  ]) {
    await expect(panel.getByText(text, { exact: true })).toBeVisible();
  }
  const reply = overviewCard(page, 'Here you go!');
  await expect(reply.getByText('Message 1051', { exact: true })).toBeVisible();
  await expect(reply.getByText('Message 1052', { exact: true })).toBeVisible();

  // History and steps are folded: nothing inside them is on the page yet.
  await expect(panel.getByText('Morning, everyone')).toHaveCount(0);
  await expect(panel.getByText('Used skill web-fetch')).toHaveCount(0);
  const steps = panel.getByText('1 tool call, 1 skill, 1 failed model call, 1 private note', { exact: true });
  await expect(steps).toBeVisible();
  await steps.click();
  await expect(panel.getByText('Used skill web-fetch', { exact: true })).toBeVisible();
  await expect(panel.getByText('Used tool web_fetch', { exact: true })).toBeVisible();
  await expect(panel.getByText('Model call openai/e2e-chat-model', { exact: true })).toBeVisible();
  await expect(panel.getByText('Read the fetch skill, then fetch the page.', { exact: true })).toBeVisible();
  // Only the failed model call is a step: the two that succeeded and the tool results stay out.
  await expect(panel.getByText('Model call openai/e2e-chat-model', { exact: true })).toHaveCount(1);
  await expect(panel.getByText('Tool result', { exact: true })).toHaveCount(0);
  const fetchStep = overviewCard(page, 'Used tool web_fetch');
  await expect(fetchStep.getByText('Duration 40 ms', { exact: true })).toBeVisible();
  // Arguments and the result the model got open separately, each on demand.
  await expect(fetchStep.getByRole('button', { name: 'Text', exact: true })).toHaveCount(0);
  await fetchStep.getByText('Arguments', { exact: true }).click();
  await expect(fetchStep.getByRole('button', { name: 'Text', exact: true })).toHaveCount(1);
  await expect(fetchStep.getByText('Sunny, 22°C', { exact: true })).toHaveCount(0);
  await fetchStep.getByText('Result', { exact: true }).click();
  await expect(fetchStep.getByText('Sunny, 22°C', { exact: true })).toBeVisible();
  // A reply keeps what the send tool told the model, too.
  const sent = overviewCard(page, 'Sunny and 22°C today.');
  await sent.getByText('Result', { exact: true }).click();
  await expect(sent.getByText('sent', { exact: true })).toBeVisible();
  await panel.getByText('1 earlier message in context', { exact: true }).click();
  await expect(panel.getByText('Morning, everyone', { exact: true })).toBeVisible();

  await writeFile(testInfo.outputPath('chat-outline.json'), `${JSON.stringify(await outline(page), null, 2)}\n`);
  await page.screenshot({ path: testInfo.outputPath('chat-desktop.png'), fullPage: true });
  assertNoPageIssues(finishWatching);
});

test('the review entry shows on hover or focus and saves at its place in the conversation', async ({ page }) => {
  const finishWatching = watchPageIssues(page);
  await page.goto(await adminUrl(RUN));
  const reply = overviewCard(page, 'Sunny and 22°C today.');
  const add = reply.getByRole('button', { name: 'Add review comment', exact: true });
  // The wrapper fades the control in and out; the button itself stays in the tab order.
  const reveal = add.locator('xpath=..');

  // Hidden until the pointer is over the item, and again once it leaves.
  await expect(reveal).toHaveCSS('opacity', '0');
  await reply.getByText('Sunny and 22°C today.', { exact: true }).hover();
  await expect(reveal).toHaveCSS('opacity', '1');
  await page.mouse.move(0, 0);
  await expect(reveal).toHaveCSS('opacity', '0');
  // Keyboard focus reveals it the same way.
  await add.focus();
  await expect(add).toBeFocused();
  await expect(reveal).toHaveCSS('opacity', '1');

  await add.click();
  await reply.getByRole('textbox', { name: 'Review comment', exact: true }).fill('Should have cited the source.');
  await reply.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(reply.getByText('Should have cited the source.', { exact: true })).toBeVisible();

  await expandOverview(page);
  const fetchStep = overviewCard(page, 'Used tool web_fetch');
  await fetchStep.getByRole('button', { name: 'Add review comment', exact: true }).click();
  await fetchStep.getByRole('textbox', { name: 'Review comment', exact: true }).fill('Fetch once, not per city.');
  await fetchStep.getByRole('button', { name: 'Save', exact: true }).click();

  // Positions follow the reading order: history 0, two messages, eight steps
  // (failed call, retry, note, skill, its result, fetch, its result, empty turn), then the reply.
  const stored = await page.evaluate((key) => localStorage.getItem(key), REVIEW_STORAGE_KEY);
  const comments = (
    JSON.parse(stored ?? '{}') as {
      state: { invocations: Record<string, { comments: Record<string, { position: number }> }> };
    }
  ).state.invocations['4100']?.comments;
  expect(comments?.['tool-8102']?.position).toBe(11);
  expect(comments?.['tool-8101']?.position).toBe(8);

  // After a reload the step group opens by itself to show its comment.
  await page.reload();
  await expect(overviewCard(page, 'Used tool web_fetch').getByText('Fetch once, not per city.')).toBeVisible();
  await expect(overviewCard(page, 'Sunny and 22°C today.').getByText('Should have cited the source.')).toBeVisible();
  assertNoPageIssues(finishWatching);
});

test('the chat fits a phone and reads in Chinese', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(await adminUrl(RUN));
  await expandOverview(page);
  await expect(overview(page).getByText('Here you go!', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('chat-phone.png'), fullPage: true });

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.evaluate(() => localStorage.setItem('admin-language', 'zh-CN'));
  await page.reload();
  const panel = page.getByRole('tabpanel', { name: '概览' });
  await expect(panel.getByText('消息入队', { exact: true })).toHaveCount(2);
  await expect(panel.getByText('消息入队，没有交给模型', { exact: true })).toBeVisible();
  await expect(
    panel.getByText('调用 1 次工具、使用 1 个技能、1 次模型调用失败、1 段私有文本', { exact: true }),
  ).toBeVisible();
  await expect(panel.getByText('此前的上下文 1 条', { exact: true })).toBeVisible();
  await panel.getByText('调用 1 次工具、使用 1 个技能、1 次模型调用失败、1 段私有文本', { exact: true }).click();
  await expect(panel.getByText('使用技能 web-fetch', { exact: true })).toBeVisible();
  await expect(panel.getByText('使用工具 web_fetch', { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('chat-zh.png'), fullPage: true });
});
