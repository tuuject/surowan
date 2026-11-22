/**
 * Writes one screenshot into a per-run staging directory and keeps the page
 * still while it happens.
 *
 * A capture never invents data: the spec reaches the state by really clicking,
 * typing and saving, asserts the target state through the API or the rendered
 * text, and only then calls this helper. What the helper owns is the part that
 * must not wobble between runs: fonts, toasts, animations, the caret and the
 * scroll position.
 *
 * Captures go to `apps/admin-next/.docs-shots-staging/` (gitignored), never to
 * the docs tree: only a complete run that passes `checkScreenshotAssets` is
 * published there by `manifest.ts`. A failed or focused run therefore leaves
 * the committed images untouched.
 */
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { expect, type Locator, type Page } from '@playwright/test';
import type { DocsLocale } from '../e2e/docs-locale.ts';
import { docsScenario } from './scenarios.ts';

/** `apps/docs/content/public/screenshots`, shared by both locales: published output. */
export const SCREENSHOTS_DIR = join(import.meta.dirname, '..', '..', 'docs', 'content', 'public', 'screenshots');

/** Where one run writes before anything is published (gitignored). */
export const SCREENSHOTS_STAGING_DIR = join(import.meta.dirname, '..', '.docs-shots-staging');

/**
 * Koi animates dialogs, toasts and cards; a screenshot taken mid-transition
 * would differ between runs. Reduced motion already covers most of it (the
 * projects set `reducedMotion: 'reduce'`); this makes it unconditional and
 * removes the text caret, which blinks independently of every other timer.
 */
const STILL_CSS = `
  *, *::before, *::after {
    animation: none !important;
    transition: none !important;
    caret-color: transparent !important;
    scroll-behavior: auto !important;
  }
`;

const STILL_STYLE_ID = 'docs-screenshot-still';

/** Breathing room around an element shot, in CSS pixels. */
const ELEMENT_PADDING = 16;

/** The fixed app header (52 px) plus its air, so a start-aligned card sits below it. */
const APP_HEADER_CLEARANCE = 76;

/** `viewport` for a page shot, `page` for a full-page one, or the element itself. */
export type CaptureTarget = 'viewport' | 'page' | Locator;

export interface CaptureOptions {
  /**
   * A viewport shot starts at the top of the page; when the documented state is
   * further down (a second card on a long page), name the element to bring into
   * view instead. The capture expands it by a small margin.
   */
  readonly scrollTo?: Locator;
  /**
   * `nearest` (the default) scrolls just enough to show the target, keeping the
   * content above it in view. `start` pins it under the app header: for a page
   * whose upper half must stay out of the crop (a fixture port shown in a form).
   */
  readonly align?: 'nearest' | 'start';
}

/** `(id, locale)` pairs captured in this worker: a second write is a bug. */
const captured = new Set<string>();

async function settle(page: Page): Promise<void> {
  await page.evaluate(
    async ({ styleId, css }) => {
      await document.fonts.ready;
      if (document.getElementById(styleId) === null) {
        const style = document.createElement('style');
        style.id = styleId;
        style.textContent = css;
        document.head.append(style);
      }
    },
    { styleId: STILL_STYLE_ID, css: STILL_CSS },
  );
  // A toast is transient page state, never part of the documented state.
  await expect(page.locator('[data-koi-toast]')).toHaveCount(0);
  // The router's error boundary is a bug, not a screenshot.
  await expect(page.locator('[data-route-error]')).toHaveCount(0);
}

/**
 * Captures `id` for `locale` as `<staging>/<id>.<locale>.light.png` and returns
 * the absolute path. `target` defaults to the viewport: the docs prefer a
 * readable card or page over a long full-page shot.
 */
export async function captureScreenshot(
  page: Page,
  locale: DocsLocale,
  id: string,
  target: CaptureTarget = 'viewport',
  options: CaptureOptions = {},
): Promise<string> {
  // An unknown id would produce a file no scenario and no doc page can name.
  docsScenario(id);
  const key = `${id}.${locale}`;
  if (captured.has(key)) {
    throw new Error(`Screenshot ${key} was already captured in this worker; give the second state its own scenario id`);
  }
  captured.add(key);

  await settle(page);
  if (options.scrollTo === undefined) {
    await page.evaluate(() => window.scrollTo(0, 0));
  } else if (options.align === 'start') {
    await options.scrollTo.evaluate((node, clearance) => {
      const top = node.getBoundingClientRect().top + window.scrollY - clearance;
      window.scrollTo(0, Math.max(0, top));
    }, APP_HEADER_CLEARANCE);
  } else {
    await options.scrollTo.scrollIntoViewIfNeeded();
  }
  if (options.scrollTo !== undefined) {
    const viewport = page.viewportSize();
    const box = await options.scrollTo.boundingBox();
    if (viewport === null || box === null) {
      throw new Error(`Cannot capture ${key}: the scroll target has no box`);
    }
    if (box.y - ELEMENT_PADDING < 0 || box.y + box.height + ELEMENT_PADDING > viewport.height) {
      throw new Error(
        `Cannot capture ${key}: the scroll target (${String(Math.round(box.height))}px) does not fit the ` +
          `${String(viewport.width)}×${String(viewport.height)} viewport with ${String(ELEMENT_PADDING)}px padding; ` +
          'capture the element itself or split the scenario',
      );
    }
  }

  const path = join(SCREENSHOTS_STAGING_DIR, `${id}.${locale}.light.png`);
  await mkdir(dirname(path), { recursive: true });
  if (target === 'viewport') {
    await page.screenshot({ path, animations: 'disabled' });
  } else if (target === 'page') {
    await page.screenshot({ path, animations: 'disabled', fullPage: true });
  } else {
    await target.scrollIntoViewIfNeeded();
    const box = await target.boundingBox();
    if (box === null) {
      throw new Error(`Cannot capture ${key}: the target element has no box`);
    }
    // A plain panel section draws right up to its box, so a tight element shot
    // would start and end on a glyph or an icon. The clip is the box plus a
    // small white margin from the page itself, never a drawn frame.
    await page.screenshot({
      path,
      animations: 'disabled',
      clip: {
        x: box.x - ELEMENT_PADDING,
        y: box.y - ELEMENT_PADDING,
        width: box.width + ELEMENT_PADDING * 2,
        height: box.height + ELEMENT_PADDING * 2,
      },
    });
  }
  return path;
}
