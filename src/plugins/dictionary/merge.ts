import type { Models } from '@earendil-works/pi-ai';
import { eq } from 'drizzle-orm';
import Type from 'typebox';
import Compile from 'typebox/compile';
import {
  parseToolModelJson,
  requireToolModel,
  toolModelReasoningOption,
  type ToolModelSelection,
} from '../../platform/tool-model.ts';
import type { SecretStore } from '../../platform/secrets.ts';
import type { Orm } from '../../store/store.ts';
import { modelCalls } from '../../store/schema/index.ts';
import type { DictionaryEntryRecord } from './tools.ts';
import {
  DICTIONARY_ALIAS_MAX_LENGTH,
  DICTIONARY_DEFINITION_MAX_LENGTH,
  DICTIONARY_MAX_ALIASES,
  DICTIONARY_TERM_MAX_LENGTH,
  DictionaryError,
  normalizeAliases,
} from './match.ts';

/**
 * The dictionary-merge suggestion, built on the system-wide auxiliary ("tool")
 * model resolved by `src/platform/tool-model.ts`.
 */

export interface MergeSuggestion {
  readonly term: string;
  readonly definition: string;
  readonly aliases: readonly string[];
}

const MAX_OUTPUT_TOKENS = 1_024;
const TIMEOUT_MS = 60_000;
const MAX_SOURCES = 20;

const SYSTEM_PROMPT = [
  'You merge dictionary entries for a chat bot. Each entry explains what a word, nickname or in-joke means to one group of people.',
  'Combine the sources into one entry that keeps every fact the sources state, merges repeated explanations instead of listing them twice, and keeps aliases that are still useful.',
  'Never invent a fact that no source states. When the sources genuinely disagree, keep a short explicit note about the disagreement rather than picking a side.',
  'Reply with one JSON object and nothing else: {"term": string, "definition": string, "aliases": string[]}.',
].join(' ');

/** A missing or unusable tool model; callers report it and keep the other features working. */
export class ToolModelUnavailableError extends Error {
  readonly code = 'tool_model_unavailable';

  constructor(message: string) {
    super(`tool_model_unavailable: ${message}`);
    this.name = 'ToolModelUnavailableError';
  }
}

export interface MergeDependencies {
  readonly orm: Orm;
  readonly secrets: SecretStore;
  readonly models: Models;
}

function sourceBlock(sources: readonly DictionaryEntryRecord[]): string {
  return sources
    .map((source, index) => {
      const aliases = source.aliases.length === 0 ? '(none)' : source.aliases.join(' | ');
      return [
        `Entry ${index + 1} (${source.scope === 'global' ? 'global' : 'group'}):`,
        `term: ${source.term}`,
        `aliases: ${aliases}`,
        `definition: ${source.definition}`,
      ].join('\n');
    })
    .join('\n\n');
}

/**
 * The merge suggestion contract. The model's reply is untrusted output, so it is
 * validated against the same term/definition/alias limits as a stored entry
 * rather than coerced: an out-of-range or mistyped field is an error, never a
 * silently dropped alias. `additionalProperties: false` keeps the model from
 * smuggling extra keys past the merge.
 */
const SuggestionSchema = Type.Object(
  {
    term: Type.String({ minLength: 1, maxLength: DICTIONARY_TERM_MAX_LENGTH }),
    definition: Type.String({ minLength: 1, maxLength: DICTIONARY_DEFINITION_MAX_LENGTH }),
    aliases: Type.Array(Type.String({ minLength: 1, maxLength: DICTIONARY_ALIAS_MAX_LENGTH }), {
      maxItems: DICTIONARY_MAX_ALIASES,
    }),
  },
  { additionalProperties: false },
);
const suggestionValidator = Compile(SuggestionSchema);

/** Extracts the first JSON object from a model reply, tolerating a fenced code block. */
function parseSuggestion(text: string): MergeSuggestion {
  const parsed = parseToolModelJson(
    text,
    suggestionValidator,
    (message) => new ToolModelUnavailableError(message),
    'an invalid suggestion',
  );
  const term = parsed.term.trim();
  const definition = parsed.definition.trim();
  if (term.length === 0 || definition.length === 0) {
    throw new ToolModelUnavailableError('The tool model returned an empty term or definition');
  }
  // Aliases are normalized (trim, drop blanks, dedupe) the same way a stored
  // entry is. A reply that only becomes valid through normalization is rejected
  // instead of quietly losing an alias the model asked to keep.
  if (parsed.aliases.some((alias) => alias.trim().length === 0)) {
    throw new ToolModelUnavailableError('The tool model returned a blank alias');
  }
  const aliases = normalizeAliases(parsed.aliases);
  if (aliases.length !== parsed.aliases.length) {
    throw new ToolModelUnavailableError('The tool model returned a duplicate alias');
  }
  return { term, definition, aliases };
}

/**
 * Asks the tool model for one merged entry. The result is a suggestion: nothing
 * is persisted here, and the sources stay untouched.
 */
export async function suggestMerge(
  dependencies: MergeDependencies,
  selection: ToolModelSelection,
  sources: readonly DictionaryEntryRecord[],
  signal?: AbortSignal,
): Promise<MergeSuggestion> {
  if (sources.length < 2) {
    throw new DictionaryError('merge_needs_sources', 'Select at least two entries to merge');
  }
  if (sources.length > MAX_SOURCES) {
    throw new DictionaryError('merge_too_many_sources', `At most ${MAX_SOURCES} entries can be merged at once`);
  }
  const model = requireToolModel(dependencies.models, selection, (message) => new ToolModelUnavailableError(message));
  const created = dependencies.orm
    .insert(modelCalls)
    .values({
      role: 'tool',
      provider: selection.provider,
      model: selection.model,
      attempt: 1n,
      state: 'pending',
      toolsJson: '[]',
      createdAt: new Date().toISOString(),
    })
    .returning({ id: modelCalls.id })
    .get();
  if (created === undefined) {
    throw new Error('model_calls insert returned no row');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Tool model call timed out')), TIMEOUT_MS);
  const combined = signal === undefined ? controller.signal : AbortSignal.any([signal, controller.signal]);
  const reasoning = toolModelReasoningOption(selection.thinkingLevel);
  const startedAt = performance.now();
  const finishCall = (fields: {
    readonly state: 'success' | 'error';
    readonly errorCode: string | null;
    readonly errorDetail: string | null;
    readonly usage?: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      totalTokens: number;
      cost: number;
    };
  }): void => {
    dependencies.orm
      .update(modelCalls)
      .set({
        state: fields.state,
        errorCode: fields.errorCode,
        errorDetail: fields.errorDetail,
        durationMs: BigInt(Math.round(performance.now() - startedAt)),
        ...(fields.usage === undefined
          ? {}
          : {
              inputTokens: BigInt(fields.usage.input),
              outputTokens: BigInt(fields.usage.output),
              cacheReadTokens: BigInt(fields.usage.cacheRead),
              cacheWriteTokens: BigInt(fields.usage.cacheWrite),
              totalTokens: BigInt(fields.usage.totalTokens),
              cost: fields.usage.cost,
            }),
        finishedAt: new Date().toISOString(),
      })
      .where(eq(modelCalls.id, created.id))
      .run();
  };
  try {
    const response = await dependencies.models.completeSimple(
      model,
      {
        messages: [
          { role: 'user', content: `${SYSTEM_PROMPT}\n\nSources:\n\n${sourceBlock(sources)}`, timestamp: Date.now() },
        ],
      },
      {
        signal: combined,
        maxTokens: Math.min(MAX_OUTPUT_TOKENS, model.maxTokens),
        maxRetries: 0,
        maxRetryDelayMs: 0,
        cacheRetention: 'none',
        ...(reasoning === undefined ? {} : { reasoning }),
      },
    );
    const usage = {
      input: response.usage.input,
      output: response.usage.output,
      cacheRead: response.usage.cacheRead,
      cacheWrite: response.usage.cacheWrite,
      totalTokens: response.usage.totalTokens,
      cost: response.usage.cost.total,
    };
    const text = response.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('');
    // Only a normal `stop` carries a final answer. `length`, `toolUse`, `error`,
    // `aborted` and the deferred/pending states are all abnormal: the reply is
    // truncated, still asking for a tool, or a failure, and must never be parsed
    // into a suggestion as if the model had finished.
    if (response.stopReason !== 'stop') {
      const detail = dependencies.secrets.redact(
        response.errorMessage ?? `The tool model stopped with ${response.stopReason}`,
      );
      finishCall({ state: 'error', errorCode: `tool_model_${response.stopReason}`, errorDetail: detail, usage });
      throw new ToolModelUnavailableError(detail);
    }
    let suggestion: MergeSuggestion;
    try {
      suggestion = parseSuggestion(text);
    } catch (error) {
      // The reply arrived cleanly but is not a usable suggestion: the call is
      // audited as an error, not as a success with an unparsed body.
      finishCall({
        state: 'error',
        errorCode: 'tool_model_invalid_output',
        errorDetail: dependencies.secrets.redactError(error),
        usage,
      });
      throw error;
    }
    finishCall({ state: 'success', errorCode: null, errorDetail: null, usage });
    return suggestion;
  } catch (error) {
    if (!(error instanceof ToolModelUnavailableError)) {
      finishCall({
        state: 'error',
        errorCode: combined.aborted ? 'tool_model_aborted' : 'tool_model_error',
        errorDetail: dependencies.secrets.redactError(error),
      });
      throw new ToolModelUnavailableError(dependencies.secrets.redactError(error));
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
