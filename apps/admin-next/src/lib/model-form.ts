import type { ThinkingLevel } from './api/models.ts';
import type {
  ModelCostConfig,
  ModelInput,
  ModelMetadataDraft,
  ProviderApi,
  ProviderModelConfig,
} from './api/providers.ts';
import i18n from './i18n.ts';
import {
  AUTO_COMPAT,
  compatConfigFromState,
  compatStateFromConfig,
  sortThinkingLevels,
  toolSchemaKeywordsFromState,
} from './model-manager.ts';

// --- model edit form -------------------------------------------------------

export interface ModelCostForm {
  readonly input: string;
  readonly output: string;
  readonly cache_read: string;
  readonly cache_write: string;
}

export interface ModelFormState {
  readonly id: string;
  readonly name: string;
  /** Empty means "leave the field out": commands fall back to `provider / model`. */
  readonly nickname: string;
  readonly reasoning: boolean;
  /** Declared levels; none checked means "leave it out" and use Pi's default. */
  readonly thinking_levels: readonly ThinkingLevel[];
  readonly input: readonly ModelInput[];
  readonly context_window: string;
  readonly max_tokens: string;
  readonly cost: ModelCostForm;
  /** One entry per compat field of the model's API; `auto` means "leave it out". */
  readonly compat: Readonly<Record<string, string>>;
  /** Tool-schema keyword profile; `auto` means "leave the field out of the file". */
  readonly tool_schema_keywords: string;
}

export interface ModelFormErrors {
  id?: string;
  input?: string;
  context_window?: string;
  max_tokens?: string;
  cost?: string;
}

const EMPTY_COST: ModelCostForm = { input: '', output: '', cache_read: '', cache_write: '' };

export function emptyModelForm(api: ProviderApi): ModelFormState {
  return {
    id: '',
    name: '',
    nickname: '',
    reasoning: false,
    thinking_levels: [],
    input: [],
    context_window: '',
    max_tokens: '',
    cost: EMPTY_COST,
    compat: compatStateFromConfig(api, undefined),
    tool_schema_keywords: AUTO_COMPAT,
  };
}

export function modelFormFromConfig(model: ProviderModelConfig, api: ProviderApi): ModelFormState {
  return {
    id: model.id,
    name: model.name ?? '',
    nickname: model.nickname ?? '',
    reasoning: model.reasoning,
    thinking_levels: model.thinking_levels ?? [],
    input: model.input,
    context_window: String(model.context_window),
    max_tokens: String(model.max_tokens),
    cost: {
      input: String(model.cost.input),
      output: String(model.cost.output),
      cache_read: String(model.cost.cache_read),
      cache_write: String(model.cost.cache_write),
    },
    compat: compatStateFromConfig(api, model.compat),
    tool_schema_keywords: model.tool_schema_keywords ?? AUTO_COMPAT,
  };
}

function modelFormFromDraft(draft: ModelMetadataDraft, api: ProviderApi): ModelFormState {
  const cost = draft.cost;
  return {
    id: draft.id,
    name: draft.name ?? '',
    nickname: '',
    reasoning: draft.reasoning ?? false,
    thinking_levels: draft.thinking_levels ?? [],
    input: draft.input ?? [],
    context_window: draft.context_window === null ? '' : String(draft.context_window),
    max_tokens: draft.max_tokens === null ? '' : String(draft.max_tokens),
    cost:
      cost === null
        ? EMPTY_COST
        : {
            input: String(cost.input),
            output: String(cost.output),
            cache_read: String(cost.cache_read),
            cache_write: String(cost.cache_write),
          },
    // Only the field Pi's detection cannot know is prefilled; everything else
    // stays automatic so a Pi upgrade can still improve it.
    compat: compatStateFromConfig(
      api,
      draft.requires_reasoning_content ? { requires_reasoning_content: true } : undefined,
    ),
    tool_schema_keywords: AUTO_COMPAT,
  };
}

/**
 * The edit form for a discovered draft. Once the admin confirmed it, reopening
 * starts from what they saved: rebuilding from the metadata again would drop
 * every edit — a nickname, which metadata never carries, most visibly.
 */
export function modelFormForDraft(
  draft: ModelMetadataDraft | null,
  confirmed: ProviderModelConfig | undefined,
  api: ProviderApi,
): ModelFormState {
  if (draft === null) {
    return emptyModelForm(api);
  }
  return confirmed === undefined ? modelFormFromDraft(draft, api) : modelFormFromConfig(confirmed, api);
}

function parsePositiveInteger(value: string): number | null {
  if (!/^\d+$/.test(value.trim())) {
    return null;
  }
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseNonNegativeNumber(value: string): number | null {
  if (value.trim().length === 0) {
    return null;
  }
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function validateModelForm(form: ModelFormState): ModelFormErrors {
  const errors: ModelFormErrors = {};
  if (form.id.trim().length === 0) {
    errors.id = i18n.t('models.models.validation.idRequired');
  }
  if (form.input.length === 0) {
    errors.input = i18n.t('models.models.validation.inputRequired');
  }
  const contextWindow = parsePositiveInteger(form.context_window);
  if (contextWindow === null) {
    errors.context_window = i18n.t('models.models.validation.positiveInteger');
  }
  const maxTokens = parsePositiveInteger(form.max_tokens);
  if (maxTokens === null) {
    errors.max_tokens = i18n.t('models.models.validation.positiveInteger');
  } else if (contextWindow !== null && maxTokens > contextWindow) {
    errors.max_tokens = i18n.t('models.models.validation.maxTokensExceeds');
  }
  const costs = [form.cost.input, form.cost.output, form.cost.cache_read, form.cost.cache_write];
  if (costs.some((value) => parseNonNegativeNumber(value) === null)) {
    errors.cost = i18n.t('models.models.validation.costRequired');
  }
  return errors;
}

export function modelFormToConfig(form: ModelFormState, api: ProviderApi): ProviderModelConfig {
  const cost: ModelCostConfig = {
    input: parseNonNegativeNumber(form.cost.input) ?? 0,
    output: parseNonNegativeNumber(form.cost.output) ?? 0,
    cache_read: parseNonNegativeNumber(form.cost.cache_read) ?? 0,
    cache_write: parseNonNegativeNumber(form.cost.cache_write) ?? 0,
  };
  const compat = compatConfigFromState(api, form.compat);
  const toolSchemaKeywords = toolSchemaKeywordsFromState(form.tool_schema_keywords);
  // Levels only exist on a reasoning model; unchecking reasoning drops them.
  const thinkingLevels = form.reasoning ? sortThinkingLevels(form.thinking_levels) : [];
  return {
    id: form.id.trim(),
    ...(form.name.trim().length === 0 ? {} : { name: form.name.trim() }),
    ...(form.nickname.trim().length === 0 ? {} : { nickname: form.nickname.trim() }),
    reasoning: form.reasoning,
    ...(thinkingLevels.length === 0 ? {} : { thinking_levels: thinkingLevels }),
    ...(compat === undefined ? {} : { compat }),
    ...(toolSchemaKeywords === undefined ? {} : { tool_schema_keywords: toolSchemaKeywords }),
    input: form.input,
    context_window: parsePositiveInteger(form.context_window) ?? 0,
    max_tokens: parsePositiveInteger(form.max_tokens) ?? 0,
    cost,
  };
}
