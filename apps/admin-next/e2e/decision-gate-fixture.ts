import { expect, type Page } from '@playwright/test';
import { adminUrl, e2eFetch } from './helpers.ts';

/** The defaults `resolveDecisionGate` reports while the file has no gate section. */
export const GATE_DEFAULTS = {
  enabled: false,
  mode: 'shadow',
  threshold: 0.57,
  history_messages: 10,
  pending_messages: 10,
  model: 'typesafe/jev-1.14',
  base_url: 'https://openrouter.ai/api/alpha',
  timeout_ms: 3_000,
} as const;

export const DEFAULT_QUESTION_FRAGMENT = 'Would the bot, behaving like a friendly regular member';

export interface DecisionGateApiView {
  readonly revision: string;
  readonly saved: {
    readonly enabled: boolean;
    readonly mode: 'shadow' | 'enforce';
    readonly threshold: number;
    readonly history_messages: number;
    readonly pending_messages: number;
    readonly instructions: string;
    readonly model: string;
    readonly base_url: string;
    readonly timeout_ms: number;
  };
  readonly active: DecisionGateApiView['saved'];
  readonly key_configured: boolean;
  readonly key_source?: { readonly kind: string; readonly name?: string; readonly env?: string } | null;
}

export async function gateView(page: Page): Promise<DecisionGateApiView> {
  const response = await page.request.get(await adminUrl('/api/decision-gate'));
  expect(response.ok()).toBe(true);
  return (await response.json()) as DecisionGateApiView;
}

/** The file the running server holds, as written by the config writer. */
export async function gateConfigText(): Promise<string> {
  return (await e2eFetch<{ readonly text: string }>('/config-text')).text;
}

/**
 * Returns the gate to its factory state before each test: every field removed
 * from the file and every keychain entry this suite creates deleted, so
 * `--repeat-each` reruns start from the same defaults. Requires the page to be
 * on the server's origin (a same-origin `fetch` carries the session cookie).
 */
export async function resetDecisionGate(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const view = (await (await fetch('/api/decision-gate')).json()) as { revision: string };
    const response = await fetch('/api/decision-gate', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'if-match': view.revision },
      body: JSON.stringify({
        enabled: null,
        mode: null,
        threshold: null,
        history_messages: null,
        pending_messages: null,
        instructions: null,
        model: null,
        base_url: null,
        timeout_ms: null,
        api_key: null,
      }),
    });
    if (!response.ok) {
      throw new Error(`Resetting the entry gate failed: ${response.status} ${await response.text()}`);
    }
  });
  const snapshot = await page.request.get(await adminUrl('/api/keychain'));
  expect(snapshot.ok()).toBe(true);
  const keychain = (await snapshot.json()) as { readonly entries: readonly { readonly name: string }[] };
  for (const entry of keychain.entries.filter((candidate) => /^decision-gate(?:-\d+)?$/.test(candidate.name))) {
    // An entry the running configuration still references answers 409; the next
    // reset after that configuration is gone deletes it.
    await page.evaluate(async (name) => {
      await fetch(`/api/keychain/${encodeURIComponent(name)}`, { method: 'DELETE' });
    }, entry.name);
  }
}

/**
 * The variables of every mutation TanStack Query still remembers. The page has
 * no test-only global; the QueryClientProvider's context value is reachable
 * through the React fiber of the rendered shell. Used to prove that a submitted
 * plaintext never becomes part of the mutation cache.
 */
export async function mutationCacheVariables(page: Page): Promise<readonly unknown[]> {
  return page.evaluate(() => {
    interface Fiber {
      readonly memoizedProps?: { readonly value?: unknown };
      readonly return?: Fiber | null;
    }
    interface Client {
      readonly getMutationCache: () => {
        readonly getAll: () => readonly { readonly state: { readonly variables: unknown } }[];
      };
    }
    const element = document.querySelector('main') ?? document.body;
    const key = Object.keys(element).find((name) => name.startsWith('__reactFiber$'));
    if (key === undefined) {
      throw new Error('No React fiber is attached to the page');
    }
    let fiber = (element as unknown as Record<string, unknown>)[key] as Fiber | null | undefined;
    while (fiber !== null && fiber !== undefined) {
      const value = fiber.memoizedProps?.value as Client | undefined;
      if (typeof value?.getMutationCache === 'function') {
        return value
          .getMutationCache()
          .getAll()
          .map((mutation) => mutation.state.variables);
      }
      fiber = fiber.return;
    }
    throw new Error('The QueryClient context was not found in the React tree');
  });
}
