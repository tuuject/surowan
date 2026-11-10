import { expect } from '@playwright/test';
import { adminUrl, appliedToast, modelListRow, test } from './helpers.ts';
import {
  E2E_RELAY_ALIAS,
  E2E_RELAY_COMPLETE_MODEL,
  E2E_RELAY_MANUAL_MODEL,
  E2E_SECRETS,
  setAsAgent,
} from './models-fixture.ts';

/**
 * The Providers page against the real `AdminServer`, write side: declaring
 * thinking levels on a model, adding models by id, the new-provider wizard
 * with its header validation, and the two stale-revision conflicts. Every
 * write goes through the UI and is verified against the API afterwards.
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
    await expect(dialog.getByRole('checkbox', { name: 'off', exact: true })).toHaveCount(0);
    await dialog.getByRole('checkbox', { name: 'Supports thinking', exact: true }).check();
    await dialog.getByRole('checkbox', { name: 'low', exact: true }).check();
    await dialog.getByRole('checkbox', { name: 'xhigh', exact: true }).check();
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

  test('adds a model by id through lookup-metadata', async ({ page }) => {
    await page.goto(await adminUrl('/providers'));
    await page.getByRole('button', { name: `Provider ${E2E_RELAY_ALIAS}` }).click();
    await page.getByRole('button', { name: 'Add manually' }).click();
    await page.getByLabel('Model IDs (one per line, or separated by commas)').fill(E2E_RELAY_MANUAL_MODEL);
    await page.getByRole('button', { name: 'Look up model details' }).click();

    // A single id opens the edit dialog straight away: the metadata comes from
    // models.dev and is confirmed there before anything is written.
    await expect(page.getByText('Confirm relay-manual-model')).toBeVisible();
    await expect(page.locator('#model-context')).toHaveValue('64000');
    await page.getByRole('button', { name: 'Save' }).click();

    const row = page.locator('li').filter({ hasText: E2E_RELAY_MANUAL_MODEL });
    await expect(row.getByText('Confirmed')).toBeVisible();
    await page.getByRole('button', { name: 'Add 1 model' }).click();
    await expect(appliedToast(page).first()).toBeVisible();

    const view = await (await page.request.get(await adminUrl('/api/providers'))).json();
    const relay = view.providers.find((provider: { alias: string }) => provider.alias === E2E_RELAY_ALIAS);
    expect(relay.models.map((model: { id: string }) => model.id)).toContain(E2E_RELAY_MANUAL_MODEL);
  });

  test('creates a custom provider through the wizard and applies it immediately', async ({ page }) => {
    // The wizard has to reach the same loopback upstream as the relay provider.
    const before = await (await page.request.get(await adminUrl('/api/providers'))).json();
    const relayBaseUrl = before.providers.find((provider: { alias: string }) => provider.alias === E2E_RELAY_ALIAS)
      .base_url as string;

    await page.goto(await adminUrl('/providers'));
    await page.getByRole('button', { name: 'New provider' }).click();

    await page.locator('#wizard-kind').selectOption('custom');
    await page.locator('#wizard-alias').fill('relay2');
    await page.locator('#wizard-base-url').fill(relayBaseUrl);
    await page.getByRole('button', { name: 'Next' }).click();

    await page.locator('#wizard-api-key').fill(E2E_SECRETS.wizard);
    await page.getByRole('button', { name: 'Next' }).click();

    // The provider is not saved yet, so the listing is fetched in temporary mode
    // with the key that was just typed.
    await page.getByRole('button', { name: 'Fetch models' }).click();
    const row = page.locator('li').filter({ hasText: E2E_RELAY_COMPLETE_MODEL });
    await expect(row).toBeVisible();
    await page.getByLabel(`Select ${E2E_RELAY_COMPLETE_MODEL}`).check();
    await page.getByRole('button', { name: 'Accept these values (1)' }).click();
    await page.getByRole('button', { name: 'Create provider' }).click();

    // A create is applied immediately like every other write: the wizard closes
    // and the new provider is selected in the list.
    await expect(appliedToast(page).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Provider relay2' })).toBeVisible();
    // The wizard fades out while staying in the DOM; wait for it to leave so its
    // own "Fetch models" button cannot collide with the page's.
    await expect(page.getByRole('dialog')).toHaveCount(0);

    // The running registry already knows the new connection, so saved-mode
    // discovery fetches the listing without asking for the key again.
    await page.getByRole('button', { name: 'Fetch models' }).click();
    await page.getByRole('button', { name: 'Fetch', exact: true }).click();
    await expect(page.getByText('Requested from:')).toBeVisible();
    await page.getByRole('button', { name: 'Cancel' }).click();

    // The fetched model can be set as the agent model right away.
    await setAsAgent(modelListRow(page, E2E_RELAY_COMPLETE_MODEL));
    await expect(page.getByText('Thinking effort reset to off', { exact: false }).first()).toBeVisible();

    const after = await (await page.request.get(await adminUrl('/api/providers'))).json();
    const created = after.providers.find((provider: { alias: string }) => provider.alias === 'relay2');
    expect(created.models.map((model: { id: string }) => model.id)).toEqual([E2E_RELAY_COMPLETE_MODEL]);
    expect(after.agent).toMatchObject({ provider: 'relay2', model: E2E_RELAY_COMPLETE_MODEL });
    expect(after.restart_required.filter((path: string) => path.startsWith('providers.'))).toEqual([]);
    expect(JSON.stringify(after)).not.toContain(E2E_SECRETS.wizard);
  });

  test('refuses to create a provider while a header row has no value', async ({ page }) => {
    const before = await (await page.request.get(await adminUrl('/api/providers'))).json();
    const relayBaseUrl = before.providers.find((provider: { alias: string }) => provider.alias === E2E_RELAY_ALIAS)
      .base_url as string;

    await page.goto(await adminUrl('/providers'));
    await page.getByRole('button', { name: 'New provider' }).click();

    await page.locator('#wizard-kind').selectOption('custom');
    await page.locator('#wizard-alias').fill('relay3');
    await page.locator('#wizard-base-url').fill(relayBaseUrl);
    await page.getByRole('button', { name: 'Next' }).click();

    await page.locator('#wizard-api-key').fill(E2E_SECRETS.wizard);
    const dialog = page.getByRole('dialog');
    await page.getByRole('button', { name: 'Add header' }).click();
    await dialog.getByLabel('Header name', { exact: true }).first().fill('x-extra');
    await page.getByRole('button', { name: 'Next' }).click();

    // Metadata lookup never sends headers, so the incomplete row survives until
    // the submit — where it must be reported instead of silently dropped.
    await page
      .getByLabel('Or enter model IDs by hand (one per line, or separated by commas)')
      .fill(E2E_RELAY_MANUAL_MODEL);
    await page.getByRole('button', { name: 'Look up model details' }).click();
    await page.getByLabel(`Select ${E2E_RELAY_MANUAL_MODEL}`).check();
    await page.getByRole('button', { name: 'Accept these values (1)' }).click();
    await page.getByRole('button', { name: 'Create provider' }).click();

    await expect(page.getByText('Header x-extra needs a value')).toBeVisible();
    const after = await (await page.request.get(await adminUrl('/api/providers'))).json();
    expect(after.providers.map((provider: { alias: string }) => provider.alias)).not.toContain('relay3');
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
