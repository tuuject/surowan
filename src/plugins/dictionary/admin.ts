import type { Models } from '@earendil-works/pi-ai';
import { and, eq } from 'drizzle-orm';
import Type, { type Static } from 'typebox';
import Compile from 'typebox/compile';
import {
  conflictGroupsFromValues,
  conflictsForScope,
  DICTIONARY_ALIAS_MAX_LENGTH,
  DICTIONARY_DEFINITION_MAX_LENGTH,
  DICTIONARY_MAX_ALIASES,
  DICTIONARY_TERM_MAX_LENGTH,
  type DictionaryConflict,
  type DictionaryDraft,
  type DictionaryEntryRecord,
  DictionaryError,
  type DictionaryScope,
  DictionaryStore,
} from './dictionary.ts';
import { type DictionaryFormat, encodeDictionaryExport, exportFileName, parseDictionaryImport } from './format.ts';
import { suggestMerge } from './merge.ts';
import { resolveDictionaryInjectionMode } from './injection.ts';
import type { DictionaryInjectionMode } from '../../platform/config.ts';
import { resolveToolModel } from '../../platform/tool-model.ts';
import type { SecretStore } from '../../platform/secrets.ts';
import { asRunResult, type Orm } from '../../store/store.ts';
import { chats, dictionaryEntries } from '../../store/schema.ts';
import { AdminQueryError } from '../../ingress/admin/audit.ts';

/**
 * Admin-facing dictionary operations: CRUD with per-entry optimistic locking,
 * conflict reporting, injection settings, import/export and the two-step merge.
 * Every scope is explicit here (the panel never infers one), and a group write
 * names its Telegram chat so an entry can never land in the wrong dictionary.
 */

const Strict = { additionalProperties: false } as const;
const ScopeSchema = Type.Union([Type.Literal('global'), Type.Literal('group')]);
const ChatIdSchema = Type.String({ pattern: '^-?[1-9][0-9]{0,15}$' });
const DraftSchema = Type.Object(
  {
    term: Type.String({ minLength: 1, maxLength: DICTIONARY_TERM_MAX_LENGTH }),
    definition: Type.String({ minLength: 1, maxLength: DICTIONARY_DEFINITION_MAX_LENGTH }),
    aliases: Type.Array(Type.String({ minLength: 1, maxLength: DICTIONARY_ALIAS_MAX_LENGTH }), {
      maxItems: DICTIONARY_MAX_ALIASES,
    }),
    scope: ScopeSchema,
    chat_id: Type.Union([ChatIdSchema, Type.Null()]),
    enabled: Type.Boolean(),
  },
  Strict,
);
const SettingsSchema = Type.Object({ injection_mode: Type.Union([Type.String(), Type.Null()]) }, Strict);
const ImportPreviewSchema = Type.Object(
  {
    format: Type.Union([Type.Literal('csv'), Type.Literal('jsonl')]),
    content: Type.String({ maxLength: 2_000_000 }),
    scope: ScopeSchema,
    chat_id: Type.Union([ChatIdSchema, Type.Null()]),
  },
  Strict,
);
const ImportSchema = Type.Object({ entries: Type.Array(DraftSchema, { minItems: 1, maxItems: 2_000 }) }, Strict);
const importValidator = Compile(ImportSchema);
const MergePreviewSchema = Type.Object(
  { ids: Type.Array(Type.String({ minLength: 1 }), { minItems: 2, maxItems: 20 }) },
  Strict,
);
const MergeConfirmSchema = Type.Object(
  {
    entry: DraftSchema,
    sources: Type.Array(Type.Object({ id: Type.String({ minLength: 1 }), revision: Type.String() }, Strict), {
      minItems: 1,
      maxItems: 20,
    }),
    delete_sources: Type.Boolean(),
  },
  Strict,
);

const draftValidator = Compile(DraftSchema);
const settingsValidator = Compile(SettingsSchema);
const importPreviewValidator = Compile(ImportPreviewSchema);
const mergePreviewValidator = Compile(MergePreviewSchema);
const mergeConfirmValidator = Compile(MergeConfirmSchema);

export type DictionaryDraftBody = Static<typeof DraftSchema>;
export type DictionaryImportPreviewBody = Static<typeof ImportPreviewSchema>;
export type DictionaryImportBody = Static<typeof ImportSchema>;
export type DictionaryMergeConfirmBody = Static<typeof MergeConfirmSchema>;

const INJECTION_MODES: ReadonlySet<string> = new Set(['off', 'on_demand', 'aggressive']);

function invalidBody(message: string): never {
  throw new AdminQueryError('invalid_body', message);
}

function translate(error: unknown): never {
  if (error instanceof DictionaryError) {
    throw new AdminQueryError(error.code, error.message, error.code === 'dictionary_conflict' ? 409 : 400);
  }
  throw error;
}

function parseShape<T>(
  validator: {
    Check(value: unknown): boolean;
    Errors(value: unknown): Iterable<{ instancePath: string; message: string }>;
  },
  value: unknown,
): T {
  if (typeof value !== 'object' || value === null) {
    invalidBody('Request body must be a JSON object');
  }
  if (!validator.Check(value)) {
    const detail = [...validator.Errors(value)]
      .slice(0, 5)
      .map((error) => `${error.instancePath || '/'}: ${error.message}`)
      .join('; ');
    invalidBody(detail);
  }
  return value as T;
}

export function parseDictionaryDraft(value: unknown): DictionaryDraftBody {
  return parseShape<DictionaryDraftBody>(draftValidator, value);
}

/**
 * Resolves the `scope` + `chat_id` pair the schema leaves loosely coupled. The
 * draft schema accepts either scope with a null or a non-null chat, so the two
 * invalid combinations are rejected here, before any `BigInt` conversion: a
 * group entry must name its chat, and a global entry must not. `BigInt('')`
 * used to throw an uncaught `SyntaxError` (a 500), and a global draft with a
 * chat silently dropped it.
 */
function resolveScopeChat(scope: DictionaryScope, chatId: string | null): bigint | null {
  if (scope === 'global') {
    if (chatId !== null) {
      invalidBody('A global entry cannot name a chat');
    }
    return null;
  }
  if (chatId === null) {
    invalidBody('A group entry must name its chat');
  }
  return BigInt(chatId);
}

/** Converts a validated draft body into the store shape, resolving the chat ID. */
export function toDraft(body: DictionaryDraftBody): DictionaryDraft {
  return {
    term: body.term,
    definition: body.definition,
    aliases: body.aliases,
    scope: body.scope,
    chatId: resolveScopeChat(body.scope, body.chat_id),
    enabled: body.enabled,
  };
}

function serializeEntry(entry: DictionaryEntryRecord) {
  return {
    id: entry.id,
    term: entry.term,
    definition: entry.definition,
    aliases: [...entry.aliases],
    scope: entry.scope,
    chat_id: entry.chatId === null ? null : entry.chatId.toString(),
    enabled: entry.enabled,
    created_at: entry.createdAt,
    updated_at: entry.updatedAt,
    revision: entry.revision,
  };
}

function serializeConflicts(conflicts: readonly DictionaryConflict[]) {
  return conflicts.map((conflict) => ({ value: conflict.value, entry_ids: [...conflict.entryIds] }));
}

export interface DictionaryQuery {
  readonly scope: DictionaryScope;
  readonly chatId: bigint | null;
  readonly search?: string;
}

export function parseDictionaryQuery(searchParams: URLSearchParams): DictionaryQuery {
  const scopeParam = searchParams.get('scope');
  if (scopeParam !== 'global' && scopeParam !== 'group') {
    throw new AdminQueryError('invalid_scope', 'scope must be global or group');
  }
  const chatParam = searchParams.get('chat');
  let chatId: bigint | null = null;
  if (scopeParam === 'group') {
    if (chatParam === null || !/^-?[1-9][0-9]{0,15}$/.test(chatParam)) {
      throw new AdminQueryError('invalid_chat', 'chat is required for the group scope');
    }
    chatId = BigInt(chatParam);
  } else if (chatParam !== null) {
    throw new AdminQueryError('invalid_chat', 'chat is not valid for the global scope');
  }
  const search = searchParams.get('search');
  return {
    scope: scopeParam,
    chatId,
    ...(search === null || search.length === 0 ? {} : { search: search.slice(0, 200) }),
  };
}

export function dictionaryView(store: DictionaryStore, query: DictionaryQuery) {
  const filter = {
    scope: query.scope,
    ...(query.chatId === null ? {} : { chatId: query.chatId }),
    ...(query.search === undefined ? {} : { search: query.search }),
  };
  return {
    items: store.list(filter).map(serializeEntry),
    conflicts: serializeConflicts(conflictsForScope(store, filter)),
  };
}

export function listDictionaryChatOptions(orm: Orm) {
  return orm
    .select({ telegramChatId: chats.telegramChatId, title: chats.title, type: chats.type })
    .from(chats)
    .orderBy(chats.telegramChatId)
    .all()
    .map((row) => ({ id: row.telegramChatId.toString(), title: row.title, type: row.type }));
}

/** Creates one entry from a validated draft. */
export function createDictionaryEntry(orm: Orm, body: DictionaryDraftBody) {
  try {
    return serializeEntry(new DictionaryStore(orm).create(toDraft(body)));
  } catch (error) {
    translate(error);
  }
}

/** Replaces one entry; the expected revision comes from `If-Match`. */
export function updateDictionaryEntry(orm: Orm, id: string, body: DictionaryDraftBody, expectedRevision: string) {
  try {
    return serializeEntry(new DictionaryStore(orm).update(id, toDraft(body), expectedRevision));
  } catch (error) {
    translate(error);
  }
}

export function deleteDictionaryEntry(orm: Orm, id: string, expectedRevision: string): void {
  try {
    new DictionaryStore(orm).remove(id, expectedRevision);
  } catch (error) {
    translate(error);
  }
}

export interface DictionarySettingsView {
  readonly revision: string;
  readonly injection_mode: DictionaryInjectionMode;
  readonly override_mode: DictionaryInjectionMode | null;
  readonly effective_mode: DictionaryInjectionMode;
}

export function parseDictionarySettingsBody(value: unknown): DictionaryInjectionMode | null {
  const body = parseShape<Static<typeof SettingsSchema>>(settingsValidator, value);
  if (body.injection_mode === null) {
    return null;
  }
  if (!INJECTION_MODES.has(body.injection_mode)) {
    invalidBody('injection_mode must be off, on_demand or aggressive, or null to clear it');
  }
  return body.injection_mode as DictionaryInjectionMode;
}

export function dictionarySettingsView(
  config: Parameters<typeof resolveDictionaryInjectionMode>[0],
  chatId: bigint | null,
  revision: string,
): DictionarySettingsView {
  const globalMode = config.dictionary?.injection_mode ?? 'on_demand';
  if (chatId === null) {
    return { revision, injection_mode: globalMode, override_mode: null, effective_mode: globalMode };
  }
  const chat = config.telegram.chats.find((candidate) => BigInt(candidate.id) === chatId);
  const override = chat?.dictionary_injection_mode ?? null;
  return {
    revision,
    injection_mode: globalMode,
    override_mode: override,
    effective_mode: resolveDictionaryInjectionMode(config, chatId),
  };
}

export function parseDictionaryImportPreview(value: unknown): DictionaryImportPreviewBody {
  return parseShape<DictionaryImportPreviewBody>(importPreviewValidator, value);
}

/** Parses one import file and reports the drafts plus conflicts with the target dictionary. */
export function previewDictionaryImport(
  store: DictionaryStore,
  body: DictionaryImportPreviewBody,
): { entries: DictionaryDraftBody[]; conflicts: ReturnType<typeof serializeConflicts> } {
  const chatId = resolveScopeChat(body.scope, body.chat_id);
  let drafts: readonly DictionaryDraft[];
  try {
    drafts = parseDictionaryImport(body.format, body.content, { scope: body.scope, chatId });
  } catch (error) {
    translate(error);
  }
  const entries: DictionaryDraftBody[] = drafts.map((draft) => ({
    term: draft.term,
    definition: draft.definition,
    aliases: [...draft.aliases],
    scope: draft.scope,
    chat_id: draft.chatId === null ? null : draft.chatId.toString(),
    enabled: draft.enabled,
  }));
  // Conflicts are computed against the target dictionary with the incoming
  // entries folded in: two rows of the same file collide with each other too,
  // and a pangu-spaced pair (`AB 钙` vs `AB钙`) collides the same way the runtime
  // matching and `conflictGroups` treat it.
  const existing = store.list({
    scope: body.scope,
    ...(chatId === null ? {} : { chatId }),
  });
  const incoming = entries.map((entry, index) => ({
    id: `import:${index}`,
    term: entry.term,
    aliases: entry.aliases,
  }));
  const conflicts = conflictGroupsFromValues([...existing, ...incoming]);
  return { entries, conflicts: serializeConflicts(conflicts) };
}

/** Writes a batch of already-previewed drafts in one transaction. */
export function importDictionaryEntries(orm: Orm, entries: readonly DictionaryDraftBody[]) {
  const store = new DictionaryStore(orm);
  return orm.transaction(() => entries.map((entry) => serializeEntry(store.create(toDraft(entry)))), {
    behavior: 'immediate',
  });
}

export function dictionaryExport(
  store: DictionaryStore,
  query: DictionaryQuery,
  format: DictionaryFormat,
): { filename: string; text: string } {
  const entries = store.list({
    scope: query.scope,
    ...(query.chatId === null ? {} : { chatId: query.chatId }),
  });
  return { filename: exportFileName(query.scope, query.chatId, format), text: encodeDictionaryExport(format, entries) };
}

export function parseExportFormat(searchParams: URLSearchParams): DictionaryFormat {
  const format = searchParams.get('format');
  if (format !== 'csv' && format !== 'jsonl') {
    throw new AdminQueryError('invalid_format', 'format must be csv or jsonl');
  }
  return format;
}

export interface MergePreviewDependencies {
  readonly store: DictionaryStore;
  readonly orm: Orm;
  readonly models: Models;
  readonly secrets: SecretStore;
  readonly toolModel: Parameters<typeof suggestMerge>[1];
}

export function parseMergePreview(value: unknown): readonly string[] {
  return parseShape<Static<typeof MergePreviewSchema>>(mergePreviewValidator, value).ids;
}

export function parseMergeConfirm(value: unknown): DictionaryMergeConfirmBody {
  return parseShape<DictionaryMergeConfirmBody>(mergeConfirmValidator, value);
}

/** Loads the sources by ID, refusing a request that names a missing entry. */
function loadSources(store: DictionaryStore, ids: readonly string[]): DictionaryEntryRecord[] {
  return [...new Set(ids)].map((id) => {
    const record = store.get(id);
    if (record === undefined) {
      throw new AdminQueryError('entry_not_found', `Dictionary entry ${id} does not exist`, 404);
    }
    return record;
  });
}

/** The tool-model suggestion: a read-only call, nothing is persisted. */
export async function mergePreview(dependencies: MergePreviewDependencies, ids: readonly string[]) {
  const sources = loadSources(dependencies.store, ids);
  try {
    const suggestion = await suggestMerge(
      { orm: dependencies.orm, secrets: dependencies.secrets, models: dependencies.models },
      dependencies.toolModel,
      sources,
    );
    return { suggestion, sources: sources.map(serializeEntry) };
  } catch (error) {
    translate(error);
  }
}

/**
 * Confirms a merge: creates the merged entry and optionally deletes the sources,
 * all in one transaction. Each source's revision must still match, so a source
 * edited after the suggestion was generated fails the whole write instead of
 * silently merging stale data.
 */
export function mergeDictionaryEntries(orm: Orm, body: DictionaryMergeConfirmBody) {
  const store = new DictionaryStore(orm);
  const drafts = toDraft(body.entry);
  const sources = body.sources;
  try {
    return orm.transaction(
      () => {
        for (const source of sources) {
          const row = store.orm
            .select({ revision: dictionaryEntries.revision })
            .from(dictionaryEntries)
            .where(and(eq(dictionaryEntries.id, source.id), eq(dictionaryEntries.revision, BigInt(source.revision))))
            .get();
          if (row === undefined) {
            throw new DictionaryError(
              'dictionary_conflict',
              'A source entry changed after the suggestion was generated; regenerate and try again',
            );
          }
        }
        const created = store.create(drafts);
        if (body.delete_sources) {
          for (const source of sources) {
            if (source.id === created.id) {
              continue;
            }
            const deleted = asRunResult(
              store.orm
                .delete(dictionaryEntries)
                .where(
                  and(eq(dictionaryEntries.id, source.id), eq(dictionaryEntries.revision, BigInt(source.revision))),
                )
                .run(),
            );
            if (deleted.changes !== 1) {
              throw new DictionaryError(
                'dictionary_conflict',
                'A source entry changed after the suggestion was generated; regenerate and try again',
              );
            }
          }
        }
        return { entry: serializeEntry(created), deleted_sources: body.delete_sources ? sources.length : 0 };
      },
      { behavior: 'immediate' },
    );
  } catch (error) {
    translate(error);
  }
}

/** Validates and returns an import batch before it reaches the transaction. */
export function parseDictionaryImportBody(value: unknown): DictionaryImportBody {
  return parseShape<DictionaryImportBody>(importValidator, value);
}

/** The panel's view of the auxiliary model: the selection plus whether it inherits. */
export function toolModelView(config: Parameters<typeof resolveToolModel>[0]): {
  readonly provider: string;
  readonly model: string;
  readonly thinking_level: string;
  readonly inherited: boolean;
} {
  const selection = resolveToolModel(config);
  return {
    provider: selection.provider,
    model: selection.model,
    thinking_level: selection.thinkingLevel,
    inherited: selection.inherited,
  };
}
