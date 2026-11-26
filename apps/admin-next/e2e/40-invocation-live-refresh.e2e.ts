import { expect, type Page } from '@playwright/test';
import { adminUrl, e2eFetch, nextPage, previousPage, tableBodyRows, test } from './helpers.ts';

/**
 * Live refresh of the Invocation pages. The server pushes a change event when
 * the audit rows it shows move; the page refetches its ordinary query, so the
 * tab the reader picked, the row they expanded and the rows already on screen
 * all survive the update. Turning Auto refresh off must freeze the page — no
 * stream, no polling — until the reader reloads by hand.
 */
test.use({ signedIn: true });

const AUTO_REFRESH = { name: 'Auto refresh', exact: true } as const;
const AUTO_SCROLL = { name: 'Auto scroll to bottom', exact: true } as const;

function switchOn(page: Page) {
  return page.getByRole('switch', AUTO_REFRESH);
}

function appendToolCall(id: string): Promise<{ tool_call_id: string }> {
  return e2eFetch<{ tool_call_id: string }>(`/append-tool-call?id=${id}`, { method: 'POST' });
}

/**
 * Records the API paths this page requests from now on. An "off" window asserts
 * against it: a stream or a fallback poll left running after the switch is
 * turned off would show up as a request the reader never asked for.
 */
function recordApiPaths(page: Page): { readonly paths: string[] } {
  const paths: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/')) {
      paths.push(`${url.pathname}${url.search}`);
    }
  });
  return { paths };
}

/** How far the end of the page is below the viewport's bottom edge (`html` is the scroller). */
function distanceFromBottom(page: Page): Promise<number> {
  return page.evaluate(() => {
    const root = document.documentElement;
    return root.scrollHeight - root.scrollTop - root.clientHeight;
  });
}

function scrollTop(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollTop);
}

async function scrollToTop(page: Page): Promise<void> {
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await expect.poll(() => scrollTop(page)).toBe(0);
}

/** The running fixture Invocation this spec drives; created by `/running-invocation`. */
async function runningInvocation(): Promise<string> {
  const created = await e2eFetch<{ id: string }>('/running-invocation', { method: 'POST' });
  return created.id;
}

test('a watched run grows in place: new tool calls appear, the tab and the expanded row stay put', async ({
  page,
}, testInfo) => {
  const id = await runningInvocation();
  const first = await appendToolCall(id);
  await page.goto(await adminUrl(`/invocations/${id}`));

  const refresh = switchOn(page);
  await expect(refresh).toBeChecked();

  await page.getByRole('tab', { name: 'Tool calls (1)' }).click();
  const tools = page.getByRole('tabpanel', { name: 'Tool calls (1)' });
  await expect(tools.getByText(first.tool_call_id)).toBeVisible();
  // Expanding a row must survive every refetch: the reader opened it to read
  // it, and an event arriving a moment later is not a reason to close it.
  await tools.getByRole('button', { name: 'Toggle row details' }).first().click();
  await expect(tools.getByText('Result').first()).toBeVisible();

  const second = await appendToolCall(id);
  // The tab label carries the count, so an increment proves the page re-read
  // the Invocation rather than showing a cached transcript.
  await expect(page.getByRole('tab', { name: 'Tool calls (2)' })).toBeVisible({ timeout: 10_000 });
  const selected = page.getByRole('tab', { name: 'Tool calls (2)' });
  await expect(selected).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tabpanel', { name: 'Tool calls (2)' }).getByText(second.tool_call_id)).toBeVisible();
  await expect(page.getByRole('tabpanel', { name: 'Tool calls (2)' }).getByText('Result').first()).toBeVisible();

  const shot = testInfo.outputPath('detail-live.png');
  await page.screenshot({ path: shot, fullPage: true });
  await testInfo.attach('detail-live', { path: shot, contentType: 'image/png' });

  // The run ends: the state badge follows the row, not the page title.
  await e2eFetch(`/running-invocation/finish?id=${id}`, { method: 'POST' });
  await expect(page.getByText('Completed', { exact: true }).first()).toBeVisible({ timeout: 10_000 });
});

test('one failed background refetch keeps the page and its data, and the next event recovers it', async ({ page }) => {
  const id = await runningInvocation();
  await appendToolCall(id);
  await page.goto(await adminUrl(`/invocations/${id}`));
  await expect(page.getByRole('tab', { name: 'Tool calls (1)' })).toBeVisible();

  // The panel retries nothing, so a deploy or a restart can fail a single live
  // refetch. That must not replace a page the reader is watching with an error
  // state, and it must not stop watching.
  const detailPath = `/api/invocations/${id}`;
  let failures = 0;
  await page.route(`**${detailPath}`, async (route) => {
    if (failures === 0 && route.request().method() === 'GET') {
      failures += 1;
      await route.fulfill({ status: 502, json: { error: 'internal', message: 'Synthetic detail failure' } });
      return;
    }
    await route.fallback();
  });

  await appendToolCall(id);
  await expect.poll(() => failures).toBe(1);
  // The page keeps the run it is showing: no error view, and the tab it was
  // on is still there with its old count.
  await expect(page.getByText('Synthetic detail failure')).toHaveCount(0);
  await expect(page.locator('[data-route-error]')).toHaveCount(0);
  await page.waitForTimeout(1_000);
  await expect(page.getByRole('tab', { name: 'Tool calls (1)' })).toBeVisible();

  // The next event recovers it: the stream was never closed, so the new row
  // arrives without a reload.
  const recovered = await appendToolCall(id);
  const tools = page.getByRole('tab', { name: 'Tool calls (3)' });
  await expect(tools).toBeVisible({ timeout: 15_000 });
  await tools.click();
  await expect(page.getByRole('tabpanel', { name: 'Tool calls (3)' }).getByText(recovered.tool_call_id)).toBeVisible();
  await e2eFetch(`/running-invocation/finish?id=${id}`, { method: 'POST' });
});

test('Auto refresh off freezes the page, survives a reload, and the switch turns it back on', async ({ page }) => {
  const id = await runningInvocation();
  await appendToolCall(id);
  await page.goto(await adminUrl(`/invocations/${id}`));

  await page.getByRole('tab', { name: 'Tool calls (1)' }).click();
  const refresh = switchOn(page);
  await expect(refresh).toBeChecked();
  await refresh.click();
  await expect(refresh).not.toBeChecked();

  const api = recordApiPaths(page);
  const frozen = await appendToolCall(id);
  await page.waitForTimeout(3_000);
  await expect(page.getByRole('tab', { name: 'Tool calls (1)' })).toBeVisible();
  await expect(page.getByText(frozen.tool_call_id)).toHaveCount(0);

  // Longer than the 15 s heartbeat and the 5 s fallback poll: an off page must
  // not keep a stream open, nor fall back to polling its query.
  await page.waitForTimeout(6_500);
  expect(api.paths.filter((path) => path.startsWith('/api/live/'))).toEqual([]);
  expect(api.paths.filter((path) => path.startsWith(`/api/invocations/${id}`))).toEqual([]);

  // The choice is remembered in the browser, not in the page's memory.
  await page.reload();
  await expect(switchOn(page)).not.toBeChecked();
  // A reload opens the Overview again; the call ids are listed on Tool calls.
  await page.getByRole('tab', { name: 'Tool calls (2)' }).click();

  await switchOn(page).click();
  const live = await appendToolCall(id);
  await expect(page.getByRole('tabpanel', { name: /Tool calls/ }).getByText(live.tool_call_id)).toBeVisible({
    timeout: 10_000,
  });
  // Release the conversation's one running slot for the next spec in this file.
  await e2eFetch(`/running-invocation/finish?id=${id}`, { method: 'POST' });
});

test('the invocation list shows a new arrival at the top without touching the notice', async ({ page }, testInfo) => {
  await page.goto(await adminUrl('/invocations'));
  const rows = tableBodyRows(page);
  await expect(rows.first()).toBeVisible();
  const before = await rows.first().locator('td:first-child').textContent();

  const { id } = await e2eFetch<{ id: string }>('/insert-invocation', { method: 'POST' });
  await expect(rows.first().locator('td:first-child')).toHaveText(String(id), { timeout: 10_000 });
  expect(String(id)).not.toBe(before);
  // Page 1 renews its own snapshot, so no "new records" notice is waiting.
  await expect(page.getByRole('status').filter({ hasText: 'new record' })).toHaveCount(0);

  const shot = testInfo.outputPath('list-live.png');
  await page.screenshot({ path: shot, fullPage: true });
  await testInfo.attach('list-live', { path: shot, contentType: 'image/png' });

  // Off: an arrival must not push the table on its own any more.
  const api = recordApiPaths(page);
  await switchOn(page).click();
  const second = await e2eFetch<{ id: string }>('/insert-invocation', { method: 'POST' });
  await page.waitForTimeout(3_000);
  await expect(rows.first().locator('td:first-child')).toHaveText(String(id));
  await expect(page.getByText(String(second.id), { exact: true })).toHaveCount(0);

  // Longer than the old 15 s list poll and its 5 s fallback: an off list must
  // neither hold a stream nor poll its query.
  await page.waitForTimeout(6_500);
  expect(api.paths.filter((path) => path.startsWith('/api/live/'))).toEqual([]);
  expect(api.paths.filter((path) => path.startsWith('/api/invocations?'))).toEqual([]);
});

test('arrivals counted on page 2 are already on top of page 1 when the reader returns', async ({ page }, testInfo) => {
  await page.goto(await adminUrl('/invocations'));
  const rows = tableBodyRows(page);
  await expect(rows).toHaveCount(25);
  const firstPage = await rows.locator('td:first-child').allTextContents();

  await nextPage(page).click();
  await expect(page.getByRole('button', { name: 'Page 2', exact: true })).toHaveAttribute('aria-current', 'page');
  const { id } = await e2eFetch<{ id: string }>('/insert-invocation', { method: 'POST' });
  // Page 2 keeps its rows and only counts the arrival.
  await expect(page.getByRole('status').filter({ hasText: '1 new record' })).toBeVisible({ timeout: 10_000 });
  // The snapshot does not shift under the reader: page 2 keeps the rows it
  // already had and the arrival is not among them (the earlier tests in this
  // file left a few extra rows, so only the membership is asserted).
  expect(await rows.locator('td:first-child').allTextContents()).not.toContain(String(id));
  expect(firstPage).not.toContain(String(id));

  // Returning to page 1 must not depend on another change event arriving: the
  // reader asked for page 1, and page 1 is where the new rows belong.
  await previousPage(page).click();
  await expect(rows.first().locator('td:first-child')).toHaveText(String(id), { timeout: 10_000 });
  await expect(page.getByRole('status').filter({ hasText: 'new record' })).toHaveCount(0);

  const shot = testInfo.outputPath('list-page-return.png');
  await page.screenshot({ path: shot, fullPage: true });
  await testInfo.attach('list-page-return', { path: shot, contentType: 'image/png' });
});

test('an arrival on page 1 is fetched without dropping the table to its skeleton', async ({ page }) => {
  await page.goto(await adminUrl('/invocations'));
  const rows = tableBodyRows(page);
  await expect(rows).toHaveCount(25);
  const before = await rows.first().locator('td:first-child').textContent();

  // Hold the renewing request (a new snapshot carries no `as_of`) so the table
  // can be observed while it is in flight.
  const release = Promise.withResolvers<void>();
  let held = false;
  await page.route('**/api/invocations?*', async (route) => {
    const url = new URL(route.request().url());
    const renewing =
      url.pathname === '/api/invocations' &&
      url.searchParams.get('as_of') === null &&
      url.searchParams.get('offset') === '0';
    if (renewing && !held) {
      held = true;
      await release.promise;
    }
    await route.fallback();
  });

  const { id } = await e2eFetch<{ id: string }>('/insert-invocation', { method: 'POST' });
  await expect.poll(() => held).toBe(true);
  await page.waitForTimeout(500);
  // The previous rows stay on screen (and the table is not in its loading
  // state) until the new snapshot's answer arrives.
  await expect(page.locator('table').first()).not.toHaveAttribute('aria-busy', 'true');
  await expect(rows.first().locator('td:first-child')).toHaveText(String(before));

  release.resolve();
  await expect(rows.first().locator('td:first-child')).toHaveText(String(id), { timeout: 10_000 });
});

test('Auto scroll follows new rows to the bottom from the floating controls, only while it is on', async ({
  page,
}, testInfo) => {
  // Short enough that the detail page scrolls, so "at the bottom" means something.
  await page.setViewportSize({ width: 1280, height: 560 });
  const id = await runningInvocation();
  await appendToolCall(id);
  await appendToolCall(id);
  await page.goto(await adminUrl(`/invocations/${id}`));
  await page.getByRole('tab', { name: 'Tool calls (2)' }).click();
  // Clicking scrolls the tab into view; the reader starts at the top.
  await scrollToTop(page);

  // Off by default. Both live switches float over the page, so they are in
  // reach at the top of a page whose end is far below the viewport.
  const follow = page.getByRole('switch', AUTO_SCROLL);
  await expect(follow).not.toBeChecked();
  await expect(follow).toBeInViewport();
  await expect(switchOn(page)).toBeInViewport();
  expect(await distanceFromBottom(page)).toBeGreaterThan(100);

  // Off: a new row arrives and the page stays where the reader is.
  await appendToolCall(id);
  await expect(page.getByRole('tab', { name: 'Tool calls (3)' })).toBeVisible({ timeout: 10_000 });
  expect(await scrollTop(page)).toBe(0);

  // Turning it on goes to the bottom at once, without waiting for a change.
  await follow.click();
  await expect.poll(() => distanceFromBottom(page)).toBeLessThan(2);

  // The reader goes back up; the next row brings the page down to it.
  await scrollToTop(page);
  const followed = await appendToolCall(id);
  await expect(page.getByRole('tab', { name: 'Tool calls (4)' })).toBeVisible({ timeout: 10_000 });
  await expect.poll(() => distanceFromBottom(page)).toBeLessThan(2);
  await expect(page.getByText(followed.tool_call_id)).toBeInViewport();
  const shot = testInfo.outputPath('detail-auto-scroll.png');
  await page.screenshot({ path: shot });
  await testInfo.attach('detail-auto-scroll', { path: shot, contentType: 'image/png' });

  // Remembered in the browser; opening the page does not jump on its own, the
  // first fetch only marks where following starts.
  await page.reload();
  await expect(page.getByRole('switch', AUTO_SCROLL)).toBeChecked();
  await page.waitForTimeout(2_000);
  expect(await scrollTop(page)).toBe(0);

  // Off again: the next row leaves the page alone.
  await page.getByRole('switch', AUTO_SCROLL).click();
  await expect(page.getByRole('switch', AUTO_SCROLL)).not.toBeChecked();
  await page.getByRole('tab', { name: 'Tool calls (4)' }).click();
  await scrollToTop(page);
  await appendToolCall(id);
  await expect(page.getByRole('tab', { name: 'Tool calls (5)' })).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(500);
  expect(await scrollTop(page)).toBe(0);
  await e2eFetch(`/running-invocation/finish?id=${id}`, { method: 'POST' });
});

test('phone width keeps the switch reachable on both pages without sideways scrolling', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });

  await page.goto(await adminUrl('/invocations'));
  await expect(switchOn(page)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await page.screenshot({ path: testInfo.outputPath('list-switch-phone.png'), fullPage: true });

  const id = await runningInvocation();
  await page.goto(await adminUrl(`/invocations/${id}`));
  await expect(switchOn(page)).toBeInViewport();
  await expect(page.getByRole('switch', AUTO_SCROLL)).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await page.screenshot({ path: testInfo.outputPath('detail-switch-phone.png'), fullPage: true });

  const listShot = testInfo.outputPath('list-switch-phone.png');
  await testInfo.attach('list-switch-phone', { path: listShot, contentType: 'image/png' });
  const detailShot = testInfo.outputPath('detail-switch-phone.png');
  await testInfo.attach('detail-switch-phone', { path: detailShot, contentType: 'image/png' });
});
