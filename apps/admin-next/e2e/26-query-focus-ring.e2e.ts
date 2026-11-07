import { expect, type Locator } from '@playwright/test';
import { adminUrl, test } from './helpers.ts';

test.use({ signedIn: true });

/**
 * The query grid is flush with the collapsible content box on desktop. The
 * panel must stop clipping once its height transition settles, otherwise the
 * focus ring's outward 1px is cut flat on the left, right and bottom edges.
 */
async function expectFocusRingInsideClippingAncestors(control: Locator): Promise<void> {
  await control.focus();
  await expect(control).toBeFocused();
  // The Koi root animates box-shadow over 150ms; measure the settled ring, not
  // the first frame where the spread is still 0px.
  await control.evaluate(async (element) => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const root = element.closest<HTMLElement>('.koi-input__root, .koi-select__root');
    if (root === null) {
      return;
    }
    await Promise.all(
      root.getAnimations({ subtree: true }).map((animation) => animation.finished.catch(() => undefined)),
    );
  });

  const ring = await control.evaluate((element) => {
    const root = element.closest<HTMLElement>('.koi-input__root, .koi-select__root');
    if (root === null) {
      throw new Error('focused query control has no Koi input/select root');
    }
    const style = getComputedStyle(root);
    if (style.boxShadow === 'none' || style.boxShadow.includes('inset')) {
      throw new Error(`focused query control has no outward focus ring: ${style.boxShadow}`);
    }
    const lengths = Array.from(style.boxShadow.matchAll(/(-?\d+(?:\.\d+)?)px/g), (match) => Number(match[1]));
    const offsetX = lengths[0];
    const offsetY = lengths[1];
    const blur = lengths[2];
    const spread = lengths[3];
    if (offsetX === undefined || offsetY === undefined || blur === undefined || spread === undefined) {
      throw new Error(`could not parse focus ring: ${style.boxShadow}`);
    }
    const outwardX = Math.abs(offsetX) + Math.abs(blur) / 2 + Math.max(spread, 0);
    const outwardY = Math.abs(offsetY) + Math.abs(blur) / 2 + Math.max(spread, 0);
    const rect = root.getBoundingClientRect();
    const ringBox = {
      left: rect.left - outwardX,
      top: rect.top - outwardY,
      right: rect.right + outwardX,
      bottom: rect.bottom + outwardY,
    };

    const clips: Array<{ label: string; left: number; top: number; right: number; bottom: number }> = [];
    let ancestor = root.parentElement;
    while (ancestor !== null && ancestor !== document.body) {
      const ancestorStyle = getComputedStyle(ancestor);
      if (ancestorStyle.overflowX !== 'visible' || ancestorStyle.overflowY !== 'visible') {
        const ancestorRect = ancestor.getBoundingClientRect();
        const left = ancestorRect.left + ancestor.clientLeft;
        const top = ancestorRect.top + ancestor.clientTop;
        clips.push({
          label: `${ancestor.tagName.toLowerCase()}.${ancestor.className}`,
          left,
          top,
          right: left + ancestor.clientWidth,
          bottom: top + ancestor.clientHeight,
        });
      }
      ancestor = ancestor.parentElement;
    }
    return { ringBox, clips };
  });

  for (const clip of ring.clips) {
    expect(ring.ringBox.left, `${clip.label} clips the focus ring on the left`).toBeGreaterThanOrEqual(
      clip.left - 0.01,
    );
    expect(ring.ringBox.top, `${clip.label} clips the focus ring on top`).toBeGreaterThanOrEqual(clip.top - 0.01);
    expect(ring.ringBox.right, `${clip.label} clips the focus ring on the right`).toBeLessThanOrEqual(
      clip.right + 0.01,
    );
    expect(ring.ringBox.bottom, `${clip.label} clips the focus ring at the bottom`).toBeLessThanOrEqual(
      clip.bottom + 0.01,
    );
  }
}

async function waitForPanelMotionToSettle(panel: Locator): Promise<void> {
  await expect(panel).toBeVisible();
  await expect.poll(async () => panel.evaluate((element) => element.hasAttribute('data-starting-style'))).toBe(false);
  await expect.poll(async () => panel.evaluate((element) => element.hasAttribute('data-ending-style'))).toBe(false);
}

test('desktop query Input and Select keep their full focus ring inside the open filters panel', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(await adminUrl('/invocations'));
  await expect(page.locator('h1').first()).toBeVisible();

  const card = page.locator('[data-list-filter]').first();
  await expect(card).toBeVisible();
  const panel = card.locator('[data-open]').first();
  await waitForPanelMotionToSettle(panel);

  await expectFocusRingInsideClippingAncestors(card.getByLabel('Model', { exact: true }));
  await expectFocusRingInsideClippingAncestors(card.getByLabel('State', { exact: true }));
});

test('mobile collapsed filters hide their controls and an expanded Input keeps its full focus ring', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(await adminUrl('/messages'));
  await expect(page.locator('h1').first()).toBeVisible();

  const card = page.locator('[data-list-filter]').first();
  const trigger = card.getByRole('button', { name: /^Filters/ });
  const input = card.getByLabel('Search text or caption', { exact: true });
  await expect(input).toBeHidden();

  await trigger.click();
  const panel = card.locator('[data-open]').first();
  await waitForPanelMotionToSettle(panel);
  await expect(input).toBeVisible();
  await expectFocusRingInsideClippingAncestors(input);

  await trigger.click();
  await expect(input).toBeHidden();
});
