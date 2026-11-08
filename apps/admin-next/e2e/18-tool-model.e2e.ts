import { expect } from '@playwright/test';
import { adminUrl, test, watchPageIssues } from './helpers.ts';
import { E2E_MERGE_ALIAS, E2E_MERGE_MODEL } from './models-fixture.ts';

/**
 * The Models page's Tool Model card against the real AdminServer: it still
 * inherits the agent model by default, picking a model on the card saves the
 * provider/model/thinking triple on the spot, its own thinking select changes
 * just the level, and the "Inherit Agent model" option restores the fallback.
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

  test('picking a model saves it inline, then its own thinking select sets the level', async ({ page }) => {
    const before = await providersView(page);
    await page.goto(await adminUrl('/models'));
    await toolPicker(page).click();
    // The picker walks the same provider list the Providers page renders; this
    // one is a reasoning model with declared levels, found through the search box.
    await page.getByPlaceholder('Search models').fill(E2E_MERGE_MODEL);
    await page.getByRole('option', { name: new RegExp(E2E_MERGE_MODEL) }).click();
    await expect(page.getByText('Tool Model switched', { exact: false }).first()).toBeVisible();
    await expect(toolPicker(page)).toHaveText(new RegExp(`${E2E_MERGE_ALIAS} / ${E2E_MERGE_MODEL}`));

    const picked = await providersView(page);
    expect(picked.tool_model).toMatchObject({ provider: E2E_MERGE_ALIAS, model: E2E_MERGE_MODEL, inherited: false });

    const thinking = toolThinking(page);
    await expect(thinking).toBeEnabled();
    await thinking.selectOption('high');
    await expect(thinking).toHaveValue('high');
    await expect.poll(async () => (await providersView(page)).tool_model.thinking_level).toBe('high');

    const after = await providersView(page);
    expect(after.tool_model.provider).toBe(E2E_MERGE_ALIAS);
    expect(after.tool_model.model).toBe(E2E_MERGE_MODEL);
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
    await expect(toolCard(page).getByText('Follows the Agent model', { exact: true })).toHaveCount(0);
    await toolPicker(page).click();
    await page.getByRole('option', { name: 'Inherit Agent model' }).click();
    await expect(page.getByText('Tool Model now inherits the Agent model', { exact: false }).first()).toBeVisible();
    await expect(toolPicker(page)).toHaveText(/Inherit Agent model/);

    const after = await providersView(page);
    expect(after.tool_model.inherited).toBe(true);
    expect(after.tool_model.provider).toBe(after.agent.provider);
    expect(after.tool_model.model).toBe(after.agent.model);
    expect(after.tool_model.thinking_level).toBe(after.agent.thinking_level);
  });
});
