import type {
  SearchConfigInput,
  SearchEngineInput,
  SearchEngineView,
  SearchProviderView,
} from '@/lib/api/search.ts';

/**
 * The editable draft of one engine plus the translation to and from the API
 * shapes. Everything here is synchronous and free of React, so the page,
 * the editor and the validator share exactly one definition of "valid".
 */

export type KeyMode = 'keep' | 'new' | 'alias';

export interface EngineDraft {
  readonly key: string;
  readonly id: string;
  readonly provider: string;
  readonly enabled: boolean;
  readonly endpoint: string;
  readonly results: string;
  readonly timeout: string;
  readonly note: string;
  readonly apiKey: string;
  readonly keyMode: KeyMode;
  readonly keyAlias: string;
  readonly keyConfigured: boolean;
}

export function toDraft(engine: SearchEngineView): EngineDraft {
  return {
    key: crypto.randomUUID(),
    id: engine.id,
    provider: engine.provider,
    enabled: engine.enabled,
    endpoint: engine.endpoint,
    results: String(engine.results),
    timeout: String(engine.timeout_seconds),
    note: engine.note,
    apiKey: '',
    keyMode: engine.key_configured ? 'keep' : 'new',
    keyAlias: '',
    keyConfigured: engine.key_configured,
  };
}

export function emptyDraft(provider: SearchProviderView, existing: readonly EngineDraft[]): EngineDraft {
  const used = new Set(existing.map((engine) => engine.id));
  let index = existing.length + 1;
  let id = `${provider.id}-${index}`;
  while (used.has(id)) {
    index += 1;
    id = `${provider.id}-${index}`;
  }
  return {
    key: crypto.randomUUID(),
    id,
    provider: provider.id,
    enabled: true,
    endpoint: '',
    results: provider.supports_count ? '5' : '',
    timeout: '15',
    note: '',
    apiKey: '',
    keyMode: 'new',
    keyAlias: '',
    keyConfigured: false,
  };
}

export function buildPayload(
  enabled: boolean,
  drafts: readonly EngineDraft[],
  filters: string,
  providers: ReadonlyMap<string, SearchProviderView>,
): SearchConfigInput {
  const engines: SearchEngineInput[] = drafts.map((draft) => {
    const provider = providers.get(draft.provider);
    return {
      id: draft.id.trim(),
      provider: draft.provider,
      enabled: draft.enabled,
      endpoint: draft.endpoint.trim().length === 0 ? null : draft.endpoint.trim(),
      results: provider?.supports_count === false ? null : parseInteger(draft.results),
      timeout_seconds: parseInteger(draft.timeout),
      note: draft.note.trim().length === 0 ? null : draft.note.trim(),
      api_key: draft.keyMode === 'new' && draft.apiKey.trim().length > 0 ? draft.apiKey.trim() : null,
      keep_api_key: draft.keyMode === 'keep',
      key_source: draft.keyMode === 'alias' && draft.keyAlias.trim().length > 0 ? draft.keyAlias.trim() : null,
    };
  });
  return {
    enabled,
    url_filters: splitLines(filters),
    engines,
  };
}

export function splitLines(value: string): string[] {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function parseInteger(value: string): number | null {
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : Number(trimmed);
}

/** Mirrors the server's rules so the save button never starts a doomed write. */
export function validate(input: SearchConfigInput, providers: readonly SearchProviderView[]): readonly string[] {
  const byId = new Map(providers.map((provider) => [provider.id, provider]));
  const errors: string[] = [];
  for (const [index, rule] of input.url_filters.entries()) {
    try {
      new RegExp(rule);
    } catch {
      errors.push(`URL filter #${index + 1} is not a valid regular expression`);
    }
  }
  const ids = new Set<string>();
  for (const [index, engine] of input.engines.entries()) {
    const label = `#${index + 1}`;
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(engine.id)) {
      errors.push(`${label}: id must be lowercase letters, digits and dashes`);
    }
    if (ids.has(engine.id)) {
      errors.push(`${label}: duplicate id ${engine.id}`);
    }
    ids.add(engine.id);
    const provider = byId.get(engine.provider);
    if (provider === undefined) {
      errors.push(`${label}: unknown provider ${engine.provider}`);
      continue;
    }
    if (engine.endpoint === null && provider.default_endpoint === null) {
      errors.push(`${label}: an endpoint is required`);
    }
    if (!provider.supports_count && engine.results !== null) {
      errors.push(`${label}: this provider does not accept a result count`);
    }
    if (engine.results !== null && (!Number.isInteger(engine.results) || engine.results < 1 || engine.results > 10)) {
      errors.push(`${label}: results must be between 1 and 10`);
    }
    if (
      engine.timeout_seconds !== null &&
      (!Number.isInteger(engine.timeout_seconds) || engine.timeout_seconds < 5 || engine.timeout_seconds > 30)
    ) {
      errors.push(`${label}: timeout must be between 5 and 30 seconds`);
    }
    if (provider.key === 'required' && engine.api_key === null && !engine.keep_api_key && engine.key_source === null) {
      errors.push(`${label}: an api key is required`);
    }
    if (
      provider.key === 'forbidden' &&
      (engine.api_key !== null || engine.key_source !== null || engine.keep_api_key)
    ) {
      errors.push(`${label}: this provider does not accept an api key`);
    }
  }
  return errors;
}

/** The first enabled engine count, for the switch summary. */
export function activeEngineCount(engines: readonly SearchEngineInput[]): number {
  return engines.filter((engine) => engine.enabled).length;
}
