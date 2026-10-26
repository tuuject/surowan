import type { AgentTool } from '@earendil-works/pi-agent-core';
import Type from 'typebox';
import type { RawConfig } from '../../platform/config/index.ts';
import type { SecretStore } from '../../platform/secrets.ts';
import { resolveSearchEngines, type ResolvedSearchEngine, type SearchProviderRule } from '../../platform/web-search.ts';
import type { ToolAudit } from '../../store/tool-audit.ts';
import { WebSearchError } from './errors.ts';
import type { SearchProviderSpec } from './extension.ts';
import { describe, engineChangedNotice, formatEngineList } from './format.ts';
import { buildRequest, executeSearch } from './request.ts';

/**
 * `web_search` is a discovery capability: it returns titles, URLs and short
 * snippets and never fetches a page body. `web_fetch` reads the page a result
 * names. The tool reads the published configuration at call time and freezes
 * one engine's request settings for the duration of the call, so a hot edit
 * never changes a request that is already in flight.
 */

const Strict = { additionalProperties: false } as const;
const WebSearchInputSchema = Type.Object(
  {
    action: Type.Optional(Type.Enum({ search: 'search', list: 'list' })),
    query: Type.Optional(Type.String({ maxLength: 500 })),
    engine: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
    count: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
  },
  Strict,
);

export type WebSearchAction = 'search' | 'list';

export interface WebSearchToolDetails {
  readonly action: WebSearchAction;
  readonly engine?: string;
  readonly provider?: string;
  readonly results?: number;
  readonly filtered?: number;
  readonly truncated?: boolean;
}

export interface WebSearchToolOptions {
  readonly audit: ToolAudit;
  readonly invocationDeadline: number;
  /** Published configuration; read once per call, never at construction. */
  readonly readConfig: () => RawConfig;
  /** Provider adapters contributed by the provider plugins. */
  readonly providers: readonly SearchProviderSpec[];
  /** Resolves the engine's SecretRef at request start. */
  readonly secrets?: SecretStore;
  /** Nudges the running model when the engine list changed under it. */
  readonly steer?: (text: string) => void;
  /** Test seam; production uses the global fetch. */
  readonly fetchImpl?: typeof fetch;
}

export function createWebSearchTool(
  options: WebSearchToolOptions,
): AgentTool<typeof WebSearchInputSchema, WebSearchToolDetails> {
  const rules: readonly SearchProviderRule[] = options.providers.map((provider) => provider.rule);
  const byProvider = new Map(options.providers.map((provider) => [provider.rule.id, provider]));
  const fetchImpl = options.fetchImpl ?? fetch;
  // The description is the engine list the model sees without calling; it is
  // rebuilt for every invocation, and `action: "list"` refreshes it mid-run.
  const initialEngines = resolveSearchEngines(options.readConfig(), rules).filter((engine) => engine.enabled);
  return {
    name: 'web_search',
    label: 'Search the web',
    description: describe(initialEngines),
    parameters: WebSearchInputSchema,
    executionMode: 'sequential',
    execute: async (toolCallId, input, outerSignal) => {
      const config = options.readConfig();
      const resolves = resolveSearchEngines(config, rules);
      const engines = resolves.filter((engine) => engine.enabled);
      const action: WebSearchAction = input.action === 'list' ? 'list' : 'search';
      // The audit row opens only once the engine and provider are known, so the
      // recorded arguments name what the request actually used. A failure
      // before that point is recorded as a rejected call instead.
      let record: ReturnType<ToolAudit['start']> | undefined;
      try {
        const section = config.web_search;
        if (section === undefined || section.enabled === false || engines.length === 0) {
          throw new WebSearchError(
            'search_disabled',
            'Web search is unavailable: it is off or no search engine is enabled. Do not retry; answer without searching or say that search is unavailable.',
          );
        }
        if (action === 'list') {
          const text = formatEngineList(engines, resolves);
          record = options.audit.start(toolCallId, 'web_search', JSON.stringify({ action }), false);
          record.succeed(text);
          return { content: [{ type: 'text', text }], details: { action } };
        }
        const query = input.query?.trim() ?? '';
        if (query.length === 0) {
          throw new WebSearchError('invalid_arguments', 'web_search requires a non-empty query');
        }
        const selection = selectEngine(engines, resolves, input.engine);
        if (selection.kind === 'unknown') {
          throw new WebSearchError(
            'unknown_engine',
            `No configured engine is named "${selection.name}". Read the current engines with web_search action "list" and choose one of: ${engines.map((engine) => engine.id).join(', ')}.`,
          );
        }
        if (selection.kind === 'disabled') {
          // The model chose an engine this invocation was built with; the
          // engine list changed underneath it. Steer so the next turn works
          // from the current list instead of retrying the disabled engine.
          options.steer?.(engineChangedNotice(selection.name, engines));
          throw new WebSearchError(
            'engine_disabled',
            `Engine "${selection.name}" is disabled. The engine list changed; read it again with web_search action "list" and choose one of: ${engines.map((engine) => engine.id).join(', ')}.`,
          );
        }
        const selected = selection.engine;
        const provider = byProvider.get(selected.provider.id);
        if (provider === undefined) {
          throw new WebSearchError(
            'engine_disabled',
            `Provider ${selected.provider.id} is no longer registered. Read the current engine list before retrying.`,
          );
        }
        const count = provider.rule.supportsResultCount ? (input.count ?? selected.results) : undefined;
        const request = await buildRequest(provider, selected, query, count, options.secrets);
        record = options.audit.start(
          toolCallId,
          'web_search',
          JSON.stringify({ action, query, engine: selected.id, provider: provider.rule.id, count: count ?? null }),
          false,
        );
        const text = await executeSearch({
          audit: record,
          engine: selected,
          provider,
          request,
          query,
          filters: section.url_filters ?? [],
          deadline: options.invocationDeadline,
          fetchImpl,
          ...(outerSignal === undefined ? {} : { outerSignal }),
        });
        return {
          content: [{ type: 'text', text: text.result }],
          details: {
            action,
            engine: selected.id,
            provider: selected.provider.id,
            results: text.results,
            filtered: text.filtered,
            truncated: text.truncated,
          },
        };
      } catch (error) {
        const code = error instanceof WebSearchError ? error.code : 'network_error';
        if (record === undefined) {
          options.audit.reject(
            toolCallId,
            'web_search',
            JSON.stringify({
              action,
              ...(input.query === undefined ? {} : { query: input.query }),
              ...(input.engine === undefined ? {} : { engine: input.engine }),
            }),
            false,
            code,
          );
        } else {
          record.fail(code);
        }
        // A transport error can echo request headers, so the credential is
        // scrubbed before the message reaches the model.
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`web_search failed: ${options.secrets?.redact(message) ?? message}`);
      }
    },
  };
}

type EngineSelection =
  | { readonly kind: 'selected'; readonly engine: ResolvedSearchEngine }
  | { readonly kind: 'disabled'; readonly name: string }
  | { readonly kind: 'unknown'; readonly name: string };

function selectEngine(
  engines: readonly ResolvedSearchEngine[],
  all: readonly ResolvedSearchEngine[],
  requested: string | undefined,
): EngineSelection {
  const name = requested?.trim();
  if (name === undefined || name.length === 0) {
    const [first] = engines;
    if (first === undefined) {
      return { kind: 'unknown', name: '' };
    }
    return { kind: 'selected', engine: first };
  }
  const exact = engines.find((engine) => engine.id === name);
  if (exact !== undefined) {
    return { kind: 'selected', engine: exact };
  }
  // The engine still exists but is disabled: report it as such rather than as
  // an unknown name, so the model knows the configuration changed.
  return all.some((engine) => engine.id === name) ? { kind: 'disabled', name } : { kind: 'unknown', name };
}
