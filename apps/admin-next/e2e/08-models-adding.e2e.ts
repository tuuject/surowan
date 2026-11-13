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
 * The Providers page against the real `AdminServer`, adding side: models
 * added by id through metadata lookup, and the new-provider wizard with its
 * header validation. Every write goes through the UI and is verified against
 * the API afterwards.
 */
test.use({ signedIn: true });

test.describe('providers page adding', () => {
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
    await page.locator('#model-nickname').fill('手动模型');
    await page.locator('#model-context').fill('48000');
    await page.getByRole('button', { name: 'Save' }).click();

    const row = page.locator('li').filter({ hasText: E2E_RELAY_MANUAL_MODEL });
    await expect(row.getByText('Confirmed')).toBeVisible();

    // Reopening a confirmed draft starts from what was saved, not from the
    // metadata again: otherwise a second save would silently drop the edits.
    await row.getByRole('button', { name: 'Edit' }).click();
    await expect(page.locator('#model-nickname')).toHaveValue('手动模型');
    await expect(page.locator('#model-context')).toHaveValue('48000');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(row.getByText('Confirmed')).toBeVisible();

    await page.getByRole('button', { name: 'Add 1 model' }).click();
    await expect(appliedToast(page).first()).toBeVisible();

    const view = await (await page.request.get(await adminUrl('/api/providers'))).json();
    const relay = view.providers.find((provider: { alias: string }) => provider.alias === E2E_RELAY_ALIAS);
    const added = relay.models.find((model: { id: string }) => model.id === E2E_RELAY_MANUAL_MODEL);
    expect(added).toMatchObject({ nickname: '手动模型', context_window: 48000 });
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
    // The model id is exact, so its details need no confirming.
    await expect(page.getByRole('button', { name: /Accept these values/ })).toHaveCount(0);
    await page.getByRole('button', { name: 'Create provider' }).click();

    // A create is applied immediately like every other write: the wizard closes
    // and the new provider is selected in the list.
    await expect(appliedToast(page).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Provider relay2' })).toBeVisible();
    // The wizard fades out while staying in the DOM; wait for it to leave so its
    // own "Fetch models" button cannot collide with the page's.
    await expect(page.getByRole('dialog')).toHaveCount(0);

    // The running registry already knows the new connection, so the picker
    // fetches the listing with the saved key as soon as it opens.
    await page.getByRole('button', { name: 'Fetch models' }).click();
    await expect(page.getByText('Requested from:')).toBeVisible();
    await page.getByRole('button', { name: 'Cancel' }).click();

    // The fetched model can be set as the agent model right away.
    await setAsAgent(modelListRow(page, E2E_RELAY_COMPLETE_MODEL));
    await expect(page.getByText('Thinking effort reset to Off', { exact: false }).first()).toBeVisible();

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
    await page.getByRole('button', { name: 'Create provider' }).click();

    await expect(page.getByText('Header x-extra needs a value')).toBeVisible();
    const after = await (await page.request.get(await adminUrl('/api/providers'))).json();
    expect(after.providers.map((provider: { alias: string }) => provider.alias)).not.toContain('relay3');
  });
});
