import { expect } from '@playwright/test';
import { adminUrl, test, toast } from './helpers.ts';
import {
  fakeExtractRequests,
  fakePng,
  fakeUpdateRequests,
  fakeUploads,
  fakeWrites,
  installImageAssetsFake,
  queueExtract,
} from './image-assets-fake.ts';

test.use({ signedIn: true });

/**
 * The reference-image tab's editing flows against the shared stateful fake:
 * uploads, the edit dialog (which sends only changed fields), the AI
 * suggestion preview with its one-off model escape hatch, and the guarantee
 * that every dialog opening is a fresh session with no leakage from the last.
 */

test.beforeEach(async ({ page }) => {
  await installImageAssetsFake(page);
});

test('a reference image uploads, edits only the changed fields, and archives through real writes', async ({
  page,
}, testInfo) => {
  await page.goto(await adminUrl('/image-assets'));
  await page.getByRole('button', { name: 'Images', exact: true }).click();
  await expect(page.getByText('Reference garden', { exact: true })).toBeVisible();

  await page.locator('input[type="file"]').setInputFiles({
    name: 'e2e-upload.png',
    mimeType: 'image/png',
    buffer: fakePng(),
  });
  await expect(toast(page, 'Uploaded')).toBeVisible();
  // The fake accepts anything, so the bytes that left the page are checked
  // here: the real service decodes and validates them.
  expect(fakeUploads().map((upload) => ({ name: upload.name, mime: upload.mime }))).toEqual([
    { name: 'e2e-upload.png', mime: 'image/png' },
  ]);
  expect(Buffer.from(fakeUploads()[0]?.base64 ?? '', 'base64').equals(fakePng())).toBe(true);
  const uploadedRow = page.locator('table tbody tr', { hasText: 'e2e-upload.png' });
  await expect(uploadedRow).toBeVisible();

  // Change only the name, keywords and the visibility switch; description and
  // category stay as they were, so the save must not mention them.
  await uploadedRow.getByRole('button', { name: 'Edit', exact: true }).click();
  const editDialog = page.getByRole('dialog');
  await expect(editDialog.getByRole('heading', { name: 'Edit e2e-upload.png', exact: true })).toBeVisible();
  const nameField = editDialog.getByRole('textbox', { name: 'Name', exact: true });
  await expect(nameField).toHaveValue('e2e-upload.png');
  await nameField.fill('Renamed reference');
  await editDialog.getByRole('textbox', { name: 'Keywords', exact: true }).fill('garden, pond');
  await editDialog.getByRole('switch').click();
  await page.screenshot({ path: testInfo.outputPath('image-assets-edit.png') });
  await testInfo.attach('image-assets-edit', {
    path: testInfo.outputPath('image-assets-edit.png'),
    contentType: 'image/png',
  });
  await editDialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(toast(page, 'Saved').last()).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(fakeUpdateRequests()).toEqual([{ name: 'Renamed reference', keywords: 'garden, pond', agentVisible: true }]);
  const editedRow = page.locator('table tbody tr', { hasText: 'Renamed reference' });
  await expect(editedRow.getByText('garden, pond')).toBeVisible();
  await expect(editedRow.getByText('Usable', { exact: true })).toBeVisible();

  // A save with nothing changed sends no request at all.
  await editedRow.getByRole('button', { name: 'Edit', exact: true }).click();
  const unchangedDialog = page.getByRole('dialog');
  await unchangedDialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(fakeUpdateRequests()).toHaveLength(1);

  // Demoting back to private sends only the switch, nothing else.
  await editedRow.getByRole('button', { name: 'Edit', exact: true }).click();
  const privateDialog = page.getByRole('dialog');
  await privateDialog.getByRole('switch').click();
  await privateDialog.getByRole('button', { name: 'Save', exact: true }).click();
  // The first save's toast may still be fading; the newest one is the proof.
  await expect(toast(page, 'Saved').last()).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(fakeUpdateRequests()).toEqual([
    { name: 'Renamed reference', keywords: 'garden, pond', agentVisible: true },
    { agentVisible: false },
  ]);
  await expect(editedRow.getByText('Private', { exact: true })).toBeVisible();

  await editedRow.getByRole('button', { name: 'Archive', exact: true }).click();
  const confirm = page.getByRole('alertdialog');
  await expect(confirm.getByRole('heading', { name: 'Archive Renamed reference', exact: true })).toBeVisible();
  await confirm.getByRole('button', { name: 'Archive', exact: true }).click();
  await expect(toast(page, 'Archived')).toBeVisible();
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await expect(page.locator('table tbody tr', { hasText: 'Renamed reference' })).toHaveCount(0);
  await expect(page.getByText('Reference garden', { exact: true })).toBeVisible();
  expect(fakeWrites().filter((entry) => !entry.endsWith('/extract'))).toEqual([
    'POST /api/image/images',
    'PUT /api/image/images/image-created-1',
    'PUT /api/image/images/image-created-1',
    'DELETE /api/image/images/image-created-1',
  ]);
});

test('the AI suggestion fills the edit dialog and saves through the normal update', async ({ page }, testInfo) => {
  queueExtract({ status: 200, body: { name: 'Proposed name', keywords: ['proposed', 'keywords'] } });
  await page.goto(await adminUrl('/image-assets'));
  await page.getByRole('button', { name: 'Images', exact: true }).click();
  await page.locator('table tbody tr', { hasText: 'Reference garden' }).getByRole('button', { name: 'Edit' }).click();
  const editDialog = page.getByRole('dialog');
  await editDialog.getByRole('button', { name: 'Suggest with AI', exact: true }).click();
  const nameField = editDialog.getByRole('textbox', { name: 'Name', exact: true });
  await expect(nameField).toHaveValue('Proposed name');
  await expect(editDialog.getByRole('textbox', { name: 'Keywords', exact: true })).toHaveValue('proposed, keywords');
  // The default run asks for the configured tool model and nothing else.
  expect(fakeExtractRequests()).toEqual([{}]);
  // The suggestion is a preview: no state-changing request left the page.
  expect(fakeWrites().filter((entry) => !entry.endsWith('/extract'))).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('image-assets-extract.png') });
  await testInfo.attach('image-assets-extract', {
    path: testInfo.outputPath('image-assets-extract.png'),
    contentType: 'image/png',
  });
  await editDialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(toast(page, 'Saved').last()).toBeVisible();
  await expect(page.locator('table tbody tr', { hasText: 'Proposed name' })).toBeVisible();
  expect(fakeUpdateRequests()).toEqual([{ name: 'Proposed name', keywords: 'proposed, keywords' }]);
});

test('a text-only tool model shows the hint, the settings link and the one-off model picker', async ({
  page,
}, testInfo) => {
  queueExtract({
    status: 409,
    body: {
      error: 'tool_model_no_image_input',
      message: 'The tool model agent/agent-model does not accept image input',
      models: [{ provider: 'vision', model: 'vision-model', name: 'Vision Model', thinking_levels: ['off', 'low'] }],
    },
  });
  queueExtract({ status: 200, body: { name: 'One-off result', keywords: ['via', 'vision'] } });
  await page.goto(await adminUrl('/image-assets'));
  await page.getByRole('button', { name: 'Images', exact: true }).click();
  await page.locator('table tbody tr', { hasText: 'Reference garden' }).getByRole('button', { name: 'Edit' }).click();
  const editDialog = page.getByRole('dialog');
  await editDialog.getByRole('button', { name: 'Suggest with AI', exact: true }).click();
  await expect(editDialog.getByText('The tool model cannot read images')).toBeVisible();
  const link = editDialog.getByRole('link', { name: 'Configure an image-capable tool model' });
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute('href', '/models');
  const modelPicker = editDialog.getByRole('combobox', { name: 'Model for this run' });
  await expect(modelPicker).toHaveValue('vision/vision-model');
  const thinkingPicker = editDialog.getByRole('combobox', { name: 'Thinking effort' });
  await expect(thinkingPicker).toHaveValue('off');
  await thinkingPicker.selectOption('low');
  await page.screenshot({ path: testInfo.outputPath('image-assets-extract-blocked.png') });
  await testInfo.attach('image-assets-extract-blocked', {
    path: testInfo.outputPath('image-assets-extract-blocked.png'),
    contentType: 'image/png',
  });
  await editDialog.getByRole('button', { name: 'Suggest with AI', exact: true }).click();
  await expect(editDialog.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('One-off result');
  await expect(editDialog.getByRole('textbox', { name: 'Keywords', exact: true })).toHaveValue('via, vision');
  // The retry carried exactly the chosen one-off model, and the choice never
  // persisted: no update left the page.
  expect(fakeExtractRequests()).toEqual([
    {},
    { model: { provider: 'vision', model: 'vision-model', thinking_level: 'low' } },
  ]);
  expect(fakeUpdateRequests()).toEqual([]);
  await editDialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('every opening is a fresh edit session with no leakage from the last one', async ({ page }) => {
  await page.goto(await adminUrl('/image-assets'));
  await page.getByRole('button', { name: 'Images', exact: true }).click();
  const seedRow = page.locator('table tbody tr', { hasText: 'Reference garden' });
  await page.locator('input[type="file"]').setInputFiles({
    name: 'second-asset.png',
    mimeType: 'image/png',
    buffer: fakePng(),
  });
  await expect(toast(page, 'Uploaded')).toBeVisible();
  const secondRow = page.locator('table tbody tr', { hasText: 'second-asset.png' });

  // Asset A's blocked tool model must not haunt asset B's dialog.
  queueExtract({
    status: 409,
    body: {
      error: 'tool_model_no_image_input',
      message: 'The tool model cannot read images',
      models: [],
    },
  });
  await seedRow.getByRole('button', { name: 'Edit' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Suggest with AI', exact: true }).click();
  await expect(dialog.getByText('The tool model cannot read images')).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  await secondRow.getByRole('button', { name: 'Edit' }).click();
  const fresh = page.getByRole('dialog');
  await expect(fresh.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('second-asset.png');
  await expect(fresh.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
  await expect(fresh.getByText('The tool model cannot read images')).toHaveCount(0);
  await expect(fresh.getByRole('combobox', { name: 'Model for this run' })).toHaveCount(0);
  await fresh.getByRole('button', { name: 'Cancel', exact: true }).click();

  // Cancelling a draft discards it, even when the same row reopens.
  await seedRow.getByRole('button', { name: 'Edit' }).click();
  const draftDialog = page.getByRole('dialog');
  await draftDialog.getByRole('textbox', { name: 'Name', exact: true }).fill('Discarded draft');
  await draftDialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await seedRow.getByRole('button', { name: 'Edit' }).click();
  const reopened = page.getByRole('dialog');
  await expect(reopened.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('Reference garden');
  await reopened.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(fakeUpdateRequests()).toEqual([]);
});
