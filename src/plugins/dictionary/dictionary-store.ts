import { randomUUID } from 'node:crypto';
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { chatMigrations, dictionaryEntries } from '../../store/schema.ts';
import { asRunResult, type Orm } from '../../store/store.ts';
import type { DictionaryDraft, DictionaryEntryRecord, DictionaryScope } from './dictionary.ts';
import { DictionaryError, dictionaryTextMatches, normalizeDraft } from './dictionary-match.ts';

export function newDictionaryId(): string {
  return `dic_${randomUUID().replaceAll('-', '')}`;
}

interface EntryRow {
  readonly id: string;
  readonly scope: string;
  readonly chat_id: bigint | null;
  readonly term: string;
  readonly definition: string;
  readonly aliases_json: string;
  readonly enabled: boolean;
  readonly revision: bigint;
  readonly created_at: string;
  readonly updated_at: string;
}

function toRecord(row: EntryRow): DictionaryEntryRecord {
  let aliases: readonly string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.aliases_json);
    if (Array.isArray(parsed)) {
      aliases = parsed.filter((value): value is string => typeof value === 'string');
    }
  } catch {
    // A row that cannot be decoded is treated as having no aliases rather than
    // failing the whole listing; writes always store valid JSON.
    aliases = [];
  }
  return {
    id: row.id,
    term: row.term,
    definition: row.definition,
    aliases,
    scope: row.scope === 'group' ? 'group' : 'global',
    chatId: row.chat_id,
    enabled: row.enabled,
    revision: row.revision.toString(),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * The Telegram chat IDs whose group entries belong to the given chat, including
 * a migrated predecessor. A group that became a supergroup keeps its old
 * `chat_id` on entries authored before the migration, so both the old and the
 * new ID must resolve to the same dictionary — the same rule `resolveChatConfig`
 * already applies to configuration. A chain (A→B→C) is followed transitively so
 * a dictionary never falls out of scope after more than one hop.
 */
export function dictionaryChatIdScope(orm: Orm, chatId: bigint): bigint[] {
  const ids = [chatId];
  const seen = new Set([chatId.toString()]);
  let frontier = [chatId];
  while (frontier.length > 0) {
    const rows = orm
      .select({ oldChatId: chatMigrations.oldChatId })
      .from(chatMigrations)
      .where(inArray(chatMigrations.newChatId, frontier))
      .all();
    frontier = [];
    for (const row of rows) {
      const key = row.oldChatId.toString();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      ids.push(row.oldChatId);
      frontier.push(row.oldChatId);
    }
  }
  return ids;
}

const ENTRY_COLUMNS = {
  id: dictionaryEntries.id,
  scope: dictionaryEntries.scope,
  chat_id: dictionaryEntries.chatId,
  term: dictionaryEntries.term,
  definition: dictionaryEntries.definition,
  aliases_json: dictionaryEntries.aliasesJson,
  enabled: dictionaryEntries.enabled,
  revision: dictionaryEntries.revision,
  created_at: dictionaryEntries.createdAt,
  updated_at: dictionaryEntries.updatedAt,
} as const;

export interface DictionaryListFilter {
  readonly scope: DictionaryScope;
  /** Group scope only; the Telegram chat ID whose entries are listed. */
  readonly chatId?: bigint;
  readonly search?: string;
}

export class DictionaryStore {
  readonly orm: Orm;

  constructor(orm: Orm) {
    this.orm = orm;
  }

  get(id: string): DictionaryEntryRecord | undefined {
    const row = this.orm.select(ENTRY_COLUMNS).from(dictionaryEntries).where(eq(dictionaryEntries.id, id)).get();
    return row === undefined ? undefined : toRecord(row);
  }

  /**
   * Entries of one scope, oldest ID first, optionally filtered by term or alias.
   *
   * The scope narrowing (and the migrated-chat resolution) runs in SQL; the
   * search term is applied in JS through `dictionaryTextMatches` so the Admin
   * search accepts the same pangu spacing the runtime matching does. `LIKE`
   * would fold ASCII case, and `instr` cannot express the boundary rule, so the
   * exact, case-sensitive comparison lives in one place. This loads the selected
   * scope before filtering; the cost scales with that scope's entry count.
   */
  list(filter: DictionaryListFilter): DictionaryEntryRecord[] {
    const conditions = [eq(dictionaryEntries.scope, filter.scope)];
    if (filter.scope === 'group') {
      // A migrated group's entries were authored under the predecessor ID; the
      // resolved scope keeps them visible without ever leaking another group's.
      conditions.push(inArray(dictionaryEntries.chatId, dictionaryChatIdScope(this.orm, filter.chatId ?? 0n)));
    }
    const search = filter.search;
    return this.orm
      .select(ENTRY_COLUMNS)
      .from(dictionaryEntries)
      .where(and(...conditions))
      .orderBy(dictionaryEntries.id)
      .all()
      .map(toRecord)
      .filter(
        (entry) =>
          search === undefined ||
          search.length === 0 ||
          [entry.term, ...entry.aliases].some((value) => dictionaryTextMatches(value, search)),
      );
  }

  /**
   * The effective dictionary of one conversation's chat: every global entry plus
   * the entries owned by that chat, in a stable order.
   */
  effective(
    chatId: bigint,
    options: { readonly enabledOnly: boolean } = { enabledOnly: true },
  ): DictionaryEntryRecord[] {
    const conditions = [
      or(
        eq(dictionaryEntries.scope, 'global'),
        and(
          eq(dictionaryEntries.scope, 'group'),
          inArray(dictionaryEntries.chatId, dictionaryChatIdScope(this.orm, chatId)),
        ),
      ),
    ];
    if (options.enabledOnly) {
      conditions.push(eq(dictionaryEntries.enabled, true));
    }
    return this.orm
      .select(ENTRY_COLUMNS)
      .from(dictionaryEntries)
      .where(and(...conditions))
      .orderBy(dictionaryEntries.scope, dictionaryEntries.id)
      .all()
      .map(toRecord);
  }

  /**
   * The effective dictionary a private chat can read: the global entries only,
   * because a group dictionary is never visible outside its own chat.
   */
  globalEntries(options: { readonly enabledOnly: boolean } = { enabledOnly: true }): DictionaryEntryRecord[] {
    const conditions = [eq(dictionaryEntries.scope, 'global')];
    if (options.enabledOnly) {
      conditions.push(eq(dictionaryEntries.enabled, true));
    }
    return this.orm
      .select(ENTRY_COLUMNS)
      .from(dictionaryEntries)
      .where(and(...conditions))
      .orderBy(dictionaryEntries.id)
      .all()
      .map(toRecord);
  }

  /** Creates one entry; group writes only ever target the caller-supplied chat. */
  create(draft: DictionaryDraft, now = new Date()): DictionaryEntryRecord {
    const normalized = normalizeDraft(draft);
    const timestamp = now.toISOString();
    const record: DictionaryEntryRecord = {
      id: newDictionaryId(),
      term: normalized.term,
      definition: normalized.definition,
      aliases: normalized.aliases,
      scope: normalized.scope,
      chatId: normalized.chatId,
      enabled: normalized.enabled,
      revision: '1',
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.orm
      .insert(dictionaryEntries)
      .values({
        id: record.id,
        scope: record.scope,
        chatId: record.chatId,
        term: record.term,
        definition: record.definition,
        aliasesJson: JSON.stringify(record.aliases),
        enabled: record.enabled,
        revision: 1n,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .run();
    return record;
  }

  /**
   * Replaces an entry's whole draft. The expected revision makes the write
   * conditional, so an old form cannot overwrite a concurrent edit; the revision
   * always advances, including for a no-op rewrite.
   */
  update(id: string, draft: DictionaryDraft, expectedRevision: string, now = new Date()): DictionaryEntryRecord {
    const normalized = normalizeDraft(draft);
    const timestamp = now.toISOString();
    const updated = asRunResult(
      this.orm
        .update(dictionaryEntries)
        .set({
          term: normalized.term,
          definition: normalized.definition,
          aliasesJson: JSON.stringify(normalized.aliases),
          scope: normalized.scope,
          chatId: normalized.chatId,
          enabled: normalized.enabled,
          revision: sql`${dictionaryEntries.revision} + 1`,
          updatedAt: timestamp,
        })
        .where(and(eq(dictionaryEntries.id, id), eq(dictionaryEntries.revision, BigInt(expectedRevision))))
        .run(),
    );
    if (updated.changes === 0) {
      throw new DictionaryError(
        'dictionary_conflict',
        'The entry changed since it was read, or no longer exists; reload and try again',
      );
    }
    const record = this.get(id);
    if (record === undefined) {
      throw new Error('Dictionary row vanished after update');
    }
    return record;
  }

  /** Deletes one entry, conditional on its revision. */
  remove(id: string, expectedRevision: string): void {
    const result = asRunResult(
      this.orm
        .delete(dictionaryEntries)
        .where(and(eq(dictionaryEntries.id, id), eq(dictionaryEntries.revision, BigInt(expectedRevision))))
        .run(),
    );
    if (result.changes === 0) {
      throw new DictionaryError(
        'dictionary_conflict',
        'The entry changed since it was read, or no longer exists; reload and try again',
      );
    }
  }

  /** Deletes one entry by ID without a revision check; used inside a confirm transaction. */
  removeUnchecked(id: string): boolean {
    return asRunResult(this.orm.delete(dictionaryEntries).where(eq(dictionaryEntries.id, id)).run()).changes === 1;
  }
}
