import type {
  ModelCompatConfig,
  SecretRef,
  ThinkingLevelConfig,
  ToolSchemaKeywords,
} from '../../platform/config/index.ts';
import type { ApiAdapter } from '../prompts.ts';

export type BuiltinProviderConfig = {
  kind: 'builtin';
  provider: string;
  api_key: SecretRef;
  models: ModelConfig[];
};

type CustomProviderConfig = {
  kind: 'custom';
  base_url: string;
  api: ApiAdapter;
  api_key: SecretRef;
  headers?: Record<string, SecretRef>;
  models: ModelConfig[];
};

export type ProviderConfig = BuiltinProviderConfig | CustomProviderConfig;

export type ModelConfig = {
  id: string;
  name?: string;
  reasoning: boolean;
  thinking_levels?: ThinkingLevelConfig[];
  compat?: ModelCompatConfig;
  tool_schema_keywords?: ToolSchemaKeywords;
  input: Array<'text' | 'image'>;
  context_window: number;
  max_tokens: number;
  cost: { input: number; output: number; cache_read: number; cache_write: number };
};

export type ProviderAction = 'add' | 'edit' | 'delete' | 'back';
export type ModelAction = 'add' | 'discover' | 'edit' | 'delete' | 'back';
type ProviderKind = 'builtin' | 'custom';
export type AddProviderKindAction = ProviderKind | 'back' | 'cancel';
export type BuiltinProviderField = 'provider' | 'api_key' | 'discover' | 'models' | 'save' | 'back';
export type CustomProviderDraftField =
  | 'base_url'
  | 'api'
  | 'api_key'
  | 'headers'
  | 'discover'
  | 'models'
  | 'save'
  | 'back';
export type CustomProviderField = 'base_url' | 'api' | 'api_key' | 'headers' | 'models' | 'cancel';
export type ModelField = 'name' | 'reasoning' | 'input' | 'context_window' | 'max_tokens' | 'cost' | 'cancel';

export type SearchChoice<Value> = {
  readonly value: Value;
  readonly name: string;
  readonly description?: string;
};

export function filterSearchChoices<Value>(
  choices: readonly SearchChoice<Value>[],
  term: string | undefined,
): readonly SearchChoice<Value>[] {
  const tokens =
    term
      ?.trim()
      .toLocaleLowerCase()
      .split(/\s+/)
      .filter((token) => token.length > 0) ?? [];
  if (tokens.length === 0) {
    return choices;
  }
  return choices.filter((choice) => {
    const searchable = `${choice.name} ${choice.description ?? ''}`.toLocaleLowerCase();
    return tokens.every((token) => searchable.includes(token));
  });
}
