import { ApiError } from './api/core.ts';
import type { ModelApplySummary, ThinkingLevel } from './api/models.ts';
import { THINKING_LEVELS } from './api/models.ts';
import type {
  DraftField,
  MetadataSource,
  ModelCompatConfig,
  ModelInput,
  ModelMetadataDraft,
  ModelsDevMatch,
  ProviderApi,
  ProviderKind,
  ProviderModelConfig,
  ProviderView,
} from './api/providers.ts';
import { errorMessage } from './errors.ts';
import i18n from './i18n.ts';

/**
 * Pure helpers for the Models page: metadata source labels, draft → config
 * conversion, compat tri-state and write feedback. The
 * page keeps only React state and mutations; every decision that can be tested
 * without a DOM lives here.
 */

const DRAFT_FIELDS: readonly DraftField[] = [
  'name',
  'reasoning',
  'thinking_levels',
  'input',
  'context_window',
  'max_tokens',
  'cost',
];

const SOURCE_LABELS: Record<MetadataSource, string | null> = {
  openrouter: 'OpenRouter',
  vercel: 'Vercel',
  gemini: 'Gemini',
  'models.dev': 'models.dev',
  'models.dev-cross-provider': null,
  'models.dev-fuzzy': null,
  'models.dev-highest-price': null,
  default: null,
  missing: null,
};

export function providerApiLabel(api: ProviderApi): string {
  switch (api) {
    case 'openai-completions':
      return i18n.t('models.models.apiFormat.openaiCompletions');
    case 'openai-responses':
      return i18n.t('models.models.apiFormat.openaiResponses');
    case 'anthropic-messages':
      return i18n.t('models.models.apiFormat.anthropicMessages');
    case 'google-generative-ai':
      return i18n.t('models.models.apiFormat.googleGenerativeAi');
  }
}

export function providerKindLabel(kind: ProviderKind): string {
  return kind === 'builtin' ? i18n.t('models.models.kind.builtin') : i18n.t('models.models.kind.custom');
}

export function modalityLabel(modality: ModelInput): string {
  return modality === 'text' ? i18n.t('models.models.modality.text') : i18n.t('models.models.modality.image');
}

export function draftFieldLabel(field: DraftField): string {
  switch (field) {
    case 'name':
      return i18n.t('models.models.edit.name');
    case 'reasoning':
      return i18n.t('models.models.edit.reasoning');
    case 'thinking_levels':
      return i18n.t('models.models.edit.thinkingLevels');
    case 'input':
      return i18n.t('models.models.edit.input');
    case 'context_window':
      return i18n.t('models.models.edit.contextWindow');
    case 'max_tokens':
      return i18n.t('models.models.edit.maxTokens');
    case 'cost':
      return i18n.t('models.models.edit.cost');
  }
}

export function metadataSourceLabel(source: MetadataSource): string {
  const fixed = SOURCE_LABELS[source];
  if (fixed !== null) {
    return fixed;
  }
  switch (source) {
    case 'models.dev-cross-provider':
      return i18n.t('models.models.source.crossProvider');
    case 'models.dev-fuzzy':
      return i18n.t('models.models.source.fuzzy');
    case 'models.dev-highest-price':
      return i18n.t('models.models.source.highestPrice');
    default:
      return i18n.t('models.models.source.missing');
  }
}

export function fieldSourceLabel(draft: ModelMetadataDraft, field: DraftField): string {
  const source = draft.sources[field];
  if (source === 'missing') {
    return i18n.t('models.models.source.missing');
  }
  if (source === 'default') {
    return field === 'reasoning'
      ? i18n.t('models.models.source.reasoningDefault')
      : i18n.t('models.models.source.costDefault');
  }
  return i18n.t('models.models.source.from', { source: metadataSourceLabel(source) });
}

/**
 * A field the admin has to look at before saving. The server decides: only
 * context length, max output and accepted input ever block a model, when they
 * are missing, only fuzzily matched, or inconsistent with each other. Prices and
 * thinking always come with a value, and the rest is optional.
 */
export function isDraftFieldUnconfirmed(draft: ModelMetadataDraft, field: DraftField): boolean {
  return draft.needs_confirmation.includes(field);
}

/**
 * No source said whether the model thinks, so it is saved as a model that does
 * not. That never blocks the save, but the admin is told.
 */
export function reasoningDefaulted(draft: ModelMetadataDraft): boolean {
  return draft.sources.reasoning === 'default';
}

/** Where a draft's metadata was matched, so "needs confirming" is explainable. */
export function matchLabel(match: ModelsDevMatch | null): string | null {
  if (match === null) {
    return null;
  }
  const note =
    match.confidence === 'cross-provider'
      ? i18n.t('models.models.match.crossProviderNote')
      : match.confidence === 'fuzzy'
        ? i18n.t('models.models.match.fuzzyNote')
        : '';
  return `${i18n.t('models.models.match.matched', { provider: match.provider, model: match.model })}${note}`;
}

export function draftNeedsConfirmation(draft: ModelMetadataDraft): boolean {
  return draft.needs_confirmation.length > 0;
}

export function unconfirmedFields(draft: ModelMetadataDraft): readonly DraftField[] {
  return DRAFT_FIELDS.filter((field) => isDraftFieldUnconfirmed(draft, field));
}

/**
 * A draft only becomes a configuration entry when every required field has a
 * value. The panel defaults nothing itself: a missing limit stays missing and
 * forces the admin through the edit dialog.
 */
export function modelFromDraft(draft: ModelMetadataDraft): ProviderModelConfig | undefined {
  if (
    draft.reasoning === null ||
    draft.input === null ||
    draft.context_window === null ||
    draft.max_tokens === null ||
    draft.cost === null
  ) {
    return undefined;
  }
  return {
    id: draft.id,
    ...(draft.name === null ? {} : { name: draft.name }),
    reasoning: draft.reasoning,
    ...(draft.reasoning && draft.thinking_levels !== null ? { thinking_levels: draft.thinking_levels } : {}),
    input: draft.input,
    context_window: draft.context_window,
    max_tokens: draft.max_tokens,
    cost: draft.cost,
  };
}

// --- thinking levels -------------------------------------------------------

/** What Pi offers a reasoning model that declares no levels. */
const UNDECLARED_REASONING_LEVELS: readonly ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high'];

/**
 * The levels a configured model accepts, weakest first — the same rule the
 * server validates `agent.thinking_level` with (`src/platform/thinking-levels.ts`).
 */
export function supportedThinkingLevels(model: {
  readonly reasoning: boolean;
  readonly thinking_levels?: readonly ThinkingLevel[];
}): readonly ThinkingLevel[] {
  if (!model.reasoning) {
    return ['off'];
  }
  const declared = model.thinking_levels;
  if (declared === undefined) {
    return UNDECLARED_REASONING_LEVELS;
  }
  return THINKING_LEVELS.filter((level) => declared.includes(level));
}

export function isThinkingLevel(value: string): value is ThinkingLevel {
  return (THINKING_LEVELS as readonly string[]).includes(value);
}

/** Levels in Pi's order, whatever order they were picked in. */
export function sortThinkingLevels(levels: readonly ThinkingLevel[]): readonly ThinkingLevel[] {
  return THINKING_LEVELS.filter((level) => levels.includes(level));
}

/** A provider/model entry in the file view, or `null` if either side is unset or missing. */
export function modelConfigFor(
  view: { readonly providers: readonly ProviderView[] },
  provider: string | null,
  model: string | null,
): ProviderModelConfig | null {
  if (provider === null || model === null) {
    return null;
  }
  const entry = view.providers.find((candidate) => candidate.alias === provider);
  return entry?.models.find((candidate) => candidate.id === model) ?? null;
}

/** The agent model's entry in the file view, or `null` if the file lost it. */
export function agentModelConfig(view: {
  readonly agent: { readonly provider: string | null; readonly model: string | null };
  readonly providers: readonly ProviderView[];
}): ProviderModelConfig | null {
  return modelConfigFor(view, view.agent.provider, view.agent.model);
}

// --- compat tri-state ------------------------------------------------------

export const AUTO_COMPAT = 'auto';

export interface CompatOption {
  readonly value: string;
  readonly label: () => string;
}

export interface CompatFieldSpec {
  readonly field: keyof ModelCompatConfig;
  readonly label: () => string;
  /** `boolean` fields are on/off; `enum` fields offer their concrete values. */
  readonly kind: 'boolean' | 'enum';
  readonly options: readonly CompatOption[];
}

const BOOLEAN_OPTIONS: readonly CompatOption[] = [
  { value: 'on', label: () => i18n.t('models.models.compat.on') },
  { value: 'off', label: () => i18n.t('models.models.compat.off') },
];

/**
 * Which compat overrides each API honours. `anthropic-messages` and
 * `google-generative-ai` have none, so their models hide the advanced section
 * entirely — the server rejects a field the adapter does not read.
 */
const COMPAT_FIELDS_BY_API: Record<ProviderApi, readonly CompatFieldSpec[]> = {
  'openai-completions': [
    {
      field: 'supports_developer_role',
      label: () => i18n.t('models.models.compat.supportsDeveloperRole'),
      kind: 'boolean',
      options: BOOLEAN_OPTIONS,
    },
    {
      field: 'thinking_format',
      label: () => i18n.t('models.models.compat.thinkingFormat'),
      kind: 'enum',
      options: [
        { value: 'openai', label: () => i18n.t('models.models.compat.openai') },
        { value: 'openrouter', label: () => i18n.t('models.models.compat.openrouter') },
        { value: 'deepseek', label: () => i18n.t('models.models.compat.deepseek') },
        { value: 'together', label: () => i18n.t('models.models.compat.together') },
        { value: 'zai', label: () => i18n.t('models.models.compat.zai') },
        { value: 'qwen', label: () => i18n.t('models.models.compat.qwen') },
        { value: 'string-thinking', label: () => i18n.t('models.models.compat.stringThinking') },
      ],
    },
    {
      field: 'max_tokens_field',
      label: () => i18n.t('models.models.compat.maxTokensField'),
      kind: 'enum',
      options: [
        { value: 'max_completion_tokens', label: () => i18n.t('models.models.compat.maxCompletionTokens') },
        { value: 'max_tokens', label: () => i18n.t('models.models.compat.maxTokens') },
      ],
    },
    {
      field: 'requires_reasoning_content',
      label: () => i18n.t('models.models.compat.requiresReasoningContent'),
      kind: 'boolean',
      options: BOOLEAN_OPTIONS,
    },
    {
      field: 'cache_control_format',
      label: () => i18n.t('models.models.compat.cacheControlFormat'),
      kind: 'enum',
      options: [{ value: 'anthropic', label: () => i18n.t('models.models.compat.anthropic') }],
    },
  ],
  'openai-responses': [
    {
      field: 'supports_developer_role',
      label: () => i18n.t('models.models.compat.supportsDeveloperRole'),
      kind: 'boolean',
      options: BOOLEAN_OPTIONS,
    },
  ],
  'anthropic-messages': [],
  'google-generative-ai': [],
};

export function compatFieldsForApi(api: ProviderApi): readonly CompatFieldSpec[] {
  return COMPAT_FIELDS_BY_API[api];
}

export function compatStateFromConfig(
  api: ProviderApi,
  compat: ModelCompatConfig | undefined,
): Readonly<Record<string, string>> {
  const state: Record<string, string> = {};
  for (const spec of compatFieldsForApi(api)) {
    const value = compat?.[spec.field];
    if (typeof value === 'boolean') {
      state[spec.field] = value ? 'on' : 'off';
    } else if (typeof value === 'string') {
      state[spec.field] = value;
    } else {
      state[spec.field] = AUTO_COMPAT;
    }
  }
  return state;
}

export function compatConfigFromState(
  api: ProviderApi,
  state: Readonly<Record<string, string>>,
): ModelCompatConfig | undefined {
  const compat: Record<string, unknown> = {};
  for (const spec of compatFieldsForApi(api)) {
    const value = state[spec.field] ?? AUTO_COMPAT;
    if (value === AUTO_COMPAT) {
      continue;
    }
    compat[spec.field] = spec.kind === 'boolean' ? value === 'on' : value;
  }
  return Object.keys(compat).length === 0 ? undefined : (compat as ModelCompatConfig);
}

// --- tool-schema keywords --------------------------------------------------

/**
 * The profiles the panel offers for one model. `auto` is the tri-state "leave
 * the field out", exactly like the compat section: an absent field keeps the
 * schema the runtime builds.
 */
export const TOOL_SCHEMA_KEYWORDS_OPTIONS: readonly CompatOption[] = [
  { value: AUTO_COMPAT, label: () => i18n.t('models.models.edit.automatic') },
  { value: 'minimal', label: () => i18n.t('models.models.edit.toolSchemaMinimal') },
];

export function toolSchemaKeywordsFromState(state: string): ProviderModelConfig['tool_schema_keywords'] {
  return state === 'minimal' ? 'minimal' : undefined;
}

// --- in-use lookups --------------------------------------------------------

export type ModelUsage = 'agent' | 'vision' | 'both' | null;

export function modelUsage(
  view: {
    readonly agent: { provider: string | null; model: string | null };
    readonly vision: { provider: string | null; model: string | null };
  },
  alias: string,
  modelId: string,
): ModelUsage {
  const agent = view.agent.provider === alias && view.agent.model === modelId;
  const vision = view.vision.provider === alias && view.vision.model === modelId;
  if (agent && vision) {
    return 'both';
  }
  if (agent) {
    return 'agent';
  }
  if (vision) {
    return 'vision';
  }
  return null;
}

export function providerUsage(
  view: {
    readonly agent: { provider: string | null };
    readonly vision: { provider: string | null };
    readonly tool_model: { readonly provider: string | null; readonly inherited: boolean };
  },
  alias: string,
): { readonly agent: boolean; readonly vision: boolean; readonly tool: boolean } {
  return {
    agent: view.agent.provider === alias,
    vision: view.vision.provider === alias,
    // An inherited Tool Model follows the Agent model; it is not a slot of its own.
    tool: !view.tool_model.inherited && view.tool_model.provider === alias,
  };
}

// --- write feedback --------------------------------------------------------

export const CONFIG_CONFLICT_CODE = 'config_conflict';

/**
 * Save feedback must never present a pending restart as applied: whenever a
 * restart path is waiting, the message says so even if other paths went live.
 */
export function applyFeedback(apply: ModelApplySummary): { readonly title: string; readonly description: string } {
  const applied = apply.applied.length;
  const restart = apply.restart_required.length;
  if (restart > 0) {
    return {
      title: i18n.t('models.models.feedback.savedRestartRequired'),
      description:
        applied === 0
          ? i18n.t('models.models.feedback.restartWaiting', { count: restart })
          : i18n.t('models.models.feedback.appliedAndWaiting', { count: restart, applied }),
    };
  }
  if (applied > 0) {
    return {
      title: i18n.t('models.models.feedback.applied'),
      description: i18n.t('models.models.feedback.appliedDetail', { count: applied }),
    };
  }
  return {
    title: i18n.t('models.models.feedback.saved'),
    description: i18n.t('models.models.feedback.savedDescription'),
  };
}

export function isConfigConflict(error: unknown): boolean {
  return error instanceof ApiError && error.code === CONFIG_CONFLICT_CODE;
}

export const MODEL_IN_USE_CODE = 'model_in_use';

/**
 * How many running Invocations a refused model switch would stop, or `null`
 * when the error is not that refusal. The switch is retried with
 * `abort_running: true` once the admin agrees.
 */
export function modelInUseCount(error: unknown): number | null {
  if (!(error instanceof ApiError) || error.code !== MODEL_IN_USE_CODE) {
    return null;
  }
  const payload = error.payload as { readonly running_invocations?: unknown } | null;
  return typeof payload?.running_invocations === 'number' ? payload.running_invocations : 0;
}

/** Error text for the page and its dialogs; conflicts get a readable message. */
export function writeErrorMessage(error: unknown): string {
  if (isConfigConflict(error)) {
    return i18n.t('models.models.feedback.writeConflict');
  }
  return errorMessage(error);
}

/** Local validation errors are shown as-is; API failures get the message above. */
export function requestErrorMessage(error: unknown): string {
  return error instanceof ApiError ? writeErrorMessage(error) : errorMessage(error);
}

// --- misc ------------------------------------------------------------------

/** Provider search matches the alias, Pi's provider id, the API and the address. */
export function providerMatchesSearch(provider: ProviderView, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) {
    return true;
  }
  return [
    provider.alias,
    provider.provider ?? '',
    provider.api,
    provider.base_url,
    provider.kind,
    providerKindLabel(provider.kind),
    providerApiLabel(provider.api),
  ].some((value) => value.toLowerCase().includes(needle));
}

export function modelMatchesSearch(
  model: { readonly id: string; readonly name?: string | null | undefined },
  query: string,
): boolean {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) {
    return true;
  }
  return [model.id, model.name ?? ''].some((value) => value.toLowerCase().includes(needle));
}

/** Ids typed by hand: one per line or comma separated, deduplicated. */
export function parseModelIds(text: string): readonly string[] {
  const ids = text
    .split(/[\s,]+/)
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  return [...new Set(ids)];
}

export function isTextCapable(model: ProviderModelConfig): boolean {
  return model.input.includes('text');
}

export function isImageCapable(model: ProviderModelConfig): boolean {
  return model.input.includes('image');
}
