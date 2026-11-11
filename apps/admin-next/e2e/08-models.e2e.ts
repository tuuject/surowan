import { expect } from '@playwright/test';
import { adminUrl, appliedToast, modelListRow, test } from './helpers.ts';
import {
  E2E_BUILTIN_ALIAS,
  E2E_RELAY_ALIAS,
  E2E_RELAY_COMPLETE_MODEL,
  E2E_RELAY_INCOMPLETE_MODEL,
  E2E_SECRETS,
  roleToggle,
  setAsAgent,
} from './models-fixture.ts';

/**
 * The Providers page against the real `AdminServer`: provider list and detail,
 * write-only credentials, applying a builtin key without a restart, and the
 * discovery dialog (which fetches with the saved key as soon as it opens,
 * against a loopback upstream started by `e2e/server.ts`) plus the thinking
 * effort it enables on the Models page.
 * Every write goes through the UI and is verified against the API afterwards.
 */
test.use({ signedIn: true });

test.describe('providers page', () => {
  test('renders the provider rail, the model list and the write-only key field', async ({ page }) => {
    await page.goto(await adminUrl('/providers'));
    await expect(page.getByRole('heading', { name: 'Providers', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: `Provider ${E2E_BUILTIN_ALIAS}` })).toBeVisible();
    await expect(page.getByRole('button', { name: `Provider ${E2E_RELAY_ALIAS}` })).toBeVisible();
    await expect(page.getByText('Agent in use').first()).toBeVisible();

    // Builtin providers show Pi's address read-only and only allow the key to change.
    await page.getByRole('button', { name: `Provider ${E2E_BUILTIN_ALIAS}` }).click();
    const connection = page.getByRole('region', { name: 'Connection', exact: true });
    await expect(connection.getByLabel('API address', { exact: true })).toHaveValue('https://openrouter.ai/api/v1');
    const keyInput = page.getByLabel('API Key', { exact: true });
    await expect(keyInput).toHaveAttribute('type', 'password');
    await expect(keyInput).toHaveAttribute('autocomplete', 'new-password');
    await expect(keyInput).toHaveValue('');
    await expect(page.getByText('Saved; leave empty to keep it')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Fetch models', exact: true })).toBeVisible();
    await expect(page.locator('[data-model-list] li').first()).toBeVisible();
    await expect(page.locator('[data-route-error]')).toHaveCount(0);
  });

  test('never renders a configured secret, and the API never returns one', async ({ page }) => {
    await page.goto(await adminUrl('/providers'));
    const secrets = [...Object.values(E2E_SECRETS), 'telegram-secret', 'agent-secret', 'vision-secret'];
    for (const alias of [E2E_BUILTIN_ALIAS, E2E_RELAY_ALIAS, 'agent', 'vision']) {
      await page.getByRole('button', { name: `Provider ${alias}` }).click();
      await expect(page.getByLabel('API Key', { exact: true })).toBeVisible();
      const html = await page.content();
      for (const secret of secrets) {
        expect(html, `${alias} connection card leaked ${secret}`).not.toContain(secret);
      }
    }

    // Header names are shown; header values never are.
    await page.getByRole('button', { name: `Provider ${E2E_RELAY_ALIAS}` }).click();
    const connection = page.getByRole('region', { name: 'Connection', exact: true });
    await expect(connection.getByLabel('Header name', { exact: true }).first()).toHaveValue('x-relay-token');
    await expect(connection.getByLabel('Value', { exact: true }).first()).toHaveValue('');

    const view = await (await page.request.get(await adminUrl('/api/providers'))).json();
    const serialized = JSON.stringify(view);
    for (const secret of Object.values(E2E_SECRETS)) {
      expect(serialized).not.toContain(secret);
    }
    expect(view.providers.map((provider: { alias: string }) => provider.alias)).toContain(E2E_RELAY_ALIAS);
  });

  test('saving a builtin key applies it without a restart', async ({ page }) => {
    await page.goto(await adminUrl('/providers'));
    await page.getByRole('button', { name: `Provider ${E2E_BUILTIN_ALIAS}` }).click();
    await page.getByLabel('API Key', { exact: true }).fill('e2e-rotated-builtin-key');
    await page.getByRole('button', { name: 'Save' }).click();

    // The rotated key is applied to the running process right away.
    await expect(appliedToast(page).first()).toBeVisible();

    const view = await (await page.request.get(await adminUrl('/api/providers'))).json();
    expect(view.supervised).toBe(true);
    // No provider field waits for a restart. (Settings-side restart-only fields
    // such as `admin.port` may still be pending from earlier tests.)
    expect(view.restart_required.filter((path: string) => path.startsWith('providers.'))).toEqual([]);
    expect(JSON.stringify(view)).not.toContain('e2e-rotated-builtin-key');
  });

  test('discovery fetches on open, fills matched details and asks only for missing key fields', async ({ page }) => {
    await page.goto(await adminUrl('/providers'));
    await page.getByRole('button', { name: `Provider ${E2E_RELAY_ALIAS}` }).click();
    await page.getByRole('button', { name: 'Fetch models' }).click();

    // The listing comes in on its own, with the saved connection and key, which
    // point at the loopback upstream. There is no key to type.
    await expect(page.getByText('Requested from:')).toBeVisible();
    await expect(page.locator('#picker-api-key')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Use a different API key' })).toHaveCount(0);

    const completeRow = page.locator('li').filter({ hasText: E2E_RELAY_COMPLETE_MODEL });
    const incompleteRow = page.locator('li').filter({ hasText: E2E_RELAY_INCOMPLETE_MODEL });
    await expect(completeRow).toBeVisible();
    await expect(incompleteRow).toBeVisible();
    // models.dev lists a toggle plus three efforts for the known model.
    await expect(completeRow.getByText('off / low / high / max')).toBeVisible();
    // The relay's host is unknown to models.dev, but the model id is exact: its
    // details are taken as they are, with nothing to confirm.
    await expect(completeRow.getByText('to confirm', { exact: false })).toHaveCount(0);
    // The second model is unknown: its three key fields are missing, and its
    // thinking support is assumed off, which the row says.
    await expect(incompleteRow.getByText('3 to confirm', { exact: true })).toBeVisible();
    await expect(incompleteRow.getByText("Couldn't find whether this model thinks", { exact: false })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('discovery-drafts.png'), animations: 'disabled' });

    await page.getByLabel(`Select ${E2E_RELAY_COMPLETE_MODEL}`).check();
    await expect(page.getByRole('button', { name: 'Add 1 model' })).toBeEnabled();
    await page.getByLabel(`Select ${E2E_RELAY_INCOMPLETE_MODEL}`).check();
    await expect(page.getByRole('button', { name: /Add \d+ models/ })).toBeDisabled();
    // A missing limit cannot be accepted as listed: it has to be typed in.
    await expect(page.getByRole('button', { name: /Accept these values/ })).toHaveCount(0);

    await incompleteRow.getByRole('button', { name: 'Edit' }).click();
    await expect(page.getByText('Confirm or fill in:', { exact: false })).toBeVisible();
    await page.locator('#model-context').fill('64000');
    await page.locator('#model-max-tokens').fill('8192');
    await page
      .getByRole('dialog', { name: `Confirm ${E2E_RELAY_INCOMPLETE_MODEL}` })
      .getByRole('checkbox', { name: 'Text', exact: true })
      .check();
    // No price anywhere: 0, already filled in.
    await expect(page.locator('#model-cost-input')).toHaveValue('0');
    await page.getByRole('button', { name: 'Save' }).click();

    await expect(incompleteRow.getByText('Confirmed')).toBeVisible();
    await page.getByRole('button', { name: /Add \d+ models/ }).click();
    await expect(appliedToast(page).first()).toBeVisible();

    // The write went through the real server: both models are in the file now.
    const view = await (await page.request.get(await adminUrl('/api/providers'))).json();
    const relay = view.providers.find((provider: { alias: string }) => provider.alias === E2E_RELAY_ALIAS);
    expect(relay.models.map((model: { id: string }) => model.id)).toEqual(
      expect.arrayContaining([E2E_RELAY_COMPLETE_MODEL, E2E_RELAY_INCOMPLETE_MODEL]),
    );
    const complete = relay.models.find((model: { id: string }) => model.id === E2E_RELAY_COMPLETE_MODEL);
    expect(complete).toMatchObject({
      thinking_levels: ['off', 'low', 'high', 'max'],
      context_window: 200_000,
      max_tokens: 32_768,
      input: ['text', 'image'],
      // The relay's own price is unknown: the highest one models.dev lists.
      cost: { input: 0.5, output: 1.5, cache_read: 0.05, cache_write: 0.5 },
    });
    const incomplete = relay.models.find((model: { id: string }) => model.id === E2E_RELAY_INCOMPLETE_MODEL);
    expect(incomplete).toMatchObject({
      reasoning: false,
      context_window: 64_000,
      max_tokens: 8_192,
      cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
    });
    await expect(modelListRow(page, E2E_RELAY_COMPLETE_MODEL)).toBeVisible();
  });

  test('a row toggle switches the agent and resets its effort, which the Models page then saves', async ({ page }) => {
    const agentOf = async (): Promise<{ provider: string; model: string; thinking_level: string }> =>
      (await (await page.request.get(await adminUrl('/api/providers'))).json()).agent;
    await page.goto(await adminUrl('/providers'));

    // Added by the discovery test with the levels models.dev listed.
    await page.getByRole('button', { name: `Provider ${E2E_RELAY_ALIAS}` }).click();
    const row = modelListRow(page, E2E_RELAY_COMPLETE_MODEL);
    await expect(roleToggle(row, 'Agent')).toHaveAttribute('aria-pressed', 'false');
    await setAsAgent(row);
    await expect(page.getByText('Thinking effort reset to off', { exact: false }).first()).toBeVisible();
    await expect(roleToggle(row, 'Agent')).toHaveAttribute('aria-pressed', 'true');
    expect(await agentOf()).toMatchObject({ model: E2E_RELAY_COMPLETE_MODEL, thinking_level: 'off' });

    // The effort is a setting of the model, so it lives on the Models page's Agent card.
    await page
      .getByRole('navigation', { name: 'Main navigation' })
      .getByRole('link', { name: 'Models', exact: true })
      .click();
    const agentCard = page.getByRole('region', { name: 'Agent model', exact: true });
    // The trigger shows the display name discovery took from models.dev, not alias / id.
    await expect(agentCard.getByRole('combobox', { name: 'Model', exact: true })).toHaveText(/Relay Model A/);
    const effort = agentCard.getByRole('combobox', { name: 'Thinking effort', exact: true });
    await expect(effort).toHaveValue('off');
    // Only the levels the model declares are offered.
    await expect(effort.locator('option')).toHaveText(['Not set', 'off', 'low', 'high', 'max']);
    // A draft until saved: the file keeps `off` until the action bar's Save.
    await effort.selectOption('max');
    await expect(effort).toHaveValue('max');
    await expect(page.getByRole('status').filter({ hasText: '1 unsaved change' })).toBeVisible();
    expect(await agentOf()).toMatchObject({ thinking_level: 'off' });
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'All changes saved' })).toBeVisible();
    await expect.poll(agentOf).toMatchObject({ model: E2E_RELAY_COMPLETE_MODEL, thinking_level: 'max' });

    // Put the fixture agent back for the tests that follow.
    await page
      .getByRole('navigation', { name: 'Main navigation' })
      .getByRole('link', { name: 'Providers', exact: true })
      .click();
    await page.getByRole('button', { name: 'Provider agent' }).click();
    await setAsAgent(modelListRow(page, 'agent-model'));
    await expect(roleToggle(modelListRow(page, 'agent-model'), 'Agent')).toHaveAttribute('aria-pressed', 'true');
    expect(await agentOf()).toMatchObject({ provider: 'agent', model: 'agent-model', thinking_level: 'off' });
  });
});
