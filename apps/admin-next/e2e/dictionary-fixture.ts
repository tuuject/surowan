import { expect, type Page } from '@playwright/test';

import { adminUrl } from './helpers.ts';
import type {
  DictionaryDraft,
  DictionaryEntry,
  DictionaryScope,
  DictionarySettings,
  DictionaryView,
} from '../src/lib/api/dictionary.ts';

/**
 * API-level helpers shared by the `17-dictionary-*.e2e.ts` specs. Each spec
 * runs its own server, so every helper here talks to that spec's AdminServer.
 */

/** Reset between tests: the fixture's dictionary starts empty and stays that way. */
export async function clearEntries(page: Page, scope: DictionaryScope, chat: string | null): Promise<void> {
  for (let step = 0; step < 40; step += 1) {
    const view = await listView(page, { scope, ...(chat === null ? {} : { chat }) });
    const entry = view.items[0];
    if (entry === undefined) {
      return;
    }
    await removeEntry(page, entry);
  }
  throw new Error('dictionary cleanup did not converge');
}

export const CHAT_ID = '123456789';

/** Empties both scopes, so each test starts from an empty dictionary. */
export async function resetDictionaries(page: Page): Promise<void> {
  await clearEntries(page, 'global', null);
  await clearEntries(page, 'group', CHAT_ID);
}

export async function listView(
  page: Page,
  query: { readonly scope: 'global' | 'group'; readonly chat?: string; readonly search?: string },
): Promise<DictionaryView> {
  const params = new URLSearchParams({ scope: query.scope });
  if (query.chat !== undefined) {
    params.set('chat', query.chat);
  }
  if (query.search !== undefined) {
    params.set('search', query.search);
  }
  const response = await page.request.get(await adminUrl(`/api/dictionary?${params.toString()}`));
  expect(response.ok()).toBe(true);
  return (await response.json()) as DictionaryView;
}

export async function findEntry(
  page: Page,
  term: string,
  scope: 'global' | 'group' = 'global',
): Promise<DictionaryEntry | null> {
  const view = await listView(page, { scope, ...(scope === 'group' ? { chat: CHAT_ID } : {}) });
  return view.items.find((entry) => entry.term === term) ?? null;
}

export async function removeEntry(page: Page, entry: DictionaryEntry): Promise<void> {
  const response = await page.request.delete(await adminUrl(`/api/dictionary/${entry.id}`), {
    headers: { 'if-match': entry.revision },
  });
  expect(response.ok(), `cleanup delete failed for ${entry.term}`).toBe(true);
}

export async function createEntry(page: Page, draft: DictionaryDraft): Promise<DictionaryEntry> {
  const response = await page.request.post(await adminUrl('/api/dictionary'), { data: draft });
  expect(response.ok()).toBe(true);
  return (await response.json()) as DictionaryEntry;
}

export async function settings(page: Page, chat?: string): Promise<DictionarySettings> {
  const suffix = chat === undefined ? '' : `?chat=${chat}`;
  const response = await page.request.get(await adminUrl(`/api/dictionary/settings${suffix}`));
  if (!response.ok()) {
    console.log('DEBUG settings', response.status(), await response.text());
  }
  expect(response.ok()).toBe(true);
  return (await response.json()) as DictionarySettings;
}

/**
 * Restores an injection mode. The revision is read immediately before the
 * write (the same rule the panel follows), because any settings write moves the
 * config hash every other read was holding.
 */
export async function putSettings(
  page: Page,
  chat: string | undefined,
  body: { readonly injection_mode: DictionarySettings['override_mode'] },
): Promise<void> {
  const suffix = chat === undefined ? '' : `?chat=${chat}`;
  const current = await settings(page, chat);
  const response = await page.request.put(await adminUrl(`/api/dictionary/settings${suffix}`), {
    headers: { 'if-match': current.revision },
    data: body,
  });
  expect(response.ok()).toBe(true);
}

export function draft(term: string, overrides: Partial<DictionaryDraft> = {}): DictionaryDraft {
  return {
    term,
    definition: `Definition for ${term}`,
    aliases: [],
    scope: 'global',
    chat_id: null,
    enabled: true,
    ...overrides,
  };
}
