import { type Download, expect, type Locator, type Page } from '@playwright/test';
import type { PageIssues } from './helpers.ts';

export const REVIEW_STORAGE_KEY = 'surowan-admin-review';

export function overviewCard(page: Page, text: string): Locator {
  return page
    .getByRole('tabpanel', { name: /Overview/ })
    .locator('article')
    .filter({ hasText: text });
}

export async function addOverviewComment(
  page: Page,
  cardText: string,
  comment: string,
  useCtrlEnter = false,
): Promise<Locator> {
  const card = overviewCard(page, cardText);
  await card.getByRole('button', { name: 'Add review comment', exact: true }).click();
  const input = card.getByRole('textbox', { name: 'Review comment', exact: true });
  await input.fill(comment);
  if (useCtrlEnter) {
    await input.press('Control+Enter');
  } else {
    await card.getByRole('button', { name: 'Save', exact: true }).click();
  }
  await expect(card.getByText(comment)).toBeVisible();
  return card;
}

export async function addOverallCommentOnDetail(page: Page, comment: string): Promise<void> {
  await page.getByRole('button', { name: 'Add overall comment', exact: true }).click();
  await page.getByRole('textbox', { name: 'Overall comment', exact: true }).fill(comment);
  await page.getByRole('button', { name: 'Save', exact: true }).first().click();
  await expect(page.getByText(comment)).toBeVisible();
}

export async function readDownloadedText(download: Download): Promise<string> {
  const stream = await download.createReadStream();
  if (stream === null) {
    throw new Error('Download stream is null');
  }
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function seedExportFixtureDraft(page: Page): Promise<void> {
  await page.evaluate((storageKey) => {
    const payload = {
      version: 1,
      state: {
        goal: '',
        purpose: 'tune',
        invocations: {
          '4001': {
            id: '4001',
            chatLabel: 'Surowan Test Group',
            hostKind: 'telegram',
            chatRef: '123456789',
            topicId: 0,
            createdAt: '2026-09-10T07:59:45.000Z',
            overall: 'Overall 4001 updated in tab A.',
            comments: {
              'tool-8002': {
                anchor: 'tool-8002',
                kind: 'tool_call',
                subject: 'send',
                attempt: null,
                ref: 'call_send_001',
                at: '2026-09-10T08:00:03.000Z',
                position: 9,
                excerpt: 'Hello from the seeded invocation',
                text: 'Reply was too verbose here.',
                updatedAt: '2026-09-10T08:00:03.000Z',
              },
            },
          },
          '4002': {
            id: '4002',
            chatLabel: 'Surowan Test Group',
            hostKind: 'telegram',
            chatRef: '123456789',
            topicId: 0,
            createdAt: '2026-09-10T09:00:15.000Z',
            overall: '',
            comments: {
              'model-7002': {
                anchor: 'model-7002',
                kind: 'model_call',
                subject: 'openai/gpt-4.1-mini',
                attempt: 1,
                ref: 'model call 7002',
                at: '2026-09-10T09:00:16.000Z',
                position: 3,
                excerpt: 'openai/gpt-4.1-mini · error (provider_timeout)',
                text: 'Provider timed out on first attempt.',
                updatedAt: '2026-09-10T09:00:16.000Z',
              },
              'tool-8003': {
                anchor: 'tool-8003',
                kind: 'tool_call',
                subject: 'read',
                attempt: null,
                ref: 'call_read_002',
                at: '2026-09-10T09:00:38.000Z',
                position: 5,
                excerpt: '{"path":"system:///skills/missing.md"}',
                text: 'Added from tab B.',
                updatedAt: '2026-09-10T09:00:38.000Z',
              },
            },
          },
        },
      },
    };
    const serialized = JSON.stringify(payload);
    localStorage.setItem(storageKey, serialized);
    window.dispatchEvent(new StorageEvent('storage', { key: storageKey, newValue: serialized }));
  }, REVIEW_STORAGE_KEY);
}

export function assertNoPageIssues(finishWatching: () => PageIssues): void {
  const issues = finishWatching();
  expect(issues.writeApiCalls).toEqual([]);
  expect(issues.externalRequests).toEqual([]);
  expect(issues.consoleErrors).toEqual([]);
  expect(issues.pageErrors).toEqual([]);
}
