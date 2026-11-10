import { expect } from '@playwright/test';
import { adminUrl, test, watchPageIssues } from './helpers.ts';
import { E2E_MERGE_ALIAS, E2E_MERGE_MODEL } from './models-fixture.ts';

/**
 * The Models page's Tool Model card against the real AdminServer: it still
 * inherits the agent model by default, picking a model and a level on the card
 * stays a draft until the action bar saves the provider/model/thinking triple,
 * and the "Inherit Agent model" option restores the fallback the same way.
 * The Dictionary merge flow that consumes it lives in `17-dictionary.e2e.ts`.
 */
test.use({ signedIn: true });

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

/** The Tool Model card; its fields are named by their Field labels. */
function toolCard(page: import('@playwright/test').Page): import('@playwright/test').Locator {
  return page.getByRole('region', { name: 'Tool Model', exact: true });
}

function toolPicker(page: import('@playwright/test').Page): import('@playwright/test').Locator {
  return toolCard(page).getByRole('combobox', { name: 'Model', exact: true });
}

function toolThinking(page: import('@playwright/test').Page): import('@playwright/test').Locator {
  return toolCard(page).getByRole('combobox', { name: 'Thinking effort', exact: true });
}

test.describe('tool model', () => {
  test('shows the inherited agent settings inline', async ({ page }) => {
    const finish = watchPageIssues(page);
    await page.goto(await adminUrl('/models'));
    // The fixture config never sets a Tool Model, so it starts inherited, and
    // the inherited level belongs to the Agent card.
    await expect(toolPicker(page)).toHaveText(/Inherit Agent model/);
    await expect(toolCard(page).getByText('Follows the Agent model', { exact: true })).toBeVisible();
    await expect(toolThinking(page)).toBeDisabled();
    await expect(page.getByRole('dialog')).toHaveCount(0);

    const issues = finish();
    expect(issues.pageErrors, JSON.stringify(issues.pageErrors)).toEqual([]);
    expect(issues.consoleErrors, JSON.stringify(issues.consoleErrors)).toEqual([]);
  });

  test('a picked model and level stay a draft until Save writes them together', async ({ page }) => {
    const before = await providersView(page);
    await page.goto(await adminUrl('/models'));
    await toolPicker(page).click();
    // The picker walks the same provider list the Providers page renders; this
    // one is a reasoning model with declared levels, found through the search box.
    await page.getByPlaceholder('Search models').fill(E2E_MERGE_MODEL);
    await page.getByRole('option', { name: new RegExp(E2E_MERGE_MODEL) }).click();
    // A named model shows only its display name in the trigger.
    await expect(toolPicker(page)).toHaveText(/Merge Tool Model/);

    // The inherited `low` is one the merge model accepts, so the draft keeps it.
    const thinking = toolThinking(page);
    await expect(thinking).toBeEnabled();
    await expect(thinking).toHaveValue('low');
    await thinking.selectOption('high');
    await expect(page.getByRole('status').filter({ hasText: '2 unsaved changes' })).toBeVisible();
    expect((await providersView(page)).tool_model.inherited).toBe(true);

    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'All changes saved' })).toBeVisible();
    await expect(thinking).toHaveValue('high');

    const after = await providersView(page);
    expect(after.tool_model.provider).toBe(E2E_MERGE_ALIAS);
    expect(after.tool_model.model).toBe(E2E_MERGE_MODEL);
    expect(after.tool_model.inherited).toBe(false);
    expect(after.tool_model.thinking_level).toBe('high');

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
    await expect(toolCard(page).getByText('Follows the Agent model', { exact: true })).toHaveCount(0);
    await toolPicker(page).click();
    await page.getByRole('option', { name: 'Inherit Agent model' }).click();
    await expect(toolPicker(page)).toHaveText(/Inherit Agent model/);
    // The inherited level is shown, and it is the Agent's: not an edit of its own.
    await expect(toolCard(page).getByText('Follows the Agent model', { exact: true })).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: '1 unsaved change' })).toBeVisible();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'All changes saved' })).toBeVisible();

    const after = await providersView(page);
    expect(after.tool_model.inherited).toBe(true);
    expect(after.tool_model.provider).toBe(after.agent.provider);
    expect(after.tool_model.model).toBe(after.agent.model);
    expect(after.tool_model.thinking_level).toBe(after.agent.thinking_level);
  });
});
