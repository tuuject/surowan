import { expect } from '@playwright/test';
import {
  DEFAULT_QUESTION_FRAGMENT,
  GATE_DEFAULTS,
  gateConfigText,
  gateView,
  mutationCacheVariables,
  resetDecisionGate,
} from './decision-gate-fixture.ts';
import { adminUrl, appliedToast, e2eFetch, test } from './helpers.ts';

/**
 * The entry gate's global form against the real AdminServer. Every test starts
 * from an empty gate section (see `resetDecisionGate`), so `--repeat-each`
 * reruns are meaningful. The file itself is asserted through the E2E
 * `config-text` hook, not only through the UI.
 */
test.use({ signedIn: true });

const NEW_KEY = '{{SECRET_83k5wbnh}}';

test.beforeEach(async ({ page }) => {
  await page.goto(await adminUrl('/'));
  await resetDecisionGate(page);
});

test('shows the defaults and saves only the behaviour fields the user changed', async ({ page }) => {
  await page.goto(await adminUrl('/decision-gate'));
  await expect(page.getByRole('heading', { name: 'Entry gate', level: 1 })).toBeVisible();
  await expect(page.getByRole('switch', { name: 'Enabled', exact: true })).not.toBeChecked();
  const mode = page.getByLabel('Mode', { exact: true });
  await expect(mode).toHaveValue(GATE_DEFAULTS.mode);
  await expect(mode.locator('option')).toHaveText(['Record only', 'Enforce']);
  await expect(page.getByLabel('Threshold', { exact: true })).toHaveValue(String(GATE_DEFAULTS.threshold));
  await expect(page.getByLabel('History messages', { exact: true })).toHaveValue(
    String(GATE_DEFAULTS.history_messages),
  );
  await expect(page.getByLabel('Pending messages', { exact: true })).toHaveValue(
    String(GATE_DEFAULTS.pending_messages),
  );
  await expect(page.getByLabel('Question', { exact: true })).toHaveValue(
    new RegExp(DEFAULT_QUESTION_FRAGMENT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
  );
  await expect(page.getByLabel('Model', { exact: true })).toHaveValue(GATE_DEFAULTS.model);
  await expect(page.getByLabel('Address', { exact: true })).toHaveValue(GATE_DEFAULTS.base_url);
  await expect(page.getByLabel('Timeout (ms)', { exact: true })).toHaveValue(String(GATE_DEFAULTS.timeout_ms));
  await expect(page.getByLabel('API key', { exact: true })).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Save and apply' })).toBeDisabled();

  await mode.selectOption('enforce');
  await page.getByLabel('Threshold', { exact: true }).fill('0.7');
  await page.getByLabel('History messages', { exact: true }).fill('6');
  await page.getByLabel('Pending messages', { exact: true }).fill('4');
  await expect(page.getByText('4 unsaved changes')).toBeVisible();
  await page.getByRole('button', { name: 'Save and apply' }).click();
  await expect(appliedToast(page)).toBeVisible();
  await expect(page.getByText('No unsaved changes')).toBeVisible();

  const view = await gateView(page);
  expect(view.saved).toMatchObject({ mode: 'enforce', threshold: 0.7, history_messages: 6, pending_messages: 4 });
  expect(view.active).toEqual(view.saved);
  const text = await gateConfigText();
  // Only the changed fields were written; enabled stays absent.
  expect(text).toMatch(/"mode":\s*"enforce"/);
  expect(text).toMatch(/"threshold":\s*0\.7/);
  expect(text).toMatch(/"history_messages":\s*6/);
  expect(text).toMatch(/"pending_messages":\s*4/);
  const section = /"decision_gate":\s*{([^}]*)}/.exec(text)?.[1] ?? '';
  expect(section).toContain('"mode"');
  expect(section).not.toContain('"enabled"');

  await page.reload();
  await expect(page.getByLabel('Mode', { exact: true })).toHaveValue('enforce');
  await expect(page.getByLabel('Threshold', { exact: true })).toHaveValue('0.7');
  await expect(page.getByLabel('History messages', { exact: true })).toHaveValue('6');
  await expect(page.getByLabel('Pending messages', { exact: true })).toHaveValue('4');
});

test('enabling without a key shows the server error and leaves the file untouched', async ({ page }) => {
  await page.goto(await adminUrl('/decision-gate'));
  const enabled = page.getByRole('switch', { name: 'Enabled', exact: true });
  await enabled.check();
  await page.getByRole('button', { name: 'Save and apply' }).click();
  const alert = page.getByRole('alert').filter({ hasText: 'decision_gate_invalid' });
  await expect(alert).toBeVisible();
  await expect(alert).toContainText('api_key');
  // The draft is kept, and nothing reached the file.
  await expect(enabled).toBeChecked();
  expect(await gateConfigText()).not.toContain('decision_gate');
  expect((await gateView(page)).key_configured).toBe(false);
});

test('stores a new key in the keychain and keeps only its reference in the file', async ({ page }) => {
  await page.goto(await adminUrl('/decision-gate'));
  await page.getByRole('switch', { name: 'Enabled', exact: true }).check();
  await page.getByLabel('API key', { exact: true }).fill(NEW_KEY);
  await page.getByRole('button', { name: 'Save and apply' }).click();
  await expect(appliedToast(page)).toBeVisible();

  const text = await gateConfigText();
  expect(text).toMatch(/"enabled":\s*true/);
  expect(text).toMatch(/"api_key":\s*{\s*"jar":\s*"decision-gate"\s*}/);
  expect(text).not.toContain(NEW_KEY);
  const view = await gateView(page);
  expect(view.key_configured).toBe(true);
  expect(view.key_source).toEqual({ kind: 'entry', name: 'decision-gate' });
  // The submitted plaintext never reaches the DOM.
  expect(await page.content()).not.toContain(NEW_KEY);

  const keychain = await page.request.get(await adminUrl('/api/keychain'));
  const entries = ((await keychain.json()) as { readonly entries: readonly { readonly name: string }[] }).entries;
  expect(entries.map((entry) => entry.name)).toContain('decision-gate');

  await page.reload();
  await expect(page.getByText('Using the keychain entry decision-gate')).toBeVisible();
  await expect(page.getByLabel('API key', { exact: true })).toHaveValue('');
});

test('picking an existing keychain entry stores its name instead of a new key', async ({ page }) => {
  await page.goto(await adminUrl('/decision-gate'));
  await page.getByRole('switch', { name: 'Enabled', exact: true }).check();
  await page.getByLabel('Key source', { exact: true }).selectOption('entry');
  await page.getByLabel('API key', { exact: true }).selectOption('agent');
  await page.getByRole('button', { name: 'Save and apply' }).click();
  await expect(appliedToast(page)).toBeVisible();
  expect(await gateConfigText()).toMatch(/"api_key":\s*{\s*"jar":\s*"agent"\s*}/);
  expect((await gateView(page)).key_source).toEqual({ kind: 'entry', name: 'agent' });
  await expect(page.getByText('Using the keychain entry agent')).toBeVisible();
});

test('clearing the question sends null and returns the file to the default text', async ({ page }) => {
  await page.goto(await adminUrl('/decision-gate'));
  const question = page.getByLabel('Question', { exact: true });
  await question.fill('Would the bot reply to this batch?');
  await page.getByRole('button', { name: 'Save and apply' }).click();
  await expect(appliedToast(page)).toBeVisible();
  expect(await gateConfigText()).toContain('Would the bot reply to this batch?');

  await page.getByRole('button', { name: 'Use the default question' }).click();
  await expect(question).toHaveValue('');
  await expect(page.getByText('The default question is restored when you save.')).toBeVisible();
  await page.getByRole('button', { name: 'Save and apply' }).click();
  await expect(page.getByLabel('Question', { exact: true })).toHaveValue(
    new RegExp(DEFAULT_QUESTION_FRAGMENT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
  );
  await expect(page.getByText('No unsaved changes')).toBeVisible();
  expect(await gateConfigText()).not.toContain('"instructions"');
});

test('a submitted key never enters the mutation cache', async ({ page }) => {
  const writes: unknown[] = [];
  page.on('request', (request) => {
    if (request.method() === 'PUT' && request.url().endsWith('/api/decision-gate')) {
      writes.push(request.postDataJSON());
    }
  });
  await page.goto(await adminUrl('/decision-gate'));
  await page.getByRole('switch', { name: 'Enabled', exact: true }).check();
  await page.getByLabel('API key', { exact: true }).fill(NEW_KEY);
  await page.getByRole('button', { name: 'Save and apply' }).click();
  await expect(page.getByText('No unsaved changes')).toBeVisible();
  // The secret did reach the server, and the mutation cache kept only the
  // field patch and the boolean that says a key was included.
  expect(writes[0]).toMatchObject({ api_key: NEW_KEY });
  const afterSuccess = await mutationCacheVariables(page);
  expect(afterSuccess.length).toBeGreaterThan(0);
  expect(JSON.stringify(afterSuccess)).not.toContain(NEW_KEY);

  const failedKey = '{{SECRET_5m6n7p8q}}';
  await page.getByLabel('Address', { exact: true }).fill('http://insecure.example');
  await page.getByLabel('API key', { exact: true }).fill(failedKey);
  await page.getByRole('button', { name: 'Save and apply' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'decision_gate_invalid' })).toBeVisible();
  expect(writes[1]).toMatchObject({ api_key: failedKey });
  const afterFailure = await mutationCacheVariables(page);
  expect(afterFailure.length).toBeGreaterThanOrEqual(2);
  expect(JSON.stringify(afterFailure)).not.toContain(failedKey);
});

test('Discard changes also undoes an invalid edit', async ({ page }) => {
  await page.goto(await adminUrl('/decision-gate'));
  const threshold = page.getByLabel('Threshold', { exact: true });
  await threshold.fill('');
  await expect(page.getByText('Enter a number')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save and apply' })).toBeDisabled();
  const discard = page.getByRole('button', { name: 'Discard changes' });
  await expect(discard).toBeEnabled();
  await discard.click();
  await expect(threshold).toHaveValue(String(GATE_DEFAULTS.threshold));
  await expect(page.getByText('No unsaved changes')).toBeVisible();
});

test('the enabled switch shows its running value after an apply failure', async ({ page }) => {
  await page.goto(await adminUrl('/decision-gate'));
  await page.getByRole('switch', { name: 'Enabled', exact: true }).check();
  await page.getByLabel('API key', { exact: true }).fill(NEW_KEY);
  await page.getByRole('button', { name: 'Save and apply' }).click();
  await expect(page.getByText('No unsaved changes')).toBeVisible();

  await e2eFetch('/fail-next-config-apply', { method: 'POST' });
  await page.getByRole('switch', { name: 'Enabled', exact: true }).uncheck();
  await page.getByRole('button', { name: 'Save and apply' }).click();
  await expect(page.getByRole('alert')).toContainText('updated but not applied');
  await expect(page.getByRole('switch', { name: 'Enabled', exact: true })).not.toBeChecked();
  await expect(page.getByRole('status').filter({ hasText: 'Running: On' })).toBeVisible();
});

test('a save that was written but not applied shows the running value', async ({ page }) => {
  await page.goto(await adminUrl('/decision-gate'));
  await page.getByLabel('Threshold', { exact: true }).fill('0.42');
  await e2eFetch('/fail-next-config-apply', { method: 'POST' });
  await page.getByRole('button', { name: 'Save and apply' }).click();
  await expect(page.getByRole('alert')).toContainText('updated but not applied');
  const view = await gateView(page);
  expect(view.saved.threshold).toBe(0.42);
  expect(view.active.threshold).toBe(GATE_DEFAULTS.threshold);
  await expect(page.getByRole('status').filter({ hasText: 'Running: 0.57' })).toBeVisible();
});

test('a stale revision keeps the draft until the explicit reload', async ({ page }) => {
  await page.goto(await adminUrl('/decision-gate'));
  await expect(page.getByLabel('Threshold', { exact: true })).toHaveValue(String(GATE_DEFAULTS.threshold));
  await page.evaluate(async () => {
    const view = (await (await fetch('/api/decision-gate')).json()) as { revision: string };
    const response = await fetch('/api/decision-gate', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'if-match': view.revision },
      body: JSON.stringify({ instructions: 'External question' }),
    });
    if (!response.ok) {
      throw new Error(`The concurrent write failed: ${response.status}`);
    }
  });
  await page.getByLabel('Threshold', { exact: true }).fill('0.66');
  await page.getByRole('button', { name: 'Save and apply' }).click();
  await expect(page.getByText('The configuration changed elsewhere')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save and apply' })).toBeDisabled();
  // The draft stays visible until Reload: a background refetch must not replace
  // it while the alert tells the user to reload first.
  await expect(page.getByLabel('Threshold', { exact: true })).toHaveValue('0.66');
  expect(await gateConfigText()).not.toMatch(/"threshold":\s*0\.66/);

  await page.getByRole('button', { name: 'Reload' }).click();
  await expect(page.getByText('The configuration changed elsewhere')).toHaveCount(0);
  await expect(page.getByLabel('Question', { exact: true })).toHaveValue('External question');
  await page.getByLabel('Threshold', { exact: true }).fill('0.66');
  await page.getByRole('button', { name: 'Save and apply' }).click();
  await expect(page.getByText('No unsaved changes')).toBeVisible();
  expect(await gateConfigText()).toMatch(/"threshold":\s*0\.66/);
});

test('the final form is the review artifact', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1600 });
  await page.goto(await adminUrl('/decision-gate'));
  await page.getByRole('switch', { name: 'Enabled', exact: true }).check();
  await page.getByLabel('Mode', { exact: true }).selectOption('enforce');
  await page.getByLabel('Threshold', { exact: true }).fill('0.6');
  await page.getByLabel('History messages', { exact: true }).fill('12');
  await page.getByLabel('API key', { exact: true }).fill(NEW_KEY);
  await page.getByRole('button', { name: 'Save and apply' }).click();
  await expect(appliedToast(page)).toBeVisible();
  await expect(page.getByText('Using the keychain entry decision-gate')).toBeVisible();
  await expect(page.getByText('No unsaved changes')).toBeVisible();
  expect(await page.content()).not.toContain(NEW_KEY);
  // Let the save toast clear so the artifact shows the settled form.
  await expect(page.locator('[data-koi-toast]')).toHaveCount(0);

  const screenshot = testInfo.outputPath('decision-gate.png');
  await page.screenshot({ path: screenshot, fullPage: true, animations: 'disabled' });
  await testInfo.attach('decision-gate', { path: screenshot, contentType: 'image/png' });
});
