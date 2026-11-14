import {
  ARTIFACT_DIR,
  expect,
  expectNoOverflow,
  LANGUAGES,
  openRoute,
  ROUTES,
  screenshot,
  seedLanguage,
  test,
  VIEWPORTS,
} from './i18n-stress-helpers.ts';

/**
 * Overflow matrix: every representative route in German and Arabic at desktop,
 * tablet and phone width. Checks that the page never scrolls sideways and that
 * no control paints its own text outside its box, and writes the reviewable
 * full-page screenshots.
 */

test.use({ signedIn: true });

for (const language of LANGUAGES) {
  for (const viewport of VIEWPORTS) {
    test(`layout stress ${language} at ${viewport.name}`, async ({ page }) => {
      test.setTimeout(180_000);
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await seedLanguage(page, language);
      for (const route of ROUTES) {
        await openRoute(page, route.path);
        await expectNoOverflow(page, `${language} ${viewport.name} ${route.path}`);
        // The language actually applied (a stored value the app ignores would
        // make every later assertion meaningless).
        await expect(page.locator('html')).toHaveAttribute('lang', language);
        await screenshot(page, language, viewport.name, route.slug);
      }
      console.log(`i18n-stress screenshots: ${ARTIFACT_DIR}`);
    });
  }
}
