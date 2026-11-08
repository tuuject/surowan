import { expect, type Page } from '@playwright/test';
import { adminUrl, appliedToast, modelListRow, test, watchPageIssues } from './helpers.ts';
import { E2E_MERGE_ALIAS, E2E_MERGE_MODEL, roleToggle } from './models-fixture.ts';

/**
 * The split between the Models page (which model does each job, at what
 * thinking effort, edited as a draft and saved from the action bar) and the
 * Providers page (the registry, plus a one-click "Use as" toggle per role on
 * every model row), against the real AdminServer. The Vision card's effort is
 * `vision.thinking_level`: every write goes through the UI and is checked
 * against `GET /api/providers`, which reads the file. Screenshots of both
 * pages are attached as the run's artifacts.
 */
test.use({ signedIn: true });

interface RoleView {
  readonly provider: string | null;
  readonly model: string | null;
  readonly thinking_level: string | null;
}

interface ProvidersView {
  readonly agent: RoleView;
  readonly vision: RoleView;
  readonly tool_model: RoleView & { readonly inherited: boolean };
}

async function providersView(page: Page): Promise<ProvidersView> {
  const response = await page.request.get(await adminUrl('/api/providers'));
  expect(response.ok()).toBe(true);
  return (await response.json()) as ProvidersView;
}

async function attachScreenshot(page: Page, name: string): Promise<void> {
  const path = test.info().outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: true });
  await test.info().attach(name, { path, contentType: 'image/png' });
}

test.describe('model roles', () => {
  test('the Vision card drafts a model and its effort, and Save writes both', async ({ page }) => {
    const finish = watchPageIssues(page);
    await page.goto(await adminUrl('/models'));
    const card = page.getByRole('region', { name: 'Vision model', exact: true });
    const picker = card.getByRole('combobox', { name: 'Model', exact: true });
    const effort = card.getByRole('combobox', { name: 'Thinking effort', exact: true });

    // The fixture vision model does not reason: its only effort is `off`.
    await expect(picker).toHaveText(/vision \/ vision-model/);
    await expect(effort).toHaveValue('off');
    await expect(effort).toBeDisabled();
    await expect(card.getByText('This model has no thinking effort to adjust', { exact: true })).toBeVisible();
    expect((await providersView(page)).vision).toEqual({
      provider: 'vision',
      model: 'vision-model',
      thinking_level: 'off',
    });

    // Only image-capable models are offered; the text-only merge model is not.
    await picker.click();
    await expect(page.getByRole('option', { name: new RegExp(E2E_MERGE_MODEL) })).toHaveCount(0);
    await page.getByRole('option', { name: /agent-model/ }).click();
    await expect(picker).toHaveText(/agent \/ agent-model/);
    // After a model that does not reason, the new one starts at its default,
    // `low`, rather than keeping a meaningless `off`.
    await expect(effort).toBeEnabled();
    await expect(effort).toHaveValue('low');
    await effort.selectOption('high');
    // Model and effort are two unsaved changes; the card is marked, the file is not touched.
    await expect(page.getByRole('status').filter({ hasText: '2 unsaved changes' })).toBeVisible();
    await expect(card.getByText('Unsaved changes', { exact: true })).toHaveCount(1);
    expect((await providersView(page)).vision).toEqual({
      provider: 'vision',
      model: 'vision-model',
      thinking_level: 'off',
    });

    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'All changes saved' })).toBeVisible();
    await expect(appliedToast(page).first()).toBeVisible();
    expect((await providersView(page)).vision).toEqual({
      provider: 'agent',
      model: 'agent-model',
      thinking_level: 'high',
    });
    await expect(effort).toHaveValue('high');
    await expect(card.getByText('Unsaved changes', { exact: true })).toHaveCount(0);
    await attachScreenshot(page, 'models-page');

    const issues = finish();
    expect(issues.pageErrors, JSON.stringify(issues.pageErrors)).toEqual([]);
    expect(issues.consoleErrors, JSON.stringify(issues.consoleErrors)).toEqual([]);
  });

  test('discarding puts every card back to the saved file', async ({ page }) => {
    const before = await providersView(page);
    await page.goto(await adminUrl('/models'));
    const agentCard = page.getByRole('region', { name: 'Agent model', exact: true });
    const effort = agentCard.getByRole('combobox', { name: 'Thinking effort', exact: true });
    const saved = await effort.inputValue();
    await effort.selectOption(saved === 'high' ? 'medium' : 'high');
    await expect(page.getByRole('status').filter({ hasText: '1 unsaved change' })).toBeVisible();

    await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'No unsaved changes' })).toBeVisible();
    await expect(effort).toHaveValue(saved);
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
    expect((await providersView(page)).agent).toEqual(before.agent);
  });

  test('a model row hands out each role in one click', async ({ page }) => {
    await page.goto(await adminUrl('/providers'));

    // Vision back to the fixture model from the row: the stored `high` from the
    // previous test is one this model rejects, so the switch drops it.
    await page.getByRole('button', { name: 'Provider vision', exact: true }).click();
    const visionRow = modelListRow(page, 'vision-model');
    await expect(roleToggle(visionRow, 'Vision')).toHaveAttribute('aria-pressed', 'false');
    await roleToggle(visionRow, 'Vision').click();
    await expect(roleToggle(visionRow, 'Vision')).toHaveAttribute('aria-pressed', 'true');
    expect((await providersView(page)).vision).toEqual({
      provider: 'vision',
      model: 'vision-model',
      thinking_level: 'off',
    });

    // A text-only model offers no Vision toggle at all.
    await page.getByRole('button', { name: `Provider ${E2E_MERGE_ALIAS}`, exact: true }).click();
    const mergeRow = modelListRow(page, E2E_MERGE_MODEL);
    await expect(roleToggle(mergeRow, 'Agent')).toBeVisible();
    await expect(roleToggle(mergeRow, 'Vision')).toHaveCount(0);

    // Tool: the inherited effort (`low`) is one the merge model accepts, so it stays.
    expect((await providersView(page)).tool_model.inherited).toBe(true);
    await roleToggle(mergeRow, 'Tool').click();
    await expect(roleToggle(mergeRow, 'Tool')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByText('Tool Model switched', { exact: false }).first()).toBeVisible();
    expect((await providersView(page)).tool_model).toEqual({
      provider: E2E_MERGE_ALIAS,
      model: E2E_MERGE_MODEL,
      thinking_level: 'low',
      inherited: false,
    });
    // A model that fills a role cannot be deleted from its row.
    await expect(mergeRow.getByRole('button', { name: `Delete ${E2E_MERGE_MODEL}`, exact: true })).toBeDisabled();
    // Pressing a pressed toggle changes nothing.
    await roleToggle(mergeRow, 'Tool').click();
    await attachScreenshot(page, 'providers-page');

    // The Models page reads the same file: the Tool card shows the row's pick.
    await page
      .getByRole('navigation', { name: 'Main navigation' })
      .getByRole('link', { name: 'Models', exact: true })
      .click();
    const toolCard = page.getByRole('region', { name: 'Tool Model', exact: true });
    await expect(toolCard.getByRole('combobox', { name: 'Model', exact: true })).toHaveText(
      new RegExp(`${E2E_MERGE_ALIAS} / ${E2E_MERGE_MODEL}`),
    );
    await expect(toolCard.getByRole('combobox', { name: 'Thinking effort', exact: true })).toHaveValue('low');
    const after = await providersView(page);
    expect(after.tool_model).toMatchObject({ provider: E2E_MERGE_ALIAS, model: E2E_MERGE_MODEL, inherited: false });
    expect(after.agent).toMatchObject({ provider: 'agent', model: 'agent-model' });
  });
});
