import { expect } from '@playwright/test';
import { adminUrl, appliedToast, modelListRow, test } from './helpers.ts';
import { E2E_RELAY_ALIAS } from './models-fixture.ts';

/**
 * The Providers page against the real `AdminServer`, editing side: declaring
 * thinking levels and a nickname on a model, the connection's header rows, and
 * the two stale-revision conflicts. Adding models and creating providers live
 * in `08-models-adding.e2e.ts`. Every write goes through the UI and is
 * verified against the API afterwards.
 */
test.use({ signedIn: true });

test.describe('providers page editing', () => {
  for (const viewport of [
    { width: 1280, height: 600 },
    { width: 390, height: 844 },
  ]) {
    test(`preserves the scrolled page under edit and confirmation dialogs at ${viewport.width}px`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize(viewport);
      await page.goto(await adminUrl('/providers'));
      await page.getByRole('button', { name: `Provider ${E2E_RELAY_ALIAS}` }).click();
      const positions: { action: string; before: number; opened: number; closed: number }[] = [];
      for (const action of ['Edit', 'Delete']) {
        const trigger = page.getByRole('button', { name: `${action} relay-existing-model`, exact: true });
        await trigger.scrollIntoViewIfNeeded();
        const before = await page.evaluate(() => window.scrollY);
        expect(before).toBeGreaterThan(100);
        const background = await modelListRow(page, 'relay-existing-model').boundingBox();
        expect(background).not.toBeNull();
        await trigger.click();
        const dialog = page.getByRole(action === 'Edit' ? 'dialog' : 'alertdialog');
        await expect(dialog).toBeVisible();
        // Wait for the deferred scroll lock, not just the dialog's mount.
        await page.waitForFunction(() =>
          [document.documentElement, document.body].some((element) => getComputedStyle(element).overflowY === 'hidden'),
        );
        const opened = await page.evaluate(() => window.scrollY);
        expect(opened).toBe(before);
        expect((await modelListRow(page, 'relay-existing-model').boundingBox())?.y).toBe(background?.y);
        await page.keyboard.press('Escape');
        await expect(dialog).toHaveCount(0);
        await page.waitForFunction(() =>
          [document.documentElement, document.body].every(
            (element) => getComputedStyle(element).overflowY !== 'hidden',
          ),
        );
        const closed = await page.evaluate(() => window.scrollY);
        expect(closed).toBe(before);
        positions.push({ action, before, opened, closed });
      }
      await testInfo.attach('modal-scroll-positions', {
        body: JSON.stringify({ viewport, positions }, null, 2),
        contentType: 'application/json',
      });
    });
  }

  test('animates model editing in both directions and discards cancelled changes', async ({ page }, testInfo) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.goto(await adminUrl('/providers'));
    await page.getByRole('button', { name: `Provider ${E2E_RELAY_ALIAS}` }).click();
    await page.evaluate(() => {
      const transitions: { closing: boolean; name: string | undefined }[] = [];
      Object.assign(window, { modelEditTransitions: transitions });
      document.addEventListener('transitionrun', (event) => {
        if (event.target instanceof HTMLElement && event.target.getAttribute('role') === 'dialog') {
          transitions.push({
            closing: event.target.hasAttribute('data-ending-style'),
            name: event.target.querySelector<HTMLInputElement>('#model-name')?.value,
          });
        }
      });
    });
    const transitions = () =>
      page.evaluate(() => {
        // The listener above owns this page-local observation buffer.
        const state = window as typeof window & {
          modelEditTransitions: { closing: boolean; name: string | undefined }[];
        };
        return state.modelEditTransitions;
      });
    const edit = page.getByRole('button', { name: 'Edit relay-existing-model' });
    await edit.click();
    await expect.poll(async () => (await transitions()).some((entry) => !entry.closing)).toBe(true);
    const originalName = await page.locator('#model-name').inputValue();
    await page.locator('#model-name').fill('Cancelled model name');
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect
      .poll(async () => (await transitions()).some((entry) => entry.closing && entry.name === 'Cancelled model name'))
      .toBe(true);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await edit.click();
    await expect(page.locator('#model-name')).toHaveValue(originalName);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await testInfo.attach('model-edit-transitions', {
      body: JSON.stringify(await transitions(), null, 2),
      contentType: 'application/json',
    });
  });

  test('declares thinking levels in the edit dialog only for a reasoning model', async ({ page }) => {
    await page.goto(await adminUrl('/providers'));
    await page.getByRole('button', { name: `Provider ${E2E_RELAY_ALIAS}` }).click();
    await page.getByRole('button', { name: 'Edit relay-existing-model' }).click();

    // Not a reasoning model: there are no levels to declare.
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('checkbox', { name: 'Off', exact: true })).toHaveCount(0);
    await dialog.getByRole('checkbox', { name: 'Supports thinking', exact: true }).check();
    await dialog.getByRole('checkbox', { name: 'Low', exact: true }).check();
    await dialog.getByRole('checkbox', { name: 'Extra high', exact: true }).check();
    await page.getByRole('button', { name: 'Save' }).click();
    // The toast only appears once the write and the reload succeeded.
    await expect(appliedToast(page).first()).toBeVisible();

    const view = await (await page.request.get(await adminUrl('/api/providers'))).json();
    const relay = view.providers.find((provider: { alias: string }) => provider.alias === E2E_RELAY_ALIAS);
    const edited = relay.models.find((model: { id: string }) => model.id === 'relay-existing-model');
    expect(edited).toMatchObject({ reasoning: true, thinking_levels: ['low', 'xhigh'] });
  });

  test('saves a model nickname and exposes it through the providers API', async ({ page }) => {
    await page.goto(await adminUrl('/providers'));
    await page.getByRole('button', { name: `Provider ${E2E_RELAY_ALIAS}` }).click();
    await page.getByRole('button', { name: 'Edit relay-existing-model' }).click();

    const nickname = '常用聊天模型 A';
    await expect(page.getByRole('dialog').getByText('Nickname', { exact: true })).toBeVisible();
    await page.locator('#model-nickname').fill(nickname);
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(appliedToast(page).first()).toBeVisible();

    const view = await (await page.request.get(await adminUrl('/api/providers'))).json();
    const relay = view.providers.find((provider: { alias: string }) => provider.alias === E2E_RELAY_ALIAS);
    const edited = relay.models.find((model: { id: string }) => model.id === 'relay-existing-model');
    expect(edited.nickname).toBe(nickname);
  });

  test('a header name can be typed key by key without losing focus', async ({ page }) => {
    await page.goto(await adminUrl('/providers'));
    await page.getByRole('button', { name: `Provider ${E2E_RELAY_ALIAS}`, exact: true }).click();
    await page.getByRole('button', { name: 'Add header' }).click();
    // The row used to be keyed by its own name, so every keystroke remounted it
    // and dropped the focus after the first character.
    const connection = page.getByRole('region', { name: 'Connection', exact: true });
    // Rows are a Koi MapEditor without drag: order carries no meaning here.
    await expect(connection.getByRole('button', { name: 'Drag to reorder' })).toHaveCount(0);
    const newName = connection.getByLabel('Header name', { exact: true }).nth(1);
    await newName.pressSequentially('x-typed');
    await expect(newName).toHaveValue('x-typed');
  });

  test('a model edit that loses a revision race is closed instead of overwriting', async ({ page }) => {
    await page.goto(await adminUrl('/providers'));
    await page.getByRole('button', { name: `Provider ${E2E_RELAY_ALIAS}`, exact: true }).click();
    await page.getByRole('button', { name: 'Edit relay-existing-model' }).click();
    await expect(page.locator('#model-context')).toBeVisible();

    // Another admin renames the model while this form is open.
    await page.evaluate(async (alias) => {
      const view = await (await fetch('/api/providers')).json();
      const provider = view.providers.find((candidate: { alias: string }) => candidate.alias === alias);
      const model = provider.models.find((candidate: { id: string }) => candidate.id === 'relay-existing-model');
      const response = await fetch(`/api/providers/${alias}/models/relay-existing-model`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'if-match': view.revision },
        body: JSON.stringify({ ...model, name: 'Renamed elsewhere' }),
      });
      if (!response.ok) {
        throw new Error(`concurrent write failed: ${response.status}`);
      }
    }, E2E_RELAY_ALIAS);

    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('nothing was saved. Open the model again')).toBeVisible();
    await expect(page.locator('#model-context')).toHaveCount(0);

    const view = await (await page.request.get(await adminUrl('/api/providers'))).json();
    const relay = view.providers.find((provider: { alias: string }) => provider.alias === E2E_RELAY_ALIAS);
    const model = relay.models.find((candidate: { id: string }) => candidate.id === 'relay-existing-model');
    expect(model.name).toBe('Renamed elsewhere');
  });

  test('a failed manual refresh keeps the connection draft mounted', async ({ page }) => {
    let failRefresh = false;
    await page.route('**/api/providers', async (route) => {
      if (failRefresh) {
        failRefresh = false;
        await route.fulfill({
          status: 502,
          json: { error: 'internal', message: 'Synthetic provider refresh failure' },
        });
        return;
      }
      await route.fallback();
    });
    await page.goto(await adminUrl('/providers'));
    await page.getByRole('button', { name: `Provider ${E2E_RELAY_ALIAS}`, exact: true }).click();
    await page.getByLabel('API Key', { exact: true }).fill('unsaved-refresh-draft');

    failRefresh = true;
    await page.getByRole('button', { name: 'Refresh list', exact: true }).click();
    await expect(page.getByText('Synthetic provider refresh failure', { exact: false })).toBeVisible();
    await expect(page.getByLabel('API Key', { exact: true })).toHaveValue('unsaved-refresh-draft');
  });

  test('a connection edit built on an old revision cannot delete a header added meanwhile', async ({ page }) => {
    await page.goto(await adminUrl('/providers'));
    await page.getByRole('button', { name: `Provider ${E2E_RELAY_ALIAS}`, exact: true }).click();
    await page.getByLabel('API Key', { exact: true }).fill('e2e-stale-draft-key');

    // Another admin adds a header while this card holds a draft.
    await page.evaluate(async (alias) => {
      const view = await (await fetch('/api/providers')).json();
      const response = await fetch(`/api/providers/${alias}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'if-match': view.revision },
        body: JSON.stringify({ headers: { 'x-added-elsewhere': 'value' } }),
      });
      if (!response.ok) {
        throw new Error(`concurrent write failed: ${response.status}`);
      }
    }, E2E_RELAY_ALIAS);

    // The save is refused on its old revision; the refresh then marks the draft
    // stale and blocks another attempt until it is reloaded.
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('The configuration changed since you started editing')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled();
    await page.getByRole('button', { name: 'Reload' }).click();
    const connection = page.getByRole('region', { name: 'Connection', exact: true });
    await expect(connection.getByLabel('Header name', { exact: true }).nth(1)).toHaveValue('x-added-elsewhere');

    const view = await (await page.request.get(await adminUrl('/api/providers'))).json();
    const relay = view.providers.find((provider: { alias: string }) => provider.alias === E2E_RELAY_ALIAS);
    expect(relay.header_names).toContain('x-added-elsewhere');
  });
});
