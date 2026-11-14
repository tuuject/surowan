import { expect } from '@playwright/test';
import { adminUrl, test, toast, watchPageIssues } from './helpers.ts';
import { addOverviewComment, assertNoPageIssues, REVIEW_STORAGE_KEY, readDownloadedText } from './review-helpers.ts';

test.use({ signedIn: true });

test.describe('invocation review storage and metadata resilience', () => {
  test('malformed localStorage keeps valid entries and untrusted metadata cannot inject Markdown headings', async ({
    page,
  }) => {
    const finishWatching = watchPageIssues(page);

    await page.addInitScript((storageKey) => {
      if (sessionStorage.getItem('seeded-invalid-json') === null) {
        sessionStorage.setItem('seeded-invalid-json', '1');
        localStorage.setItem(storageKey, 'not-valid-json{{{');
      }
    }, REVIEW_STORAGE_KEY);
    await page.goto(await adminUrl('/reviews'));
    await expect(page.getByRole('heading', { name: 'Reviews', level: 1 })).toBeVisible();
    await expect(page.getByText('No review comments yet')).toBeVisible();
    await expect(page.locator('[data-route-error]')).toHaveCount(0);

    await page.evaluate((storageKey) => {
      localStorage.setItem(
        storageKey,
        JSON.stringify({
          version: 999,
          state: {
            goal: 12345,
            purpose: 'wrong',
            invocations: {
              '4001': {
                id: '4001',
                chatLabel: 'Seed Chat\n## Fake heading\n`injected`',
                hostKind: 'telegram',
                chatRef: '123456789',
                topicId: 0,
                createdAt: '2026-09-10T07:59:45.000Z',
                overall: null,
                comments: {
                  'tool-8002': {
                    anchor: 'tool-8002',
                    kind: 'tool_call',
                    subject: 'send',
                    attempt: null,
                    ref: 'call_send_001',
                    at: '2026-09-10T08:00:03.000Z',
                    position: 3,
                    excerpt: 'Hello from the seeded invocation',
                    text: 'Valid comment survives cleanup.',
                    updatedAt: '2026-09-10T08:00:03.000Z',
                  },
                  'context-1': {
                    anchor: 'context-1',
                    kind: 'context_message',
                    subject: 'Alice\n## Fake heading\n`ticks`',
                    attempt: null,
                    ref: 'message 6001',
                    at: '2026-09-10T07:59:30.000Z',
                    position: 0,
                    excerpt: 'Alice: edited caption',
                    text: 'Sender had newlines and backticks.',
                    updatedAt: '2026-09-10T07:59:30.000Z',
                  },
                  'bad-kind': { kind: 'bogus_kind', text: 'bad' },
                  'empty-text': {
                    anchor: 'empty-text',
                    kind: 'tool_call',
                    subject: 'read',
                    ref: 'call_read_001',
                    at: '2026-09-10T07:59:48.000Z',
                    position: 1,
                    excerpt: null,
                    text: '   ',
                    updatedAt: '2026-09-10T07:59:48.000Z',
                  },
                },
              },
              bad: 'not-an-object',
            },
          },
        }),
      );
    }, REVIEW_STORAGE_KEY);
    await page.goto(await adminUrl('/invocations/4001'));
    await expect(page.getByText('Invocation 4001').first()).toBeVisible();
    await expect(page.getByText('2 comments on this invocation · 1 invocation in your review draft')).toBeVisible();
    await expect(page.getByText('Valid comment survives cleanup.')).toBeVisible();
    await expect(page.locator('[data-route-error]')).toHaveCount(0);

    await page.goto(await adminUrl('/reviews'));
    await expect(page.getByText('Valid comment survives cleanup.')).toBeVisible();
    await expect(page.getByText('Sender had newlines and backticks.')).toBeVisible();
    await expect(page.locator('[data-route-error]')).toHaveCount(0);

    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download Markdown', exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Export and clear', exact: true }).click();
    const markdown = await readDownloadedText(await downloadPromise);
    expect(markdown).not.toMatch(/^## Fake heading/m);

    assertNoPageIssues(finishWatching);
  });

  test('failed localStorage.setItem keeps comments in memory and warns the operator', async ({ page }) => {
    const finishWatching = watchPageIssues(page);

    await page.addInitScript((storageKey) => {
      const origSetItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key: string, value: string): void {
        if (key === storageKey) {
          throw new DOMException('QuotaExceededError', 'QuotaExceededError');
        }
        origSetItem.call(this, key, value);
      };
    }, REVIEW_STORAGE_KEY);

    await page.goto(await adminUrl('/invocations/4001'));
    await expect(page.getByText('Invocation 4001').first()).toBeVisible();

    const sendCard = await addOverviewComment(page, 'call_send_001', 'First in-memory comment.');
    await expect(
      toast(page, "Couldn't save the review draft in this browser; it is kept only until you close this tab"),
    ).toBeVisible();
    await expect(sendCard.getByText('First in-memory comment.')).toBeVisible();

    const readCard = await addOverviewComment(page, 'call_read_001', 'Second in-memory comment.');
    await expect(sendCard.getByText('First in-memory comment.')).toBeVisible();
    await expect(readCard.getByText('Second in-memory comment.')).toBeVisible();
    await expect(page.getByText('2 comments on this invocation · 1 invocation in your review draft')).toBeVisible();

    assertNoPageIssues(finishWatching);
  });
});
