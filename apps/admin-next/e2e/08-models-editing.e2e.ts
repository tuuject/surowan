import { expect } from '@playwright/test';
import { adminUrl, appliedToast, test } from './helpers.ts';
import { E2E_RELAY_ALIAS, E2E_RELAY_COMPLETE_MODEL, E2E_RELAY_MANUAL_MODEL, E2E_SECRETS } from './models-fixture.ts';

/**
 * The Models page against the real `AdminServer`, write side: declaring
 * thinking levels on a model, adding models by id, the new-provider wizard
 * with its header validation, and the two stale-revision conflicts. Every
 * write goes through the UI and is verified against the API afterwards.
 */
test.use({ signedIn: true });

test.describe('models page', () => {
  test('declares thinking levels in the edit dialog only for a reasoning model', async ({ page }) => {
    await page.goto(await adminUrl('/models'));
    await page.getByRole('button', { name: `Provider ${E2E_RELAY_ALIAS}` }).click();
    await page.getByRole('button', { name: 'Edit relay-existing-model' }).click();

    // Not a reasoning model: there are no levels to declare.
    await expect(page.locator('#model-thinking-off')).toHaveCount(0);
    await page.locator('#model-reasoning').check();
    await page.locator('#model-thinking-low').check();
    await page.locator('#model-thinking-xhigh').check();
    await page.getByRole('button', { name: 'Save' }).click();
    // The toast only appears once the write and the reload succeeded.
    await expect(appliedToast(page).first()).toBeVisible();

    const view = await (await page.request.get(await adminUrl('/api/providers'))).json();
    const relay = view.providers.find((provider: { alias: string }) => provider.alias === E2E_RELAY_ALIAS);
    const edited = relay.models.find((model: { id: string }) => model.id === 'relay-existing-model');
    expect(edited).toMatchObject({ reasoning: true, thinking_levels: ['low', 'xhigh'] });
  });

  test('adds a model by id through lookup-metadata', async ({ page }) => {
    await page.goto(await adminUrl('/models'));
    await page.getByRole('button', { name: `Provider ${E2E_RELAY_ALIAS}` }).click();
    await page.getByRole('button', { name: 'Add by id' }).click();
    await page.getByLabel('Model ids (one per line, or comma separated)').fill(E2E_RELAY_MANUAL_MODEL);
    await page.getByRole('button', { name: 'Look up metadata' }).click();

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

    await page.goto(await adminUrl('/models'));
    await page.getByRole('button', { name: 'New provider' }).click();

    await page.locator('#wizard-kind').click();
    await page.getByRole('option', { name: /custom/ }).click();
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
    await page.getByRole('button', { name: 'Accept listed values (1)' }).click();
    await page.getByRole('button', { name: 'Create provider' }).click();

    // A create is applied immediately like every other write: the wizard closes
    // and the new provider is selected in the list.
    await expect(appliedToast(page).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Provider relay2' })).toBeVisible();

    // The running registry already knows the new connection, so saved-mode
    // discovery fetches the listing without asking for the key again.
    await page.getByRole('button', { name: 'Fetch models' }).click();
    await page.getByRole('button', { name: 'Fetch', exact: true }).click();
    await expect(page.getByText('endpoint:')).toBeVisible();
    await page.getByRole('button', { name: 'Cancel' }).click();

    // The fetched model can be set as the agent model right away.
    await page
      .locator('tr', { hasText: E2E_RELAY_COMPLETE_MODEL })
      .getByRole('button', { name: 'Set as agent' })
      .click();
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

    await page.goto(await adminUrl('/models'));
    await page.getByRole('button', { name: 'New provider' }).click();

    await page.locator('#wizard-kind').click();
    await page.getByRole('option', { name: /custom/ }).click();
    await page.locator('#wizard-alias').fill('relay3');
    await page.locator('#wizard-base-url').fill(relayBaseUrl);
    await page.getByRole('button', { name: 'Next' }).click();

    await page.locator('#wizard-api-key').fill(E2E_SECRETS.wizard);
    await page.getByRole('button', { name: 'Add header' }).click();
    await page.locator('#wizard-header-name-0').fill('x-extra');
    await page.getByRole('button', { name: 'Next' }).click();

    // Metadata lookup never sends headers, so the incomplete row survives until
    // the submit — where it must be reported instead of silently dropped.
    await page.getByLabel('Or enter model ids by hand (one per line, or comma separated)').fill(E2E_RELAY_MANUAL_MODEL);
    await page.getByRole('button', { name: 'Look up metadata' }).click();
    await page.getByLabel(`Select ${E2E_RELAY_MANUAL_MODEL}`).check();
    await page.getByRole('button', { name: 'Accept listed values (1)' }).click();
    await page.getByRole('button', { name: 'Create provider' }).click();

    await expect(page.getByText('Header x-extra needs a value')).toBeVisible();
    const after = await (await page.request.get(await adminUrl('/api/providers'))).json();
    expect(after.providers.map((provider: { alias: string }) => provider.alias)).not.toContain('relay3');
  });

  test('a header name can be typed key by key without losing focus', async ({ page }) => {
    await page.goto(await adminUrl('/models'));
    await page.getByRole('button', { name: `Provider ${E2E_RELAY_ALIAS}`, exact: true }).click();
    await page.getByRole('button', { name: 'Add header' }).click();
    // The row used to be keyed by its own name, so every keystroke remounted it
    // and dropped the focus after the first character.
    await page.locator('#provider-header-name-1').pressSequentially('x-typed');
    await expect(page.locator('#provider-header-name-1')).toHaveValue('x-typed');
  });

  test('a model edit that loses a revision race is closed instead of overwriting', async ({ page }) => {
    await page.goto(await adminUrl('/models'));
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
    await expect(page.getByText('Nothing was saved - open the model again')).toBeVisible();
    await expect(page.locator('#model-context')).toHaveCount(0);

    const view = await (await page.request.get(await adminUrl('/api/providers'))).json();
    const relay = view.providers.find((provider: { alias: string }) => provider.alias === E2E_RELAY_ALIAS);
    const model = relay.models.find((candidate: { id: string }) => candidate.id === 'relay-existing-model');
    expect(model.name).toBe('Renamed elsewhere');
  });

  test('a connection edit built on an old revision cannot delete a header added meanwhile', async ({ page }) => {
    await page.goto(await adminUrl('/models'));
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
    await expect(page.getByText('config.jsonc changed since you started editing')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled();
    await page.getByRole('button', { name: 'Reload' }).click();
    await expect(page.locator('#provider-header-name-1')).toHaveValue('x-added-elsewhere');

    const view = await (await page.request.get(await adminUrl('/api/providers'))).json();
    const relay = view.providers.find((provider: { alias: string }) => provider.alias === E2E_RELAY_ALIAS);
    expect(relay.header_names).toContain('x-added-elsewhere');
  });
});
