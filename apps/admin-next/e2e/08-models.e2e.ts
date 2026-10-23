import { expect } from '@playwright/test';
import { adminUrl, appliedToast, test } from './helpers.ts';
import {
  E2E_BUILTIN_ALIAS,
  E2E_RELAY_ALIAS,
  E2E_RELAY_COMPLETE_MODEL,
  E2E_RELAY_INCOMPLETE_MODEL,
  E2E_SECRETS,
} from './models-fixture.ts';

/**
 * The Models page against the real `AdminServer`: provider list and detail,
 * write-only credentials, applying a builtin key without a restart, and the
 * discovery dialog (saved mode against a loopback upstream started by
 * `e2e/server.ts`) plus the thinking effort it enables. Every write goes
 * through the UI and is verified against the API afterwards.
 */
test.use({ signedIn: true });

test.describe('models page', () => {
  test('renders the provider list, the model table and the write-only key field', async ({ page }) => {
    await page.goto(await adminUrl('/models'));
    await expect(page.getByText('Providers')).toBeVisible();
    await expect(page.getByRole('button', { name: `Provider ${E2E_BUILTIN_ALIAS}` })).toBeVisible();
    await expect(page.getByRole('button', { name: `Provider ${E2E_RELAY_ALIAS}` })).toBeVisible();
    await expect(page.getByText('Agent in use').first()).toBeVisible();

    // Builtin providers show Pi's address read-only and only allow the key to change.
    await page.getByRole('button', { name: `Provider ${E2E_BUILTIN_ALIAS}` }).click();
    await expect(page.getByText('https://openrouter.ai/api/v1')).toBeVisible();
    const keyInput = page.getByLabel('API Key', { exact: true });
    await expect(keyInput).toHaveAttribute('type', 'password');
    await expect(keyInput).toHaveAttribute('autocomplete', 'new-password');
    await expect(keyInput).toHaveValue('');
    await expect(page.getByText('Set - leave empty to keep it')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Test' })).toBeVisible();
    await expect(page.locator('table tbody tr').first()).toBeVisible();
    await expect(page.getByText('Something went wrong')).toHaveCount(0);
  });

  test('never renders a configured secret, and the API never returns one', async ({ page }) => {
    await page.goto(await adminUrl('/models'));
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
    await expect(page.locator('#provider-header-name-0')).toHaveValue('x-relay-token');
    await expect(page.locator('#provider-header-value-0')).toHaveValue('');

    const view = await (await page.request.get(await adminUrl('/api/providers'))).json();
    const serialized = JSON.stringify(view);
    for (const secret of Object.values(E2E_SECRETS)) {
      expect(serialized).not.toContain(secret);
    }
    expect(view.providers.map((provider: { alias: string }) => provider.alias)).toContain(E2E_RELAY_ALIAS);
  });

  test('saving a builtin key applies it without a restart', async ({ page }) => {
    await page.goto(await adminUrl('/models'));
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
    await page.goto(await adminUrl('/models'));
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
    await page.locator('#model-input-text').check();
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
    await expect(page.locator('table tbody tr', { hasText: E2E_RELAY_COMPLETE_MODEL })).toBeVisible();
  });

  test('switching the agent resets its thinking effort, which the In use panel then sets', async ({ page }) => {
    const agentOf = async (): Promise<{ provider: string; model: string; thinking_level: string }> =>
      (await (await page.request.get(await adminUrl('/api/providers'))).json()).agent;
    await page.goto(await adminUrl('/models'));
    // "In use" also names a table column and a provider badge, so the panel is
    // found by the one control only it has.
    const effort = page.getByRole('combobox', { name: 'Thinking effort' });
    const inUse = page.locator('[data-slot="card"]', { has: effort });

    // Added by the discovery test with the levels models.dev listed.
    await page.getByRole('button', { name: `Provider ${E2E_RELAY_ALIAS}` }).click();
    await page
      .locator('tr', { hasText: E2E_RELAY_COMPLETE_MODEL })
      .getByRole('button', { name: 'Set as agent' })
      .click();
    await expect(page.getByText('Thinking effort reset to off', { exact: false }).first()).toBeVisible();
    await expect(inUse.getByText(`${E2E_RELAY_ALIAS} / ${E2E_RELAY_COMPLETE_MODEL}`)).toBeVisible();
    await expect(effort).toHaveText('off');
    expect(await agentOf()).toMatchObject({ model: E2E_RELAY_COMPLETE_MODEL, thinking_level: 'off' });

    // Only the levels the model declares are offered.
    await effort.click();
    await expect(page.getByRole('option')).toHaveText(['off', 'low', 'high', 'max']);
    await page.getByRole('option', { name: 'max' }).click();
    await expect(effort).toHaveText('max');
    expect(await agentOf()).toMatchObject({ model: E2E_RELAY_COMPLETE_MODEL, thinking_level: 'max' });

    // Put the fixture agent back for the tests that follow.
    await page.getByRole('button', { name: 'Provider agent' }).click();
    await page.locator('tr', { hasText: 'agent-model' }).getByRole('button', { name: 'Set as agent' }).click();
    await expect(inUse.getByText('agent / agent-model')).toBeVisible();
    expect(await agentOf()).toMatchObject({ provider: 'agent', model: 'agent-model', thinking_level: 'off' });
  });
});
