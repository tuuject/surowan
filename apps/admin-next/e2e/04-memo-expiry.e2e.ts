import { expect } from '@playwright/test';
import type { MemoryEntry } from '../src/lib/api/memories.ts';
import { adminUrl, e2eFetch, test, toast } from './helpers.ts';

test.use({ signedIn: true });

for (const scenario of ['sub-day', 'expired', 'same-days', 'permanent'] as const) {
  test(`text-only memo edits preserve exact expiry: ${scenario}`, async ({ page }) => {
    const url = await adminUrl('/api/memories');
    const headers = { Origin: new URL(url).origin };
    const chats = await page.request.get(await adminUrl('/api/memories/chats'));
    const { items } = (await chats.json()) as { items: { telegram_chat_id: string }[] };
    expect(items.length).toBeGreaterThan(0);
    const summary = `TTL preservation ${scenario}`;
    const response = await page.request.post(url, {
      headers,
      data: {
        chat_id: items[0]?.telegram_chat_id,
        summary,
        detail: 'Original detail',
        ...(scenario === 'permanent' ? {} : { ttl_seconds: scenario === 'same-days' ? 604_800 : 3_600 }),
      },
    });
    expect(response.ok()).toBeTruthy();
    const entry = (await response.json()) as MemoryEntry;
    let expiresAt = entry.expires_at;
    if (scenario === 'expired') {
      const expired = await e2eFetch<{ updated: number; expires_at: string }>(`/expire-memo?id=${entry.id}`, {
        method: 'POST',
      });
      expect(expired.updated).toBe(1);
      expiresAt = expired.expires_at;
    }
    try {
      await page.goto(await adminUrl('/memories'));
      const loadMore = page.getByRole('button', { name: 'Load more' });
      await expect(page.locator('table tbody tr').first()).toBeVisible();
      while (await loadMore.isVisible()) {
        const count = await page.locator('table tbody tr').count();
        await loadMore.click();
        await expect.poll(() => page.locator('table tbody tr').count()).toBeGreaterThan(count);
      }
      await page.locator('table tbody tr', { hasText: summary }).getByRole('button', { name: 'Edit' }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByLabel('Summary').fill(`${summary} edited`);
      await dialog.getByLabel('Detail').fill('Edited detail');
      if (scenario === 'same-days') {
        await dialog.getByLabel('TTL in days').fill('07');
      }
      const updateRequest = page.waitForRequest(
        (request) => request.method() === 'PUT' && request.url().endsWith(`/memories/${entry.id}`),
      );
      await dialog.getByRole('button', { name: 'Save', exact: true }).click();
      expect((await updateRequest).postDataJSON()).not.toHaveProperty('ttl_seconds');
      await expect(toast(page, 'Memo updated')).toBeVisible();
      const list = await page.request.get(await adminUrl('/api/memories?limit=100'));
      const body = (await list.json()) as { items: MemoryEntry[] };
      const updated = body.items.find((item) => item.id === entry.id);
      expect(updated).toMatchObject({
        summary: `${summary} edited`,
        detail: 'Edited detail',
        expires_at: expiresAt,
        expired: scenario === 'expired',
      });
      await expect(page.locator('table tbody tr', { hasText: `${summary} edited` })).toBeVisible();
    } finally {
      await page.request.delete(`${url}/${entry.id}`, { headers });
    }
  });
}
