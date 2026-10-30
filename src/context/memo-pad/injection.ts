import { escapeXml } from '../../platform/spoilers.ts';
import type { ContextHeader } from '../store.ts';
import { MEMO_INJECTION_TOKEN_RATIO, type MemoEntry, type MemoStateEntry, type MemoStateUpdate } from './index.ts';
import type { MemoPadStore } from './store.ts';

export interface MemoInjectionInput {
  readonly chatId: bigint;
  readonly header: ContextHeader;
  readonly seq: bigint;
  readonly contextWindow: number;
  readonly now?: Date;
}

export interface MemoInjectionResult {
  /** Full list for `<runtime_state>`; empty unless this batch refreshes. */
  readonly listText: string;
  /** Tail delta after the newest messages; empty unless this batch announces changes. */
  readonly deltaText: string;
  /** `null` when the announced state did not change. */
  readonly state: MemoStateUpdate | null;
}

/**
 * Builds the short-term memory part of one injection.
 *
 * The full list is rendered only when the retained window no longer carries a
 * previous one (first batch, Context rebuild, or the list's batch was collected
 * away) or when a refresh was explicitly requested. Every other batch carries a
 * tail delta. The state is computed here but committed only when the batch is
 * persisted, so a batch that never reaches canonical history cannot claim its
 * changes were announced.
 */
export function renderMemoInjection(memoPad: MemoPadStore, input: MemoInjectionInput): MemoInjectionResult {
  const now = input.now ?? new Date();
  const entries = memoPad.shortTerm(input.chatId, now);
  const current: MemoStateEntry[] = entries.map((entry) => ({
    id: entry.id,
    summary: entry.summary,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  }));
  const currentJson = JSON.stringify(current);
  const budget = Math.max(0, Math.floor(input.contextWindow * MEMO_INJECTION_TOKEN_RATIO));
  const refresh =
    input.header.memoRefreshPending ||
    input.header.memoRefreshSeq === null ||
    input.header.memoRefreshSeq < input.header.headSeq;
  if (refresh) {
    return {
      listText: renderMemoList(entries, budget),
      deltaText: '',
      state: { refreshSeq: input.seq, stateJson: currentJson, pending: false },
    };
  }
  const delta = renderMemoDelta(parseMemoState(input.header.memoStateJson), current, budget);
  // Dropped change lines MUST NOT be marked as announced; leave the state
  // alone so the next batch (or a later refresh) can still surface them.
  if (delta.omitted > 0) {
    return { listText: '', deltaText: delta.text, state: null };
  }
  if (currentJson === input.header.memoStateJson) {
    return { listText: '', deltaText: delta.text, state: null };
  }
  return {
    listText: '',
    deltaText: delta.text,
    state: { refreshSeq: input.header.memoRefreshSeq ?? input.seq, stateJson: currentJson, pending: false },
  };
}

/** Full list, oldest first; the oldest entries are hidden until the budget fits. */
export function renderMemoList(entries: readonly MemoEntry[], maximumCharacters: number): string {
  if (entries.length === 0) {
    return '';
  }
  const lines = entries.map((entry) => `- ${entry.id}: ${summaryLine(entry.summary)}`);
  let hidden = 0;
  const build = (): string =>
    [
      '<memo_list>',
      ...lines,
      ...(hidden === 0
        ? []
        : [`[${hidden} earlier short-term memories are not shown; use search_memory to find them]`]),
      '</memo_list>',
    ].join('\n');
  while (lines.length > 0 && build().length > maximumCharacters) {
    lines.shift();
    hidden += 1;
  }
  return build().length <= maximumCharacters ? build() : '';
}

/** Tail delta against the last announced state; empty when nothing changed. */
export function renderMemoDelta(
  previous: readonly MemoStateEntry[],
  current: readonly MemoStateEntry[],
  maximumCharacters: number,
): { readonly text: string; readonly omitted: number } {
  const before = new Map(previous.map((entry) => [entry.id, entry]));
  const after = new Map(current.map((entry) => [entry.id, entry]));
  const lines: string[] = [];
  for (const entry of current) {
    const old = before.get(entry.id);
    if (old === undefined) {
      lines.push(`+ ${entry.id}: ${summaryLine(entry.summary)}`);
    } else if (old.updatedAt !== entry.updatedAt || old.summary !== entry.summary) {
      lines.push(`~ ${entry.id}: ${summaryLine(entry.summary)}`);
    }
  }
  for (const entry of previous) {
    if (!after.has(entry.id)) {
      lines.push(`- ${entry.id}: ${summaryLine(entry.summary)}`);
    }
  }
  if (lines.length === 0) {
    return { text: '', omitted: 0 };
  }
  let omitted = 0;
  const build = (): string =>
    [
      '<memo_updates>',
      ...lines,
      ...(omitted === 0 ? [] : [`[${omitted} earlier memory changes omitted]`]),
      '</memo_updates>',
    ].join('\n');
  while (lines.length > 1 && build().length > maximumCharacters) {
    lines.shift();
    omitted += 1;
  }
  if (build().length > maximumCharacters) {
    return { text: '', omitted };
  }
  return { text: build(), omitted };
}

function parseMemoState(json: string | null): MemoStateEntry[] {
  if (json === null) {
    return [];
  }
  try {
    const value: unknown = JSON.parse(json);
    if (!Array.isArray(value)) {
      return [];
    }
    return value.filter(isMemoStateEntry);
  } catch {
    return [];
  }
}

function isMemoStateEntry(entry: unknown): entry is MemoStateEntry {
  if (typeof entry !== 'object' || entry === null) {
    return false;
  }
  return (
    'id' in entry &&
    typeof entry.id === 'string' &&
    'summary' in entry &&
    typeof entry.summary === 'string' &&
    'createdAt' in entry &&
    typeof entry.createdAt === 'string' &&
    'updatedAt' in entry &&
    typeof entry.updatedAt === 'string'
  );
}

/** One-line, XML-escaped summary: the list is line-oriented and untrusted. */
function summaryLine(summary: string): string {
  return escapeXml(summary.replace(/\s+/g, ' ').trim());
}
