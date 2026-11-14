import { writeFile } from 'node:fs/promises';
import { expect } from '@playwright/test';
import { adminUrl, test, toast, watchPageIssues } from './helpers.ts';
import {
  addOverallCommentOnDetail,
  assertNoPageIssues,
  REVIEW_STORAGE_KEY,
  readDownloadedText,
  seedExportFixtureDraft,
} from './review-helpers.ts';

test.use({ signedIn: true });

test.describe('invocation review export and clear', () => {
  test('exports Markdown + JSON with confirmation, saves repeatable artifact, handles clipboard copy/conflict/failure and manual clear', async ({
    page,
  }, testInfo) => {
    const finishWatching = watchPageIssues(page);

    await page.goto(await adminUrl('/reviews'));
    await seedExportFixtureDraft(page);

    const section4001 = page.getByRole('region', { name: /Invocation 4001/ });
    const section4002 = page.getByRole('region', { name: /Invocation 4002/ });
    await expect(section4001).toBeVisible();
    await expect(section4002).toBeVisible();

    // 5a. Set a goal, choose "Developer feedback". Click "Download Markdown", then Cancel in the dialog
    // -> no download event fires, the draft is still listed.
    await page.getByLabel('Goal').fill('Make replies shorter and handle timeouts gracefully.');
    await page.getByRole('radio', { name: 'Developer feedback', exact: true }).click();

    let unexpectedDownload = false;
    const onUnexpectedDownload = (): void => {
      unexpectedDownload = true;
    };
    page.on('download', onUnexpectedDownload);
    await page.getByRole('button', { name: 'Download Markdown', exact: true }).click();
    const exportDialog = page.getByRole('alertdialog');
    await expect(exportDialog).toBeVisible();
    await expect(exportDialog.getByText(/importing it back into the Admin Panel is not supported yet/)).toBeVisible();
    await exportDialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(exportDialog).toBeHidden();
    page.off('download', onUnexpectedDownload);
    expect(unexpectedDownload).toBe(false);
    await expect(section4001).toBeVisible();
    await expect(section4002).toBeVisible();

    // 5b. Click "Download Markdown", confirm -> assert filename pattern, Markdown content, trailing JSON block,
    // save artifact, and verify draft is cleared.
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download Markdown', exact: true }).click();
    await expect(exportDialog).toBeVisible();
    await exportDialog.getByRole('button', { name: 'Export and clear', exact: true }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/^surowan-review-\d{8}-\d{6}\.md$/);

    const markdown = await readDownloadedText(download);

    expect(markdown).toContain('# Surowan review notes');
    expect(markdown).toContain('### Invocation 4001');
    expect(markdown).toContain('### Invocation 4002');
    expect(markdown).toContain('call_send_001');
    expect(markdown).toContain('Reply was too verbose here.');
    expect(markdown).toContain('Overall 4001 updated in tab A.');
    expect(markdown).toContain('Provider timed out on first attempt.');
    expect(markdown).toContain('Added from tab B.');
    expect(markdown).toContain('Make replies shorter and handle timeouts gracefully.');
    expect(markdown).toContain(
      "Your job: help a Surowan developer find where Surowan's own design (the built-in system prompt, tool names, descriptions, schemas and result shapes, or runtime behavior) led the bot to the behavior the operator flagged.",
    );
    expect(markdown).toContain('surowan-utils doctor --json');
    expect(markdown).toContain('surowan_key_show');

    const jsonBlockMatch = markdown.match(/## Review data \(JSON\)[\s\S]*?(`{3,})json\n([\s\S]*?)\n\1\s*$/);
    expect(jsonBlockMatch).not.toBeNull();
    const parsedJson = JSON.parse(jsonBlockMatch?.[2] ?? '{}') as {
      format: string;
      version: number;
      purpose: string;
      goal: string;
      invocations: Array<{
        id: string;
        overall: string;
        comments: Array<{ ref: string; subject: string; attempt: number | null; label: string; text: string }>;
      }>;
    };
    expect(parsedJson.format).toBe('surowan.invocation-review');
    expect(parsedJson.version).toBe(1);
    expect(parsedJson.purpose).toBe('develop');
    expect(parsedJson.goal).toBe('Make replies shorter and handle timeouts gracefully.');
    expect(parsedJson.invocations.map((inv) => inv.id)).toEqual(['4001', '4002']);
    expect(parsedJson.invocations[0]?.overall).toBe('Overall 4001 updated in tab A.');
    expect(parsedJson.invocations[0]?.comments.map((c) => c.ref)).toContain('call_send_001');
    expect(parsedJson.invocations[0]?.comments.map((c) => c.subject)).toContain('send');
    expect(parsedJson.invocations[0]?.comments.map((c) => c.text)).toContain('Reply was too verbose here.');
    expect(parsedJson.invocations[1]?.comments.map((c) => c.text)).toEqual([
      'Provider timed out on first attempt.',
      'Added from tab B.',
    ]);

    const artifactPath = testInfo.outputPath('surowan-review-export.md');
    await writeFile(artifactPath, markdown, 'utf8');
    await testInfo.attach('surowan-review-export.md', {
      path: artifactPath,
      contentType: 'text/markdown;charset=utf-8',
    });
    console.log(`Saved review export artifact: ${artifactPath}`);

    await expect(toast(page, 'Exported; review draft cleared')).toBeVisible();
    await expect(page.getByText('No review comments yet')).toBeVisible();
    await page.reload();
    await expect(page.getByText('No review comments yet')).toBeVisible();

    // 6a. Clipboard failure: re-create comments, stub navigator.clipboard.writeText to reject,
    // Copy -> confirm -> error toast, draft still present.
    await page.goto(await adminUrl('/invocations/4001'));
    await addOverallCommentOnDetail(page, 'Comment for clipboard test.');
    await page.getByRole('link', { name: 'Open review draft', exact: true }).click();
    await expect(page).toHaveURL(/\/reviews$/);
    await expect(page.getByText('Comment for clipboard test.')).toBeVisible();

    await page.evaluate(() => {
      const originalClipboard = navigator.clipboard;
      (window as unknown as { __origClipboard?: Clipboard }).__origClipboard = originalClipboard;
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: () => Promise.reject(new Error('Clipboard write blocked')),
        },
      });
    });

    await page.getByRole('button', { name: 'Copy Markdown', exact: true }).click();
    await expect(exportDialog).toBeVisible();
    await exportDialog.getByRole('button', { name: 'Export and clear', exact: true }).click();
    await expect(toast(page, 'Failed to copy Markdown to clipboard')).toBeVisible();
    await expect(page.getByText('Comment for clipboard test.')).toBeVisible();

    // Concurrent draft change during clipboard write (#2): resolves writeText after mutating storage -> keeps draft and warns
    await page.evaluate((storageKey) => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async () => {
            const raw = localStorage.getItem(storageKey);
            if (raw !== null) {
              const parsed = JSON.parse(raw) as { state: { goal: string } };
              parsed.state.goal = 'Concurrent edit from another tab during copy';
              localStorage.setItem(storageKey, JSON.stringify(parsed));
            }
          },
        },
      });
    }, REVIEW_STORAGE_KEY);
    await page.getByRole('button', { name: 'Copy Markdown', exact: true }).click();
    await expect(exportDialog).toBeVisible();
    await exportDialog.getByRole('button', { name: 'Export and clear', exact: true }).click();
    await expect(toast(page, 'Copied, but the draft changed during export, so it was not cleared')).toBeVisible();
    await expect(page.getByText('Comment for clipboard test.')).toBeVisible();

    // 6b. Clipboard success: grant clipboard permissions, Copy -> confirm -> clipboard text starts with
    // `# Surowan review notes` and contains the JSON block; draft cleared.
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.evaluate(() => {
      const originalClipboard = (window as unknown as { __origClipboard?: Clipboard }).__origClipboard;
      if (originalClipboard !== undefined) {
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: originalClipboard,
        });
      }
    });

    await page.getByRole('button', { name: 'Copy Markdown', exact: true }).click();
    await expect(exportDialog).toBeVisible();
    await exportDialog.getByRole('button', { name: 'Export and clear', exact: true }).click();
    await expect(toast(page, 'Exported; review draft cleared')).toBeVisible();
    await expect(page.getByText('No review comments yet')).toBeVisible();
    const copiedText = await page.evaluate(() => navigator.clipboard.readText());
    expect(copiedText.startsWith('# Surowan review notes')).toBe(true);
    expect(copiedText).toContain('Comment for clipboard test.');
    expect(copiedText).toContain('## Review data (JSON)');
    expect(copiedText).toContain('"format": "surowan.invocation-review"');

    // 8. Clear draft via the confirm dialog -> empty state; reload -> still empty.
    await page.goto(await adminUrl('/invocations/4002'));
    await addOverallCommentOnDetail(page, 'Draft to be cleared manually.');
    await page.getByRole('link', { name: 'Open review draft', exact: true }).click();
    await expect(page.getByText('Draft to be cleared manually.')).toBeVisible();

    await page.getByRole('button', { name: 'Clear draft', exact: true }).click();
    const clearDialog = page.getByRole('alertdialog');
    await expect(clearDialog).toBeVisible();
    await clearDialog.getByRole('button', { name: 'Clear draft', exact: true }).click();
    await expect(toast(page, 'Review draft cleared')).toBeVisible();
    await expect(page.getByText('No review comments yet')).toBeVisible();
    await page.reload();
    await expect(page.getByText('No review comments yet')).toBeVisible();

    assertNoPageIssues(finishWatching);
  });
});
