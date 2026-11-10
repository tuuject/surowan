import { expect, type Locator, type Page } from '@playwright/test';
import { createEntry, draft } from './dictionary-fixture.ts';
import { adminUrl, test } from './helpers.ts';
import { E2E_RELAY_ALIAS, E2E_RELAY_MANUAL_MODEL } from './models-fixture.ts';

/**
 * Modal lifecycle acceptance: every Admin overlay must reach the browser as a
 * mounted, controlled Dialog, so Base UI plays both the entry and the exit
 * transition and the title stays visible while the popup fades out.
 *
 * The probe listens for real `transitionrun` events on the popup instead of
 * trusting the computed `transition-duration`: the CSS is always 300ms, and a
 * conditionally mounted dialog silently skips the events altogether.
 */
test.use({ signedIn: true });

interface ModalAudit {
  enter: number;
  exit: number;
  exitLabel: string | null;
  exitText: string | null;
}

declare global {
  interface Window {
    modalAudit?: ModalAudit;
  }
}

const DISMISS = /^(Dismiss|Cancel)$/;

async function observeTransitions(page: Page): Promise<void> {
  await page.evaluate(() => {
    const audit: ModalAudit = { enter: 0, exit: 0, exitLabel: null, exitText: null };
    window.modalAudit = audit;
    const isPopup = (node: EventTarget | null): node is HTMLElement =>
      node instanceof HTMLElement &&
      (node.getAttribute('role') === 'dialog' || node.getAttribute('role') === 'alertdialog');
    document.addEventListener('transitionrun', (event) => {
      if (!isPopup(event.target)) {
        return;
      }
      if (event.target.hasAttribute('data-ending-style')) {
        audit.exit += 1;
      } else {
        audit.enter += 1;
      }
    });
    // Snapshot the header the moment the close starts: a title or body that the
    // same state change blanks would otherwise look fine by the time the popup
    // has finished fading. Stacked dialogs keep the outer one mounted, so scan
    // for whichever popup actually entered its closing phase.
    new MutationObserver(() => {
      if (audit.exitText !== null) {
        return;
      }
      const element = [...document.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"]')].find(
        (popup) => popup.hasAttribute('data-ending-style'),
      );
      if (element === undefined) {
        return;
      }
      audit.exitText = (element.textContent ?? '').trim();
      const labelledBy = element.getAttribute('aria-labelledby');
      audit.exitLabel = labelledBy === null ? null : (document.getElementById(labelledBy)?.textContent ?? '').trim();
    }).observe(document.body, { attributes: true, subtree: true, attributeFilter: ['data-ending-style'] });
  });
}

async function resetAudit(page: Page): Promise<void> {
  await page.evaluate(() => {
    const audit = window.modalAudit;
    if (audit !== undefined) {
      audit.enter = 0;
      audit.exit = 0;
      audit.exitLabel = null;
      audit.exitText = null;
    }
  });
}

async function readAudit(page: Page): Promise<ModalAudit | undefined> {
  return await page.evaluate(() => window.modalAudit);
}

/** Waits until every open popup has finished its entry animation. */
async function expectDialogsSettled(page: Page, name: string): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const popups = [...document.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"]')];
          return (
            popups.length > 0 &&
            popups.every(
              (popup) =>
                !popup.hasAttribute('data-starting-style') &&
                popup.getAnimations().every((animation) => animation.playState === 'finished'),
            )
          );
        }),
      { message: `${name}: entry transition settles` },
    )
    .toBe(true);
}

/** Opens through `open`, closes through the given control, and asserts both transitions plus the kept title. */
async function expectTransition(
  page: Page,
  name: string,
  open: () => Promise<void>,
  dialog: Locator,
  close: 'Escape' | RegExp = 'Escape',
): Promise<void> {
  await resetAudit(page);
  await open();
  await expect(dialog, `${name}: opens`).toBeVisible();
  await expect
    .poll(async () => (await readAudit(page))?.enter ?? 0, { message: `${name}: entry transition` })
    .toBeGreaterThan(0);
  // Base UI skips the exit phase when the close starts before the entry phase has
  // finished, so wait for the animation itself rather than the starting flag.
  await expectDialogsSettled(page, name);
  // What the admin is looking at when the close starts. "Still has some text"
  // would pass a title that lost its target ("Restore version ?") and a body
  // reduced to its footer buttons, so the exit snapshot must equal this.
  const shown = await dialog.evaluate((element) => {
    const labelledBy = element.getAttribute('aria-labelledby');
    return {
      label: labelledBy === null ? '' : (document.getElementById(labelledBy)?.textContent ?? '').trim(),
      text: (element.textContent ?? '').trim(),
    };
  });
  expect(shown.label, `${name}: has a title`).not.toBe('');
  if (close === 'Escape') {
    await page.keyboard.press('Escape');
  } else {
    await dialog.getByRole('button', { name: close }).first().click();
  }
  await expect(dialog, `${name}: closes`).toHaveCount(0);
  const audit = await readAudit(page);
  expect(audit?.exit ?? 0, `${name}: exit transition`).toBeGreaterThan(0);
  expect(audit?.exitLabel ?? '', `${name}: title kept through the exit`).toBe(shown.label);
  expect(audit?.exitText ?? '', `${name}: body kept through the exit`).toBe(shown.text);
}

test('providers dialogs keep their transitions', async ({ page }) => {
  await page.goto(await adminUrl('/providers'));
  await expect(page.getByRole('button', { name: 'New provider', exact: true })).toBeVisible();
  await observeTransitions(page);
  const dialog = page.getByRole('dialog');

  await expectTransition(
    page,
    'new provider',
    () => page.getByRole('button', { name: 'New provider', exact: true }).click(),
    dialog,
  );

  await page.getByRole('button', { name: `Provider ${E2E_RELAY_ALIAS}`, exact: true }).click();
  await expectTransition(
    page,
    'fetch models',
    () => page.getByRole('button', { name: 'Fetch models', exact: true }).click(),
    dialog,
  );
  await expectTransition(
    page,
    'add manually',
    () => page.getByRole('button', { name: 'Add manually', exact: true }).click(),
    dialog,
  );

  // The metadata confirmation stacks above the picker: both roots must survive.
  await page.getByRole('button', { name: 'Add manually', exact: true }).click();
  await expect(dialog).toBeVisible();
  await page.getByRole('textbox', { name: /Model IDs/ }).fill(E2E_RELAY_MANUAL_MODEL);
  // Reset after the picker settled so the numbers describe the nested dialog alone.
  await resetAudit(page);
  await page.getByRole('button', { name: 'Look up model details', exact: true }).click();
  const confirm = page.getByRole('dialog', { name: new RegExp(E2E_RELAY_MANUAL_MODEL) });
  await expect(confirm).toBeVisible();
  await expect
    .poll(async () => (await readAudit(page))?.enter ?? 0, { message: 'nested model confirm: entry transition' })
    .toBeGreaterThan(0);
  await expectDialogsSettled(page, 'nested model confirm');
  await page.keyboard.press('Escape');
  await expect(confirm).toHaveCount(0);
  const nestedClosed = await readAudit(page);
  expect(nestedClosed?.exit ?? 0, 'nested model confirm: exit transition').toBeGreaterThan(0);
  expect(nestedClosed?.exitLabel ?? '', 'nested model confirm: title kept').not.toBe('');
  // The counter already holds the confirm's exit, so the picker has to add its own.
  const exitsBeforePicker = nestedClosed?.exit ?? 0;
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  expect((await readAudit(page))?.exit ?? 0, 'picker exits after the confirm').toBeGreaterThan(exitsBeforePicker);
});

const GROUP_CHAT = '-100555000333';

test('chats dialogs keep their transitions and their copy', async ({ page }) => {
  await page.goto(await adminUrl('/chats'));
  await expect(page.getByRole('button', { name: 'Add Chat', exact: true })).toBeVisible();
  await page.evaluate(async (id) => {
    const view = await (await fetch('/api/chats')).json();
    const response = await fetch('/api/chats', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'if-match': view.revision },
      body: JSON.stringify({ id, topic_ids: null, provider: null, model: null, thinking_level: null }),
    });
    if (!response.ok) {
      throw new Error(`Adding the group Chat failed: ${response.status}`);
    }
  }, GROUP_CHAT);
  await page.reload();
  const row = page.locator('table tbody tr').filter({ hasText: GROUP_CHAT });
  await expect(row).toBeVisible();
  await observeTransitions(page);

  await expectTransition(
    page,
    'add Chat',
    () => page.getByRole('button', { name: 'Add Chat', exact: true }).click(),
    page.getByRole('dialog'),
  );
  await expectTransition(
    page,
    'edit Chat',
    () => row.getByRole('button', { name: 'Edit', exact: true }).click(),
    page.getByRole('dialog'),
  );

  for (const [label, item] of [
    ['active hours', 'Edit active hours'],
    ['proactive reply', 'Edit proactive reply chance'],
    ['group memory', 'Edit group memory'],
  ] as const) {
    await expectTransition(
      page,
      label,
      async () => {
        await row.getByRole('button', { name: 'More actions', exact: true }).click();
        await page.getByRole('menuitem', { name: item, exact: true }).click();
      },
      page.getByRole('dialog'),
    );
  }

  await expectTransition(
    page,
    'remove Chat',
    () => row.getByRole('button', { name: 'Remove', exact: true }).click(),
    page.getByRole('alertdialog'),
    DISMISS,
  );
});

test('api key dialogs keep their transitions', async ({ page }) => {
  const created = await page.request.post(await adminUrl('/api/api-keys'), {
    data: { name: 'modal-transition-key', mode: 'read' },
  });
  expect(created.ok()).toBe(true);
  await page.goto(await adminUrl('/api-keys'));
  await expect(page.getByRole('button', { name: 'Create API key', exact: true })).toBeVisible();
  await observeTransitions(page);

  await expectTransition(
    page,
    'create key',
    () => page.getByRole('button', { name: 'Create API key', exact: true }).click(),
    page.getByRole('dialog'),
  );
  await expectTransition(
    page,
    'change key mode',
    () => page.getByRole('button', { name: 'Change mode', exact: true }).click(),
    page.getByRole('dialog'),
  );
  await expectTransition(
    page,
    'rotate key',
    () => page.getByRole('button', { name: 'Rotate', exact: true }).click(),
    page.getByRole('alertdialog').or(page.getByRole('dialog')),
    DISMISS,
  );
  await expectTransition(
    page,
    'revoke key',
    () => page.getByRole('button', { name: 'Revoke', exact: true }).click(),
    page.getByRole('alertdialog'),
    DISMISS,
  );
});

test('dictionary dialogs keep their transitions and their copy', async ({ page }) => {
  const first = await createEntry(page, draft('modal-transition-one'));
  await createEntry(page, draft('modal-transition-two'));
  await page.goto(await adminUrl('/dictionary'));
  await expect(page.getByRole('button', { name: 'New entry', exact: true })).toBeVisible();
  await observeTransitions(page);
  const dialog = page.getByRole('dialog');

  await expectTransition(
    page,
    'new entry',
    () => page.getByRole('button', { name: 'New entry', exact: true }).click(),
    dialog,
  );
  await expectTransition(
    page,
    'edit entry',
    () => page.getByRole('button', { name: `Edit ${first.term}`, exact: true }).click(),
    dialog,
  );
  await expectTransition(
    page,
    'delete entry',
    () => page.getByRole('button', { name: `Delete ${first.term}`, exact: true }).click(),
    page.getByRole('alertdialog'),
    DISMISS,
  );
  await expectTransition(
    page,
    'import entries',
    () => page.getByRole('button', { name: 'Import', exact: true }).click(),
    dialog,
  );
  await expectTransition(
    page,
    'export entries',
    () => page.getByRole('button', { name: 'Export', exact: true }).click(),
    dialog,
  );
  await page.getByRole('checkbox', { name: `Select ${first.term}`, exact: true }).check();
  await page.getByRole('checkbox', { name: 'Select modal-transition-two', exact: true }).check();
  await expectTransition(
    page,
    'merge entries',
    () => page.getByRole('button', { name: 'Merge selected (2)', exact: true }).click(),
    dialog,
  );
});

test('search, admin and playground dialogs keep their transitions', async ({ page }) => {
  await page.goto(await adminUrl('/search-settings'));
  await expect(page.getByRole('button', { name: 'Add engine', exact: true })).toBeVisible();
  await observeTransitions(page);
  await expectTransition(
    page,
    'add engine',
    () => page.getByRole('button', { name: 'Add engine', exact: true }).click(),
    page.getByRole('dialog'),
    DISMISS,
  );

  await page.goto(await adminUrl('/admins'));
  await expect(page.getByRole('button', { name: 'Add bot admin', exact: true })).toBeVisible();
  await observeTransitions(page);
  await expectTransition(
    page,
    'add bot admin',
    () => page.getByRole('button', { name: 'Add bot admin', exact: true }).click(),
    page.getByRole('dialog'),
  );

  await page.goto(await adminUrl('/playground'));
  await expect(page.getByRole('button', { name: 'New room', exact: true })).toBeVisible();
  await observeTransitions(page);
  await expectTransition(
    page,
    'new room',
    () => page.getByRole('button', { name: 'New room', exact: true }).click(),
    page.getByRole('dialog'),
  );
});

test('the prompt restore confirmation keeps its version number', async ({ page }) => {
  await page.goto(await adminUrl('/prompts'));
  const editor = page.getByRole('textbox', { name: 'Prompt', exact: true });
  await expect(editor).toHaveText('Participate safely.');
  await editor.fill('Participate warmly and concisely.');
  await page.locator('#prompt-note').fill('modal transition probe');
  await page.getByRole('button', { name: 'Save and apply' }).click();
  await expect(page.locator('table tbody tr')).toHaveCount(2);
  await observeTransitions(page);

  await expectTransition(
    page,
    'restore prompt version',
    () => page.locator('table tbody tr', { hasText: 'v1' }).getByRole('button', { name: 'Restore' }).click(),
    page.getByRole('alertdialog'),
    DISMISS,
  );
});
