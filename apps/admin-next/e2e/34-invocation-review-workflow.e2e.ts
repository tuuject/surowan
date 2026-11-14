import { expect } from '@playwright/test';
import { adminUrl, clickNav, test, watchPageIssues } from './helpers.ts';
import { addOverallCommentOnDetail, addOverviewComment, assertNoPageIssues } from './review-helpers.ts';

test.use({ signedIn: true });

test.describe('invocation review workflow', () => {
  test('grades events across invocations, edits/deletes on /reviews, syncs across tabs and resets detail state on navigation', async ({
    page,
  }) => {
    const finishWatching = watchPageIssues(page);

    // Detail-page state reset (#5): warm 4002 in cache, client-side navigate to 4001, open overall-comment
    // editor on 4001 without saving, navigate back client-side to 4002, and assert the editor is closed.
    await page.goto(await adminUrl('/invocations/4002'));
    await expect(page.getByText('Invocation 4002').first()).toBeVisible();
    await page.evaluate(() => {
      window.history.pushState({}, '', '/invocations/4001');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await expect(page.getByText('Invocation 4001').first()).toBeVisible();
    await expect(page.getByText('0 comments on this invocation · 0 invocations in your review draft')).toBeVisible();

    await page.getByRole('button', { name: 'Add overall comment', exact: true }).click();
    await page.getByRole('textbox', { name: 'Overall comment', exact: true }).fill('Unsaved draft for 4001');
    await page.goBack();
    await expect(page.getByText('Invocation 4002').first()).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Overall comment', exact: true })).toHaveCount(0);
    await expect(page.getByText('0 comments on this invocation · 0 invocations in your review draft')).toBeVisible();
    await page.goForward();
    await expect(page.getByText('Invocation 4001').first()).toBeVisible();

    // 1. On /invocations/4001 Overview: add a comment on send tool call (call_send_001),
    // on an assistant agent message card (with Ctrl+Enter), and add an overall comment.
    await addOverviewComment(page, 'call_send_001', 'Reply was too verbose here.');
    await addOverviewComment(
      page,
      'private reasoning before calling read',
      'Unnecessary doc read before replying.',
      true,
    );
    await addOverallCommentOnDetail(page, 'Overall 4001 took too many turns.');
    await expect(page.getByText('2 comments on this invocation · 1 invocation in your review draft')).toBeVisible();

    // Reload -> all three still shown
    await page.reload();
    await expect(page.getByText('Reply was too verbose here.')).toBeVisible();
    await expect(page.getByText('Unnecessary doc read before replying.')).toBeVisible();
    await expect(page.getByText('Overall 4001 took too many turns.')).toBeVisible();
    await expect(page.getByText('2 comments on this invocation · 1 invocation in your review draft')).toBeVisible();

    // 2. On /invocations/4002: add a comment on one event.
    await page.goto(await adminUrl('/invocations/4002'));
    await expect(page.getByText('Invocation 4002').first()).toBeVisible();
    await addOverviewComment(page, 'Error provider_timeout', 'Provider timed out on first attempt.');
    await expect(page.getByText('1 comment on this invocation · 2 invocations in your review draft')).toBeVisible();

    // 3. Open /reviews from the Activity nav: both invocations listed with their comments;
    // edit one comment, delete another, confirm UI updates and survives reload.
    await clickNav(page, 'Activity', 'Reviews');
    await expect(page).toHaveURL(/\/reviews$/);
    await expect(page.getByRole('heading', { name: 'Reviews', level: 1 })).toBeVisible();
    await expect(
      page.getByText('Review drafts are stored only in this browser and are never uploaded to the server.'),
    ).toBeVisible();

    const section4001 = page.getByRole('region', { name: /Invocation 4001/ });
    const section4002 = page.getByRole('region', { name: /Invocation 4002/ });
    await expect(section4001).toBeVisible();
    await expect(section4002).toBeVisible();
    await expect(section4001.getByText('Reply was too verbose here.')).toBeVisible();
    await expect(section4001.getByText('Unnecessary doc read before replying.')).toBeVisible();
    await expect(section4001.getByText('Overall 4001 took too many turns.')).toBeVisible();
    await expect(section4002.getByText('Provider timed out on first attempt.')).toBeVisible();

    // Edit the first event comment on 4001
    const firstCommentItem = section4001.locator('li').filter({ hasText: 'seq 1' });
    await firstCommentItem.getByRole('button', { name: 'Edit', exact: true }).click();
    await firstCommentItem
      .getByRole('textbox', { name: 'Review comment', exact: true })
      .fill('Edited: should skip reading readme.md.');
    await firstCommentItem.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(section4001.getByText('Edited: should skip reading readme.md.')).toBeVisible();

    // Delete that comment on 4001, keeping call_send_001 comment
    await firstCommentItem.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(section4001.getByText('Edited: should skip reading readme.md.')).toHaveCount(0);
    await expect(section4001.getByText('Reply was too verbose here.')).toBeVisible();

    await page.reload();
    await expect(section4001.getByText('Edited: should skip reading readme.md.')).toHaveCount(0);
    await expect(section4001.getByText('Reply was too verbose here.')).toBeVisible();

    // 4. Multi-tab: with a second page in the same browser context, add a comment in tab B;
    // tab A (on /reviews) shows it without reload; then save something in tab A and verify
    // tab B's comment is still present after reloading.
    const pageB = await page.context().newPage();
    await pageB.goto(await adminUrl('/invocations/4002'));
    await addOverviewComment(pageB, 'call_read_002', 'Added from tab B.');

    // Tab A on /reviews shows tab B's comment without reload
    await expect(section4002.getByText('Added from tab B.')).toBeVisible();

    // Save something in tab A (edit overall comment on 4001) and verify tab B's comment survives reload
    await section4001.getByRole('button', { name: 'Edit', exact: true }).first().click();
    await section4001
      .getByRole('textbox', { name: 'Overall comment', exact: true })
      .fill('Overall 4001 updated in tab A.');
    await section4001.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(section4001.getByText('Overall 4001 updated in tab A.')).toBeVisible();

    await page.reload();
    await expect(section4001.getByText('Overall 4001 updated in tab A.')).toBeVisible();
    await expect(section4002.getByText('Added from tab B.')).toBeVisible();
    await pageB.close();

    assertNoPageIssues(finishWatching);
  });
});
