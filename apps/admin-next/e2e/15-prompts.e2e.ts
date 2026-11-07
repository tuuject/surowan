import { expect } from '@playwright/test';
import type { PromptVersionsView } from '../src/lib/api/prompts.ts';
import { adminUrl, clickNav, test, watchPageIssues } from './helpers.ts';

/**
 * The Prompts page drives the versioned prompt API against the real config
 * files: edit → save/apply, version history, unified diff and restore. The
 * seeded config starts with the helper defaults: global prompt
 * "Participate safely." and chat 123456789 instructions "private".
 */
test.use({ signedIn: true });

const GLOBAL_START = 'Participate safely.';
const SAVED_MESSAGE =
  'The prompt applies from the next invocation; affected Conversation Contexts rebuild on their next run.';

test.describe('prompts page', () => {
  test('renders the editor, the starting external version and the sidebar entry', async ({ page }) => {
    const finish = watchPageIssues(page);
    await page.goto(await adminUrl('/prompts'));
    await expect(page.getByText('Prompt editor')).toBeVisible();
    await expect(page.locator('#prompt-text')).toHaveValue(GLOBAL_START);
    await expect(
      page.getByText('Applies from the next invocation; affected Conversation Contexts rebuild on their next run.'),
    ).toBeVisible();
    await expect(page.getByText('Version history')).toBeVisible();
    await expect(page.getByText('The latest 100 versions per scope are kept.')).toBeVisible();
    await expect(page.getByText('Applied').first()).toBeVisible();
    const row = page.locator('table tbody tr').first();
    await expect(row).toContainText('v1');
    await expect(row).toContainText('External');

    // The sidebar entry leads back to the page.
    await page.goto(await adminUrl('/'));
    await clickNav(page, 'Agent setup', 'Prompts');
    await expect(page.getByText('Prompt editor')).toBeVisible();
    const issues = finish();
    expect(issues.pageErrors).toEqual([]);
    expect(issues.consoleErrors).toEqual([]);
  });

  test('a failed history read does not invent an empty version list', async ({ page }) => {
    let failed = false;
    await page.route('**/api/prompts/versions?*', async (route) => {
      if (!failed) {
        failed = true;
        await route.fulfill({ status: 502, json: { error: 'internal', message: 'Synthetic history failure' } });
        return;
      }
      await route.fallback();
    });
    await page.goto(await adminUrl('/prompts'));
    await expect(page.getByText('Synthetic history failure', { exact: false })).toBeVisible();
    await expect(page.locator('table')).toHaveCount(0);
    await expect(page.getByText('No versions yet.')).toHaveCount(0);
    await expect(page.getByText('0 records', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Refresh list', exact: true }).click();
    await expect(page.locator('table tbody tr').first()).toContainText('v1');
  });

  test('changing scope clears an unsubmitted comparison and rejects stale version ids', async ({ page }) => {
    const versions = (scope: 'global' | 'group', firstId: string): PromptVersionsView => {
      const chatId = scope === 'group' ? '123456789' : null;
      const items = [2, 1].map((seq) => ({
        id: String(Number(firstId) + seq - 1),
        scope,
        chat_id: chatId,
        seq: String(seq),
        content_hash: `hash-${scope}-${seq}`,
        content_chars: 20,
        source: 'external' as const,
        note: null,
        created_by: null,
        created_at: '2026-01-02T03:04:05.000Z',
      }));
      return { scope, chat_id: chatId, retained: 2, current: items[0] ?? null, items };
    };
    await page.route('**/api/prompts/versions?*', (route) => {
      const url = new URL(route.request().url());
      const scope = url.searchParams.get('scope') === 'group' ? 'group' : 'global';
      return route.fulfill({ json: versions(scope, scope === 'group' ? '200' : '100') });
    });
    let diffRequests = 0;
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/api/prompts/diff') {
        diffRequests += 1;
      }
    });

    await page.goto(await adminUrl('/prompts'));
    await page.getByRole('combobox', { name: 'From (older)' }).selectOption({ label: 'v1' });
    await page.getByRole('combobox', { name: 'To (newer)' }).selectOption({ label: 'v2' });
    await page.getByRole('combobox', { name: 'Scope' }).selectOption('chat:123456789');
    await page.getByRole('button', { name: 'Search', exact: true }).first().click();
    await expect(page.getByRole('combobox', { name: 'From (older)' })).toHaveValue('');

    // Selecting only one new id leaves the other side empty; no old-scope pair
    // may survive invisibly in the draft and trigger a diff request.
    await page.getByRole('combobox', { name: 'From (older)' }).selectOption({ label: 'v1' });
    await page.getByRole('button', { name: 'Search', exact: true }).last().click();
    const refreshed = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/prompts/versions' &&
        new URL(response.url()).searchParams.get('scope') === 'group',
    );
    await page.getByRole('button', { name: 'Refresh list', exact: true }).click();
    await refreshed;
    expect(diffRequests).toBe(0);
  });

  test('saving a changed global prompt records a version, renders the diff and restores', async ({ page }) => {
    await page.goto(await adminUrl('/prompts'));
    const editor = page.locator('#prompt-text');
    await expect(editor).toHaveValue(GLOBAL_START);
    await editor.fill('Participate warmly and concisely.');
    await page.locator('#prompt-note').fill('e2e tune');
    await page.getByRole('button', { name: 'Save and apply' }).click();
    await expect(page.getByText(SAVED_MESSAGE)).toBeVisible();
    await expect(page.locator('table tbody tr')).toHaveCount(2);
    const newest = page.locator('table tbody tr').first();
    await expect(newest).toContainText('v2');
    await expect(newest).toContainText('Panel');
    await expect(newest).toContainText('e2e tune');

    // Comparing is also an explicit query: choose previous → newest, then Search.
    await page.getByRole('combobox', { name: 'From (older)' }).selectOption({ label: 'v1' });
    await page.getByRole('combobox', { name: 'To (newer)' }).selectOption({ label: 'v2' });
    await page.getByRole('button', { name: 'Search', exact: true }).last().click();
    await expect(page.getByText('v1 → v2')).toBeVisible();
    // A diff row renders both line-number gutters and the +/- marker around
    // the text, so assert containment instead of the exact text.
    await expect(page.locator('[data-line-type="removed"]')).toContainText(GLOBAL_START);
    await expect(page.locator('[data-line-type="added"]')).toContainText('Participate warmly and concisely.');

    // Restoring appends a rollback version and reverts the file.
    await page.locator('table tbody tr', { hasText: 'v1' }).getByRole('button', { name: 'Restore' }).click();
    const confirm = page.getByRole('alertdialog');
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText('Restore version 1?');
    await confirm.getByRole('button', { name: 'Restore version' }).click();
    await expect(editor).toHaveValue(GLOBAL_START);
    await expect(page.locator('table tbody tr')).toHaveCount(3);
    await expect(page.locator('table tbody tr').first()).toContainText('Rollback');
    await expect(page.locator('table tbody tr').first()).toContainText('Restored from version 1');
  });

  test('the group scope edits the chat prompt and records its own history', async ({ page }) => {
    // Earlier specs rebuild the baseline Chat without instructions, so the
    // group prompt may legitimately start empty; assert relative to that.
    const before = await (
      await page.request.get(await adminUrl('/api/prompts/group?chat=123456789&source=file'))
    ).json();
    await page.goto(await adminUrl('/prompts'));
    await page.getByRole('combobox', { name: 'Scope' }).selectOption('chat:123456789');
    await expect(page.locator('#prompt-text')).toHaveValue(GLOBAL_START);
    await page.getByRole('button', { name: 'Search', exact: true }).first().click();
    // Search applies the scope before the editor re-seeds from the group file.
    await expect(page.getByRole('combobox', { name: 'Scope' })).toHaveValue('chat:123456789');
    const editor = page.locator('#prompt-text');
    await expect(editor).toHaveValue(before.prompt);

    const rowsBefore = await page.locator('table tbody tr').count();
    await editor.fill('Group prompt from e2e');
    await page.locator('#prompt-note').fill('e2e group');
    await page.getByRole('button', { name: 'Save and apply' }).click();
    await expect(page.getByText(SAVED_MESSAGE)).toBeVisible();
    await expect(page.locator('table tbody tr')).toHaveCount(rowsBefore + 1);
    const newest = page.locator('table tbody tr').first();
    await expect(newest).toContainText('Panel');
    await expect(newest).toContainText('e2e group');

    // Switching back to the global scope restores its own draft and history.
    await page.getByRole('combobox', { name: 'Scope' }).selectOption('global');
    await page.getByRole('button', { name: 'Search', exact: true }).first().click();
    await expect(page.locator('#prompt-text')).toHaveValue(GLOBAL_START);
    await expect(page.locator('table tbody tr')).toHaveCount(3);
  });

  test('the chat search param opens the group scope directly', async ({ page }) => {
    await page.goto(await adminUrl('/prompts?chat=123456789'));
    await expect(page.getByRole('combobox', { name: 'Scope' })).toHaveValue('chat:123456789');
    await page.getByRole('combobox', { name: 'Scope' }).selectOption('global');
    await page.getByRole('button', { name: 'Search', exact: true }).first().click();
    await expect(page).toHaveURL(/\/prompts$/);
    await expect(page.getByRole('combobox', { name: 'Scope' })).toHaveValue('global');
  });
});
