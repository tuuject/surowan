import {
  DICTIONARY_ALIAS_MAX_LENGTH,
  DICTIONARY_DEFINITION_MAX_LENGTH,
  DICTIONARY_MAX_ALIASES,
  DICTIONARY_TERM_MAX_LENGTH,
  DictionaryError,
  normalizeAliases,
} from './match.ts';
import type { DictionaryDraft, DictionaryEntryRecord, DictionaryScope } from './tools.ts';

/**
 * CSV and JSONL for dictionary entries, kept independent of the Admin upload UI
 * so a future Smart Import can call the same core.
 *
 * CSV is standard RFC 4180 (a quoted cell doubles `"`; commas, quotes and
 * newlines inside a cell are quoted). Aliases share one cell, separated by `|`;
 * a literal pipe is written `\|` and a backslash `\\`. JSONL is one object per
 * line with `aliases` as an array.
 */

export type DictionaryFormat = 'csv' | 'jsonl';

/** Exported column order; `enabled` is written so a round trip keeps the flag. */
export const CSV_HEADER = ['term', 'definition', 'aliases', 'enabled'] as const;

const MAX_IMPORT_ENTRIES = 2_000;
const MAX_IMPORT_CHARS = 2_000_000;

/** Parsed rows before scope assignment: the file never dictates its own scope. */
export interface ParsedDictionaryEntry {
  readonly term: string;
  readonly definition: string;
  readonly aliases: readonly string[];
  readonly enabled: boolean;
}

function fail(code: string, message: string): never {
  throw new DictionaryError(code, message);
}

/** Joins aliases into one CSV cell, escaping `\` and `|`. */
export function encodeAliasCell(aliases: readonly string[]): string {
  return aliases.map((alias) => alias.replaceAll('\\', '\\\\').replaceAll('|', '\\|')).join('|');
}

/** Splits one CSV alias cell back into aliases. */
export function decodeAliasCell(cell: string): string[] {
  if (cell.length === 0) {
    return [];
  }
  const aliases: string[] = [];
  let current = '';
  for (let index = 0; index < cell.length; index += 1) {
    const character = cell[index];
    if (character === '\\' && index + 1 < cell.length) {
      const next = cell[index + 1];
      if (next === '|' || next === '\\') {
        current += next;
        index += 1;
        continue;
      }
    }
    if (character === '|') {
      aliases.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  aliases.push(current);
  return aliases;
}

/** RFC 4180 parser: returns rows of cells; a trailing newline adds no row. */
export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let index = 0;
  const push = (): void => {
    row.push(cell);
    cell = '';
  };
  const endRow = (): void => {
    push();
    rows.push(row);
    row = [];
  };
  while (index < text.length) {
    const character = text[index];
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          cell += '"';
          index += 2;
          continue;
        }
        quoted = false;
        index += 1;
        continue;
      }
      cell += character;
      index += 1;
      continue;
    }
    if (character === '"' && cell.length === 0) {
      quoted = true;
      index += 1;
      continue;
    }
    if (character === ',') {
      push();
      index += 1;
      continue;
    }
    if (character === '\r') {
      if (text[index + 1] === '\n') {
        index += 1;
      }
      endRow();
      index += 1;
      continue;
    }
    if (character === '\n') {
      endRow();
      index += 1;
      continue;
    }
    cell += character;
    index += 1;
  }
  if (quoted) {
    fail('invalid_csv', 'CSV ends inside a quoted cell');
  }
  if (cell.length > 0 || row.length > 0) {
    endRow();
  }
  return rows;
}

function parseEnabled(value: string, line: number): boolean {
  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0) {
    return true;
  }
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') {
    return true;
  }
  if (normalized === 'false' || normalized === '0' || normalized === 'no') {
    return false;
  }
  return fail('invalid_enabled', `Line ${line}: enabled must be true or false`);
}

export function parseDictionaryCsv(content: string): ParsedDictionaryEntry[] {
  const rows = parseCsvRows(content);
  const header = rows[0];
  if (header === undefined) {
    return [];
  }
  const columns = header.map((name) =>
    name
      .trim()
      .replace(/^\ufeff/, '')
      .toLowerCase(),
  );
  const termIndex = columns.indexOf('term');
  const definitionIndex = columns.indexOf('definition');
  if (termIndex === -1 || definitionIndex === -1) {
    fail('invalid_csv_header', 'CSV must have a header row with term and definition columns');
  }
  const aliasesIndex = columns.indexOf('aliases');
  const enabledIndex = columns.indexOf('enabled');
  const entries: ParsedDictionaryEntry[] = [];
  for (const [offset, row] of rows.slice(1).entries()) {
    const line = offset + 2;
    if (row.every((cell) => cell.trim().length === 0)) {
      continue;
    }
    const term = (row[termIndex] ?? '').trim();
    const definition = (row[definitionIndex] ?? '').trim();
    if (term.length === 0 || definition.length === 0) {
      fail('invalid_entry', `Line ${line}: term and definition are required`);
    }
    const aliases = aliasesIndex === -1 ? [] : decodeAliasCell(row[aliasesIndex] ?? '');
    const enabled = enabledIndex === -1 ? true : parseEnabled(row[enabledIndex] ?? '', line);
    entries.push({ term, definition, aliases, enabled });
  }
  return entries;
}

/** JSONL: one JSON object per line; a malformed or mistyped line fails the whole import. */
export function parseDictionaryJsonl(content: string): ParsedDictionaryEntry[] {
  const entries: ParsedDictionaryEntry[] = [];
  for (const [offset, rawLine] of content.split('\n').entries()) {
    const line = rawLine.trim();
    if (line.length === 0) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      fail('invalid_jsonl', `Line ${offset + 1}: not valid JSON`);
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      fail('invalid_jsonl', `Line ${offset + 1}: each line must be a JSON object`);
    }
    const record = parsed as Record<string, unknown>;
    const term = typeof record.term === 'string' ? record.term.trim() : '';
    const definition = typeof record.definition === 'string' ? record.definition.trim() : '';
    if (term.length === 0 || definition.length === 0) {
      fail('invalid_entry', `Line ${offset + 1}: term and definition must be non-empty strings`);
    }
    let aliases: readonly string[] = [];
    if (record.aliases !== undefined) {
      if (!Array.isArray(record.aliases) || !record.aliases.every((value) => typeof value === 'string')) {
        fail('invalid_jsonl', `Line ${offset + 1}: aliases must be an array of strings`);
      }
      aliases = record.aliases as string[];
    }
    const enabled = record.enabled === undefined ? true : record.enabled;
    if (typeof enabled !== 'boolean') {
      fail('invalid_jsonl', `Line ${offset + 1}: enabled must be a boolean`);
    }
    entries.push({ term, definition, aliases: [...aliases], enabled });
  }
  return entries;
}

/**
 * Parses one import file into normalized drafts for the requested target scope.
 * The file carries only term/definition/aliases/enabled; scope and chat come from
 * the request, so an imported file can never write another chat's dictionary.
 */
export function parseDictionaryImport(
  format: DictionaryFormat,
  content: string,
  target: { readonly scope: DictionaryScope; readonly chatId: bigint | null },
): DictionaryDraft[] {
  if (content.length > MAX_IMPORT_CHARS) {
    fail('import_too_large', `Import content exceeds ${MAX_IMPORT_CHARS} characters`);
  }
  const parsed = format === 'csv' ? parseDictionaryCsv(content) : parseDictionaryJsonl(content);
  if (parsed.length > MAX_IMPORT_ENTRIES) {
    fail('import_too_large', `Import exceeds ${MAX_IMPORT_ENTRIES} entries`);
  }
  if (target.scope === 'global' && target.chatId !== null) {
    fail('invalid_scope', 'A global import cannot name a chat');
  }
  if (target.scope === 'group' && target.chatId === null) {
    fail('chat_required', 'A group import must name its chat');
  }
  return parsed.map((entry, index) => {
    const term = entry.term.trim();
    const definition = entry.definition.trim();
    if (term.length === 0 || definition.length === 0) {
      fail('invalid_entry', `Entry ${index + 1}: term and definition are required`);
    }
    if (term.length > DICTIONARY_TERM_MAX_LENGTH) {
      fail('invalid_term', `Entry ${index + 1}: term is too long`);
    }
    if (definition.length > DICTIONARY_DEFINITION_MAX_LENGTH) {
      fail('invalid_definition', `Entry ${index + 1}: definition is too long`);
    }
    const aliases = normalizeAliases(entry.aliases);
    if (aliases.length > DICTIONARY_MAX_ALIASES) {
      fail('invalid_alias', `Entry ${index + 1}: too many aliases`);
    }
    for (const alias of aliases) {
      if (alias.length > DICTIONARY_ALIAS_MAX_LENGTH) {
        fail('invalid_alias', `Entry ${index + 1}: alias is too long`);
      }
    }
    return { term, definition, aliases, scope: target.scope, chatId: target.chatId, enabled: entry.enabled };
  });
}

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

export function encodeDictionaryCsv(entries: readonly DictionaryEntryRecord[]): string {
  const lines = [CSV_HEADER.join(',')];
  for (const entry of entries) {
    lines.push(
      [
        csvCell(entry.term),
        csvCell(entry.definition),
        csvCell(encodeAliasCell(entry.aliases)),
        entry.enabled ? 'true' : 'false',
      ].join(','),
    );
  }
  return `${lines.join('\n')}\n`;
}

export function encodeDictionaryJsonl(entries: readonly DictionaryEntryRecord[]): string {
  return `${entries
    .map((entry) =>
      JSON.stringify({
        term: entry.term,
        definition: entry.definition,
        aliases: entry.aliases,
        enabled: entry.enabled,
      }),
    )
    .join('\n')}\n`;
}

export function encodeDictionaryExport(format: DictionaryFormat, entries: readonly DictionaryEntryRecord[]): string {
  return format === 'csv' ? encodeDictionaryCsv(entries) : encodeDictionaryJsonl(entries);
}

export function exportFileName(scope: DictionaryScope, chatId: bigint | null, format: DictionaryFormat): string {
  const suffix = scope === 'group' && chatId !== null ? `-${chatId.toString()}` : '';
  return `dictionary-${scope}${suffix}.${format}`;
}
