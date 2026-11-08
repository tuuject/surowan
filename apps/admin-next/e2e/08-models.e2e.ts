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
 * discovery dialog (saved mode against a loopback upstream started by
 * `e2e/server.ts`) plus the thinking effort it enables on the Models page.
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
    await expect(connection.getByLabel('base_url', { exact: true })).toHaveValue('https://openrouter.ai/api/v1');
    const keyInput = page.getByLabel('API Key', { exact: true });
    await expect(keyInput).toHaveAttribute('type', 'password');
    await expect(keyInput).toHaveAttribute('autocomplete', 'new-password');
    await expect(keyInput).toHaveValue('');
    await expect(page.getByText('Saved; leave empty to keep it')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Fetch models', exact: true })).toBeVisible();
    await expect(page.locator('[data-model-list] li').first()).toBeVisible();
    await expect(page.getByText('Something went wrong')).toHaveCount(0);
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
    await expect(connection.getByLabel('Header', { exact: true }).first()).toHaveValue('x-relay-token');
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

    // The applied connection is live in the running registry, so the discovery
    // dialog opens in saved mode instead of demanding the key again.
    await page.getByRole('button', { name: 'Fetch models' }).click();
    await expect(page.getByRole('button', { name: 'Use temporary mode (key from this form)' })).toBeVisible();
    await expect(page.locator('#picker-api-key')).toHaveCount(0);
    await page.getByRole('button', { name: 'Cancel' }).click();
  });

  test('discovery resolves metadata from the local upstream and blocks unconfirmed drafts', async ({ page }) => {
    await page.goto(await adminUrl('/providers'));
    await page.getByRole('button', { name: `Provider ${E2E_RELAY_ALIAS}` }).click();
    await page.getByRole('button', { name: 'Fetch models' }).click();

    // Saved mode: the running registry's connection, which points at the loopback upstream.
    await page.getByRole('button', { name: 'Fetch', exact: true }).click();
    await expect(page.getByText('endpoint:')).toBeVisible();

    const completeRow = page.locator('li').filter({ hasText: E2E_RELAY_COMPLETE_MODEL });
    const incompleteRow = page.locator('li').filter({ hasText: E2E_RELAY_INCOMPLETE_MODEL });
    await expect(completeRow).toBeVisible();
    await expect(incompleteRow).toBeVisible();
    // models.dev lists a toggle plus three efforts for the known model.
    await expect(completeRow.getByText('off / low / high / max')).toBeVisible();
    // The relay's own host is unknown to models.dev, so even the model it does
    // know was matched under another provider and has to be confirmed.
    await expect(completeRow.getByText('to confirm', { exact: false })).toBeVisible();
    // Every field of the second model is missing, so it cannot be taken as it is.
    await expect(incompleteRow.getByText('to confirm', { exact: false })).toBeVisible();

    await page.getByLabel(`Select ${E2E_RELAY_COMPLETE_MODEL}`).check();
    await page.getByLabel(`Select ${E2E_RELAY_INCOMPLETE_MODEL}`).check();
    await expect(page.getByRole('button', { name: /Add \d+ models/ })).toBeDisabled();

    // Accepting the listed values covers the draft that has them all; the one
    // with empty fields still has to go through the dialog.
    await page.getByRole('button', { name: 'Accept listed values (1)' }).click();
    await expect(completeRow.getByText('Confirmed')).toBeVisible();
    await expect(page.getByRole('button', { name: /Add \d+ models/ })).toBeDisabled();

    await incompleteRow.getByRole('button', { name: 'Edit' }).click();
    await expect(page.getByText('Confirm or fill in:', { exact: false })).toBeVisible();
    await page.locator('#model-context').fill('64000');
    await page.locator('#model-max-tokens').fill('8192');
    await page
      .getByRole('dialog', { name: `Confirm ${E2E_RELAY_INCOMPLETE_MODEL}` })
      .getByRole('checkbox', { name: 'text', exact: true })
      .check();
    await page.locator('#model-cost-input').fill('0.1');
    await page.locator('#model-cost-output').fill('0.2');
    await page.locator('#model-cost-cache_read').fill('0');
    await page.locator('#model-cost-cache_write').fill('0');
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
    expect(complete.thinking_levels).toEqual(['off', 'low', 'high', 'max']);
    await expect(modelListRow(page, E2E_RELAY_COMPLETE_MODEL)).toBeVisible();
  });

  test('a row toggle switches the agent and resets its effort, which the Models page then sets', async ({ page }) => {
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
    await expect(agentCard.getByRole('combobox', { name: 'Model', exact: true })).toHaveText(
      new RegExp(`${E2E_RELAY_ALIAS} / ${E2E_RELAY_COMPLETE_MODEL}`),
    );
    const effort = agentCard.getByRole('combobox', { name: 'Thinking effort', exact: true });
    await expect(effort).toHaveValue('off');
    // Only the levels the model declares are offered.
    await expect(effort.locator('option')).toHaveText(['Not set', 'off', 'low', 'high', 'max']);
    await effort.selectOption('max');
    await expect(effort).toHaveValue('max');
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
