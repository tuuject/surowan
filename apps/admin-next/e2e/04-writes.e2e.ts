import { setAsAgent } from './models-fixture.ts';
import { expect } from '@playwright/test';
import { ACTIVE_CHAT, editElsewhere, inherited, viewOf } from './chats-fixture.ts';
import { adminUrl, appliedToast, E2E_USERNAME, e2eFetch, test, toast } from './helpers.ts';

/**
 * Controlled admin operations against the real backend. Every write goes
 * through the UI with its confirmation flow; success/conflict are verified
 * both in the UI and against server state (API responses / database hooks).
 */
test.use({ signedIn: true });

test.describe('memo pad CRUD', () => {
  test('delete the expired seed memo via the confirmation flow', async ({ page }) => {
    await page.goto(await adminUrl('/memories'));
    const row = page.locator('table tbody tr', { hasText: 'Old note that expired already.' });
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: 'Delete' }).click();
    await page.getByRole('button', { name: 'Delete memo' }).click();
    await expect(toast(page, 'Memo deleted')).toBeVisible();
    await expect(row).toHaveCount(0);
  });

  test('create, view, edit to permanent, and delete a memo through the dialogs', async ({ page }) => {
    await page.goto(await adminUrl('/memories'));
    await page.getByRole('button', { name: 'New memo' }).click();
    const createDialog = page.getByRole('dialog');
    await createDialog.getByLabel('Chat', { exact: true }).selectOption('123456789');
    await createDialog.getByLabel('Summary').fill('E2E memo created by test');
    await createDialog.getByLabel('Detail').fill('E2E memo detail with a [link](https://example.com).');
    await createDialog.getByLabel('TTL in days').fill('7');
    await createDialog.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(toast(page, 'Memo created')).toBeVisible();

    // server state: summary/detail and a short-term expiry
    const listResponse = await page.request.get(await adminUrl('/api/memories?limit=100'));
    expect(listResponse.ok()).toBeTruthy();
    const listBody = (await listResponse.json()) as {
      items: { id: string; summary: string; detail: string; expires_at: string | null; short_term: boolean }[];
    };
    const created = listBody.items.find((item) => item.summary === 'E2E memo created by test');
    expect(created).toBeDefined();
    expect(created?.detail).toBe('E2E memo detail with a [link](https://example.com).');
    expect(created?.short_term).toBe(true);
    expect(created?.expires_at).not.toBeNull();

    // UI state: walk real cursor pages until the created memo is visible.
    const createdRow = page.locator('table tbody tr', { hasText: 'E2E memo created by test' });
    for (let pageNumber = 1; !(await createdRow.isVisible()) && pageNumber <= 10; pageNumber += 1) {
      const next = page.getByRole('button', { name: 'Next page', exact: true });
      if (await next.isDisabled()) {
        break;
      }
      await next.click();
      await expect(page.getByRole('button', { name: `Page ${pageNumber + 1}`, exact: true })).toHaveAttribute(
        'aria-current',
        'page',
      );
    }
    await expect(createdRow).toBeVisible();
    await createdRow.getByRole('button', { name: 'View' }).click();
    const viewDialog = page.getByRole('dialog');
    await expect(viewDialog.getByText('Memo details')).toBeVisible();
    await expect(viewDialog.getByText('E2E memo detail with a [link](https://example.com).')).toBeVisible();
    await viewDialog.getByRole('button', { name: 'Close' }).click();
    await expect(viewDialog).not.toBeVisible();

    // Edit: an empty TTL promotes the entry to permanent.
    await createdRow.getByRole('button', { name: 'Edit' }).click();
    const editDialog = page.getByRole('dialog');
    await editDialog.getByLabel('Summary').fill('E2E memo updated by test');
    await editDialog.getByLabel('TTL in days').fill('');
    await editDialog.getByRole('button', { name: 'Save' }).click();
    await expect(toast(page, 'Memo updated')).toBeVisible();

    const updatedResponse = await page.request.get(await adminUrl('/api/memories?limit=100'));
    const updatedBody = (await updatedResponse.json()) as {
      items: { id: string; summary: string; expires_at: string | null; short_term: boolean }[];
    };
    const updated = updatedBody.items.find((item) => item.id === created?.id);
    expect(updated?.summary).toBe('E2E memo updated by test');
    expect(updated?.expires_at).toBeNull();
    expect(updated?.short_term).toBe(false);

    // UI state: the refreshed row shows the update and can be deleted.
    const updatedRow = page.locator('table tbody tr', { hasText: 'E2E memo updated by test' });
    await expect(updatedRow).toBeVisible();
    await expect(updatedRow.getByText('Permanent').first()).toBeVisible();
    await updatedRow.getByRole('button', { name: 'Delete' }).click();
    await page.getByRole('button', { name: 'Delete memo' }).click();
    await expect(toast(page, 'Memo deleted')).toBeVisible();
    await expect(updatedRow).toHaveCount(0);

    const afterResponse = await page.request.get(await adminUrl('/api/memories?limit=100'));
    const afterBody = (await afterResponse.json()) as { items: { summary: string }[] };
    expect(afterBody.items.some((item) => item.summary === 'E2E memo updated by test')).toBeFalsy();
  });
});

test.describe('bot admins', () => {
  test('add and remove a bot admin with UI feedback', async ({ page }) => {
    await page.goto(await adminUrl('/admins'));
    await expect(page.getByText('No bot admins configured.')).toBeVisible();

    await page.getByRole('button', { name: 'Add bot admin' }).click();
    await page.getByRole('dialog').getByLabel('Telegram user ID').fill('123456789');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(page.getByText('Bot admin added')).toBeVisible();
    const row = page.locator('table tbody tr', { hasText: '123456789' });
    await expect(row).toBeVisible();

    await row.getByRole('button', { name: 'Remove' }).click();
    await page.getByRole('button', { name: 'Remove admin' }).click();
    await expect(page.getByText('Bot admin removed')).toBeVisible();
    await expect(page.getByText('No bot admins configured.')).toBeVisible();

    const listResponse = await page.request.get(await adminUrl('/api/admins'));
    const listBody = (await listResponse.json()) as { items: { telegram_user_id: string }[] };
    expect(listBody.items.some((item) => item.telegram_user_id === '123456789')).toBeFalsy();
  });

  test('a failed admin read does not invent an empty inventory', async ({ page }) => {
    let failed = false;
    await page.route('**/api/admins', async (route) => {
      if (!failed) {
        failed = true;
        await route.fulfill({ status: 502, json: { error: 'internal', message: 'Synthetic admin failure' } });
        return;
      }
      await route.fallback();
    });
    await page.goto(await adminUrl('/admins'));
    await expect(page.getByText('Synthetic admin failure', { exact: false })).toBeVisible();
    await expect(page.locator('table')).toHaveCount(0);
    await expect(page.getByText('No bot admins configured.')).toHaveCount(0);
    await expect(page.getByText('0 records', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Refresh list', exact: true }).click();
    await expect(page.getByText('No bot admins configured.')).toBeVisible();
  });
});

test.describe('agent model hot-switch', () => {
  test('resets an incompatible Chat effort with a dialog when switching the global model', async ({ page }) => {
    await page.goto(await adminUrl('/models'));
    await editElsewhere(page, { ...inherited, thinking_level: 'high' });
    await page.reload();

    await page.getByRole('button', { name: 'Provider vision' }).click();
    await setAsAgent(page, page.locator('tr', { hasText: 'vision-model' }));
    // The toast only appears once the write and the reload succeeded.
    await expect(appliedToast(page).first()).toBeVisible();
    // The vision model does not reason, so the switch leaves it only `off`.
    await expect(page.getByText('Thinking effort reset to off', { exact: false }).first()).toBeVisible();
    const dialog = page.getByRole('dialog', { name: 'Chat thinking effort reset' });
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByText('Their previous effort is not supported by the new model', { exact: false }),
    ).toBeVisible();
    await expect(dialog.getByRole('listitem')).toHaveText(`${ACTIVE_CHAT}: high → off`);
    const chats = await viewOf(page);
    const chat = chats.items.find((item) => item.id === ACTIVE_CHAT);
    expect(chat?.saved).toMatchObject({ provider: null, model: null, thinking_level: 'off' });
    expect(chat?.active).toMatchObject({ provider: null, model: null, thinking_level: 'off' });
    const screenshotPath = test.info().outputPath('chat-thinking-reset.png');
    await dialog.screenshot({ path: screenshotPath });
    await test.info().attach('chat-thinking-reset', { path: screenshotPath, contentType: 'image/png' });
    await dialog.getByRole('button', { name: 'Close', exact: true }).first().click();
    await expect(dialog).not.toBeVisible();
    // Wait for the refreshed view before the next write: a switch has to be
    // built on the revision the previous one produced.
    await expect(
      page
        .locator('table tbody tr')
        .filter({ has: page.getByRole('button', { name: 'Provider vision', exact: true }) })
        .getByText('Agent in use'),
    ).toBeVisible();

    // `GET /model` is gone with the old Model page; the live model is read back
    // from the provider view, which is what the page itself renders.
    const switched = (await (await page.request.get(await adminUrl('/api/providers'))).json()) as {
      agent: { provider: string; model: string; thinking_level: string };
    };
    expect(switched.agent).toEqual({ provider: 'vision', model: 'vision-model', thinking_level: 'off' });

    // There is no default to restore: the way back is another switch.
    await page.getByRole('button', { name: 'Provider agent' }).click();
    await setAsAgent(page, page.locator('tr', { hasText: 'agent-model' }));
    await expect(
      page
        .locator('table tbody tr')
        .filter({ has: page.getByRole('button', { name: 'Provider agent', exact: true }) })
        .getByText('Agent in use'),
    ).toBeVisible();
    await expect(dialog).not.toBeVisible();
    await editElsewhere(page, inherited);

    const restored = (await (await page.request.get(await adminUrl('/api/providers'))).json()) as {
      agent: { provider: string; model: string; thinking_level: string };
    };
    // Switching back resets again rather than restoring the old level.
    expect(restored.agent).toEqual({ provider: 'agent', model: 'agent-model', thinking_level: 'off' });
  });
});

test.describe('configuration file', () => {
  test('applies the config file from the settings page', async ({ page }) => {
    await page.goto(await adminUrl('/settings'));
    await expect(page.getByText('Configuration file')).toBeVisible();

    const before = (await (await page.request.get(await adminUrl('/api/config/status'))).json()) as {
      generation: number;
    };

    await page.getByRole('button', { name: 'Apply config file' }).click();
    // Only the apply result has all three lists; the status summary also names restart requirements.
    const result = page.locator('dl').filter({ has: page.getByText('Applied', { exact: true }) });
    await expect(result.getByText('Restart required', { exact: true })).toBeVisible();
    await expect(result.getByText('Outside serve', { exact: true })).toBeVisible();

    const after = (await (await page.request.get(await adminUrl('/api/config/status'))).json()) as {
      generation: number;
      restart_required: string[];
      last_error: unknown;
    };
    expect(after.last_error).toBeNull();
    expect(after.generation).toBeGreaterThanOrEqual(before.generation);
    // The fixture overrides the admin port in memory only, so the file's port
    // shows up as waiting for a restart.
    expect(after.restart_required).toContain('admin.port');
  });
});

test.describe('alarm cancel + conflict path', () => {
  test('cancel a pending alarm and see it as cancelled', async ({ page }) => {
    await page.goto(await adminUrl('/alarms'));
    const row = page.locator('table tbody tr', { hasText: 'Remind Alice about the fixture data' });
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('button', { name: 'Cancel alarm' }).click();
    await expect(toast(page, 'Alarm cancelled')).toBeVisible();

    const state = await e2eFetch<{ state: string; cancelled_by: string | null }>('/alarm-state?id=10001');
    expect(state.state).toBe('cancelled');
    expect(state.cancelled_by).toBe(E2E_USERNAME);

    // UI reflects the new state through the state filter
    await page.getByRole('combobox', { name: 'State' }).selectOption('cancelled');
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    const cancelledRow = page.locator('table tbody tr', { hasText: 'Remind Alice about the fixture data' });
    await expect(cancelledRow).toBeVisible();
    await expect(cancelledRow.getByText('cancelled')).toBeVisible();
  });

  test('cancelling an alarm that became terminal shows alarm_not_pending and refreshes', async ({ page }) => {
    await page.goto(await adminUrl('/alarms'));
    // `e2e alarm 1` is also a substring of `e2e alarm 10`…`e2e alarm 19`
    const row = page.locator('table tbody tr', { hasText: /e2e alarm 1(?!\d)/ });
    await expect(row).toBeVisible();

    // Turn the alarm into a terminal state behind the UI's back. `e2e alarm 1`
    // is the seed row with id 10100 (bulk alarms start at 10100).
    const fired = await e2eFetch<{ updated: number }>('/set-alarm-terminal?id=10100', { method: 'POST' });
    expect(fired.updated).toBe(1);

    await row.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('button', { name: 'Cancel alarm' }).click();

    // 409 alarm_not_pending: dialog stays open with the real error...
    await expect(page.getByText('alarm_not_pending', { exact: false })).toBeVisible();
    await expect(page.getByText('Only pending alarms can be cancelled')).toBeVisible();
    // ...and the list refreshes to the true state.
    const state = await e2eFetch<{ state: string }>('/alarm-state?id=10100');
    expect(state.state).toBe('fired');

    await page.getByRole('button', { name: 'Dismiss' }).click();
    await page.getByRole('combobox', { name: 'State' }).selectOption('fired');
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    const firedRow = page.locator('table tbody tr', { hasText: /e2e alarm 1(?!\d)/ });
    await expect(firedRow).toBeVisible();
    await expect(firedRow.getByText('fired')).toBeVisible();
  });
});

test.describe('warnings', () => {
  test('mark an event warning read, remove it from the dashboard, then clear history', async ({ page }) => {
    await page.goto(await adminUrl('/warnings'));
    await expect(page.getByText('Invocation failure rate is above the threshold')).toBeVisible();
    await page.getByRole('button', { name: 'Mark read' }).click();
    await expect(toast(page, 'Warning marked read')).toBeVisible();
    await expect(page.getByText('Unread', { exact: true })).toHaveCount(0);

    await page.goto(await adminUrl('/'));
    // The summary loads on its own query; wait for it so the absence check is not vacuous.
    await expect(page.getByText('0 unread event warnings')).toBeVisible();
    await expect(page.getByText('Invocation failure rate is above the threshold')).toHaveCount(0);

    await page.goto(await adminUrl('/warnings'));
    await page.getByRole('button', { name: 'Clear warning history' }).click();
    await page.getByRole('button', { name: 'Clear warnings' }).click();
    await expect(toast(page, 'Cleared 2 warnings')).toBeVisible();
    await expect(page.getByText('No event warnings yet.')).toBeVisible();
  });
});

test.describe('overview operations', () => {
  test('cancel ongoing sessions reports the audit result', async ({ page }) => {
    await page.goto(await adminUrl('/'));
    await page.getByRole('button', { name: 'Cancel ongoing', exact: true }).click();
    await page.getByRole('button', { name: 'Cancel ongoing sessions' }).click();
    await expect(page.getByText(/Canceled 0 buckets \/ 0 invocations/)).toBeVisible();
    await expect(page.getByText('Something went wrong')).toHaveCount(0);
  });

  test('wake the sleeping bot and see the status flip to awake', async ({ page }) => {
    const sleep = await e2eFetch<{ entered: boolean; sleep_until: string }>('/enter-sleep', { method: 'POST' });
    expect(sleep.entered).toBeTruthy();

    await page.goto(await adminUrl('/'));
    await expect(page.getByText('sleeping')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Wake now' })).toBeVisible();

    await page.getByRole('button', { name: 'Wake now' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Wake now' }).click();
    await expect(page.getByText('Bot is awake')).toBeVisible();
    await expect(page.getByText('awake', { exact: true })).toBeVisible();
  });
});
