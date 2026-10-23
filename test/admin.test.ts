/**
 * Admin panel static serving: SPA fallback and traversal refusal.
 */
import { expect, test } from 'vitest';
import { fixture, request } from './admin-fixtures.ts';

test('admin static serving falls back to index.html and refuses traversal', async () => {
  const { store, server } = await fixture();
  try {
    const index = await server.handle(request('/'));
    expect(index.status).toBe(200);
    expect(index.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(index.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(await index.text()).toContain('<title>admin</title>');

    const deepRoute = await server.handle(request('/invocations/42'));
    expect(deepRoute.status).toBe(200);
    expect(await deepRoute.text()).toContain('<title>admin</title>');

    const script = await server.handle(request('/static/app.js'));
    expect(script.headers.get('content-type')).toBe('text/javascript; charset=utf-8');

    const traversal = await server.handle(request('/../../config.jsonc'));
    expect(traversal.status).toBe(200);
    expect(await traversal.text()).not.toContain('telegram-secret');
  } finally {
    store.close();
  }
});
