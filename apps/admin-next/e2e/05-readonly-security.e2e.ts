import { expect } from '@playwright/test';
import { adminUrl, test } from './helpers.ts';

/**
 * The production security posture, exercised against the real static hosting
 * (not the Rsbuild dev server): the CSP header must be present and the model
 * catalog must expose only usable metadata. The read-only, same-origin and
 * error-free browsing guarantees are asserted on every route in 01-routes.
 */
test.use({ signedIn: true });

test('the active replay model catalog exposes only usable model metadata to the authenticated session', async ({
  request,
}) => {
  const response = await request.get(await adminUrl('/api/models'));
  expect(response.status()).toBe(200);
  const catalog = await response.json();
  expect(catalog.source).toBe('active');
  expect(Number.isSafeInteger(catalog.generation)).toBe(true);
  expect(catalog.models.length).toBeGreaterThan(0);
  for (const model of catalog.models) {
    expect(Object.keys(model).sort()).toEqual([
      'context_window',
      'input',
      'max_tokens',
      'model',
      'name',
      'provider',
      'reasoning',
      'thinking_levels',
    ]);
    expect(model.input).toContain('text');
    expect(model.thinking_levels.length).toBeGreaterThan(0);
  }
  const serialized = JSON.stringify(catalog);
  for (const secret of ['telegram-secret', 'agent-secret', 'vision-secret']) {
    expect(serialized).not.toContain(secret);
  }
});

test('the production bundle is served with the strict CSP header', async ({ request }) => {
  const index = await request.get(await adminUrl('/'));
  expect(index.status()).toBe(200);
  const csp = index.headers()['content-security-policy'] ?? '';
  expect(csp).toContain("default-src 'none'");
  expect(csp).toContain("script-src 'self'");
  expect(csp).toContain("connect-src 'self'");
  expect(index.headers()['x-frame-options']).toBe('DENY');
  expect(index.headers()['x-content-type-options']).toBe('nosniff');
});
