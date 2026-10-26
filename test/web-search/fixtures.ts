import type { RawConfig } from '../../src/platform/config/index.ts';
import type { SecretStore } from '../../src/platform/secrets.ts';
import { brave } from '../../src/plugins/web-search/providers/brave.ts';
import { deepseek } from '../../src/plugins/web-search/providers/deepseek.ts';
import { exa } from '../../src/plugins/web-search/providers/exa.ts';
import { firecrawl } from '../../src/plugins/web-search/providers/firecrawl.ts';
import { searxng } from '../../src/plugins/web-search/providers/searxng.ts';
import { tavily } from '../../src/plugins/web-search/providers/tavily.ts';
import { youcom } from '../../src/plugins/web-search/providers/youcom.ts';
import type { SearchProviderSpec } from '../../src/plugins/web-search/extension.ts';
import { createWebSearchTool, type WebSearchToolOptions } from '../../src/plugins/web-search/web-search.ts';
import type { ToolAudit } from '../../src/store/tool-audit.ts';

export const PROVIDERS: readonly SearchProviderSpec[] = [tavily, brave, exa, firecrawl, deepseek, searxng, youcom];

export interface FetchCall {
  readonly url: string;
  readonly init: RequestInit;
}

export function recordingFetch(handler: (call: FetchCall, index: number) => Response | Promise<Response>): {
  readonly calls: FetchCall[];
  readonly impl: typeof fetch;
} {
  const calls: FetchCall[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    return await handler(call, calls.length - 1);
  }) as typeof fetch;
  return { calls, impl };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export interface EngineFixture {
  readonly id: string;
  readonly provider: string;
  readonly endpoint?: string;
  readonly api_key?: { readonly jar: string };
  readonly results?: number;
  readonly timeout_seconds?: number;
  readonly note?: string;
  readonly enabled?: boolean;
}

/** A RawConfig carrying only the section web search reads. */
export function searchConfig(
  engines: readonly EngineFixture[],
  options: { readonly enabled?: boolean; readonly urlFilters?: readonly string[] } = {},
): RawConfig {
  return {
    web_search: {
      ...(options.enabled === false ? { enabled: false } : {}),
      engines: engines as NonNullable<RawConfig['web_search']>['engines'],
      ...(options.urlFilters === undefined ? {} : { url_filters: [...options.urlFilters] }),
    },
  } as unknown as RawConfig;
}

export interface AuditRow {
  readonly toolCallId: string;
  readonly tool: string;
  readonly arguments: string;
  state: 'pending' | 'success' | 'error';
  code?: string;
  result?: string;
}

export function recordingAudit(): { readonly audit: ToolAudit; readonly rows: AuditRow[] } {
  const rows: AuditRow[] = [];
  const audit: ToolAudit = {
    start: (toolCallId, toolName, argumentsJson) => {
      const row: AuditRow = { toolCallId, tool: toolName, arguments: argumentsJson, state: 'pending' };
      rows.push(row);
      return {
        succeed: (text) => {
          row.state = 'success';
          row.result = text;
        },
        fail: (code) => {
          row.state = 'error';
          row.code = code;
        },
      };
    },
    reject: (toolCallId, toolName, argumentsJson, _sideEffect, errorCode) => {
      rows.push({
        toolCallId,
        tool: toolName,
        arguments: argumentsJson,
        state: 'error',
        code: errorCode,
      });
    },
  };
  return { audit, rows };
}

export interface ToolFixture {
  readonly tool: ReturnType<typeof createWebSearchTool>;
  readonly calls: FetchCall[];
  readonly rows: AuditRow[];
  readonly steers: string[];
  readonly setConfig: (config: RawConfig) => void;
}

/** One tool wired with a fake network, a fake secret store and a recording audit. */
export function toolFixture(
  initial: RawConfig,
  handler: (call: FetchCall, index: number) => Response | Promise<Response>,
  options: {
    readonly deadlineMs?: number;
    readonly secrets?: SecretStore;
    readonly fetchImpl?: typeof fetch;
  } = {},
): ToolFixture {
  const fetch = recordingFetch(handler);
  const { audit, rows } = recordingAudit();
  const steers: string[] = [];
  let config = initial;
  const toolOptions: WebSearchToolOptions = {
    audit,
    invocationDeadline: Date.now() + (options.deadlineMs ?? 30_000),
    readConfig: () => config,
    providers: PROVIDERS,
    fetchImpl: options.fetchImpl ?? fetch.impl,
    ...(options.secrets === undefined ? {} : { secrets: options.secrets }),
    steer: (text) => {
      steers.push(text);
    },
  };
  return {
    tool: createWebSearchTool(toolOptions),
    calls: fetch.calls,
    rows,
    steers,
    setConfig: (next) => {
      config = next;
    },
  };
}

/** A SecretStore stub: only resolve() is reached by the search capability. */
export function secretStore(values: Readonly<Record<string, string>> = {}): SecretStore {
  return {
    resolve: async (reference: { readonly jar?: string }) => {
      const name = reference.jar ?? '';
      const value = values[name];
      if (value === undefined) {
        throw new Error(`unknown secret ${name}`);
      }
      return value;
    },
  } as unknown as SecretStore;
}
