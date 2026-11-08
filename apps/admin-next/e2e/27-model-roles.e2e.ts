import { expect, type Page } from '@playwright/test';
import { adminUrl, appliedToast, modelListRow, test, watchPageIssues } from './helpers.ts';
import { E2E_MERGE_ALIAS, E2E_MERGE_MODEL, roleToggle } from './models-fixture.ts';

/**
 * The split between the Models page (which model does each job, at what
 * thinking effort) and the Providers page (the registry, plus a one-click
 * "Use as" toggle per role on every model row), against the real AdminServer.
 * The Vision card's effort is the new `vision.thinking_level`: every write goes
 * through the UI and is checked against `GET /api/providers`, which reads the
 * file. Screenshots of both pages are attached as the run's artifacts.
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
  test('the Vision card switches its model and sets its thinking effort', async ({ page }) => {
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
    await expect(appliedToast(page).first()).toBeVisible();
    await expect(picker).toHaveText(/agent \/ agent-model/);
    // A reasoning model without a stored effort runs at its default, `low`.
    await expect(effort).toBeEnabled();
    await expect(effort).toHaveValue('low');
    expect((await providersView(page)).vision).toEqual({
      provider: 'agent',
      model: 'agent-model',
      thinking_level: 'low',
    });

    await effort.selectOption('high');
    await expect.poll(async () => (await providersView(page)).vision.thinking_level).toBe('high');
    await expect(effort).toHaveValue('high');
    await attachScreenshot(page, 'models-page');

    const issues = finish();
    expect(issues.pageErrors, JSON.stringify(issues.pageErrors)).toEqual([]);
    expect(issues.consoleErrors, JSON.stringify(issues.consoleErrors)).toEqual([]);
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
