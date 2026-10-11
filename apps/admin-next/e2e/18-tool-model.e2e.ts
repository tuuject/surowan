import { expect, test } from '@playwright/test';
import { adminUrl, authStoragePath, watchPageIssues } from './helpers.ts';
import { E2E_MERGE_ALIAS, E2E_MERGE_MODEL } from './models-fixture.ts';

/**
 * The Models page's Tool Model setting against the real AdminServer: it still
 * inherits the agent model by default, switching to an explicit pick writes the
 * provider/model/thinking triple, and "Inherit Agent model" restores the
 * fallback. The Dictionary merge flow that consumes it lives in
 * `17-dictionary.e2e.ts`.
 */
test.use({ storageState: authStoragePath() });

interface ToolModelView {
  readonly provider: string;
  readonly model: string;
  readonly thinking_level: string;
  readonly inherited: boolean;
}

interface ProvidersView {
  readonly revision: string;
  readonly agent: { readonly provider: string; readonly model: string; readonly thinking_level: string };
  readonly tool_model: ToolModelView;
}

async function providersView(page: import('@playwright/test').Page): Promise<ProvidersView> {
  const response = await page.request.get(await adminUrl('/api/providers'));
  expect(response.ok()).toBe(true);
  return (await response.json()) as ProvidersView;
}

test.describe('tool model', () => {
  test('shows the inherited agent settings and the picker', async ({ page }) => {
    const finish = watchPageIssues(page);
    await page.goto(await adminUrl('/models'));
    await expect(page.getByText('Tool Model').first()).toBeVisible();
    // The fixture config never sets a Tool Model, so it starts inherited.
    await expect(page.getByText('Inherited from the Agent model')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Select a Tool Model' })).toBeVisible();

    const issues = finish();
    expect(issues.pageErrors, JSON.stringify(issues.pageErrors)).toEqual([]);
    expect(issues.consoleErrors, JSON.stringify(issues.consoleErrors)).toEqual([]);
  });

  test('picking a model with an explicit thinking level writes all three fields', async ({ page }) => {
    const before = await providersView(page);
    await page.goto(await adminUrl('/models'));
    await page.getByRole('button', { name: 'Select a Tool Model' }).click();
    const picker = page.getByRole('dialog');
    // The picker walks the same provider list the table renders; this one is a
    // reasoning model with declared levels.
    await picker.getByRole('button', { name: new RegExp(`${E2E_MERGE_ALIAS}/${E2E_MERGE_MODEL}`) }).click();
    await picker.getByLabel('Thinking effort').click();
    await page.getByRole('option', { name: 'high', exact: true }).click();
    await picker.getByRole('button', { name: 'Save Tool Model' }).click();
    await expect(page.getByText('Tool Model saved')).toBeVisible();

    const after = await providersView(page);
    expect(after.tool_model.provider).toBe(E2E_MERGE_ALIAS);
    expect(after.tool_model.model).toBe(E2E_MERGE_MODEL);
    expect(after.tool_model.thinking_level).toBe('high');
    expect(after.tool_model.inherited).toBe(false);

    // Restore the fixture baseline for the rest of the suite.
    const restore = await page.request.put(await adminUrl('/api/tool-model'), {
      headers: { 'if-match': after.revision },
      data: { inherit: true },
    });
    expect(restore.ok()).toBe(true);
    expect(before.tool_model.inherited).toBe(true);
  });

  test('inherit restores the agent model instead of keeping the explicit pick', async ({ page }) => {
    const baseline = await providersView(page);
    const explicit = await page.request.put(await adminUrl('/api/tool-model'), {
      headers: { 'if-match': baseline.revision },
      data: { provider: E2E_MERGE_ALIAS, model: E2E_MERGE_MODEL, thinking_level: 'low' },
    });
    expect(explicit.ok()).toBe(true);

    await page.goto(await adminUrl('/models'));
    await expect(page.getByText('Inherited from the Agent model')).toHaveCount(0);
    await page.getByRole('button', { name: 'Inherit Agent model' }).click();
    await expect(page.getByText('Tool Model now inherits the Agent model')).toBeVisible();

    const after = await providersView(page);
    expect(after.tool_model.inherited).toBe(true);
    expect(after.tool_model.provider).toBe(after.agent.provider);
    expect(after.tool_model.model).toBe(after.agent.model);
    expect(after.tool_model.thinking_level).toBe(after.agent.thinking_level);
  });
});
