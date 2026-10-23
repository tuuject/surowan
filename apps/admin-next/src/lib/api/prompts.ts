import { ApiError, call, writeHeaders } from './core.ts';

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------
/** One prompt layer this panel edits: the global prompt or one configured Chat. */
export type PromptScopeRef = { readonly scope: 'global' } | { readonly scope: 'group'; readonly chat: string };

export type PromptVersionSource = 'panel' | 'external' | 'rollback';

export interface PromptVersionItem {
  readonly id: string;
  readonly scope: string;
  readonly chat_id: string | null;
  readonly seq: string;
  readonly content_hash: string;
  readonly content_chars: number;
  readonly source: PromptVersionSource;
  readonly note: string | null;
  readonly created_by: string | null;
  readonly created_at: string;
}

/** `GET /prompts/global` / `GET /prompts/group`: the configured prompt plus its file metadata. */
export interface PromptDocument {
  readonly scope: string;
  readonly chat_id: string | null;
  /** Group scope only: the configured Chat ID when the request named a migrated one. */
  readonly configured_chat_id?: string;
  readonly prompt: string;
  readonly content_hash: string;
  readonly core_read_only: boolean;
  readonly source: 'active' | 'file';
  readonly generation: number;
  readonly active_hash: string;
  readonly file_hash: string;
  readonly restart_required: readonly string[];
}

export interface PromptVersionsView {
  readonly scope: string;
  readonly chat_id: string | null;
  readonly retained: number;
  readonly current: PromptVersionItem | null;
  /** Newest first. */
  readonly items: readonly PromptVersionItem[];
}

export interface PromptDiffLine {
  readonly type: 'context' | 'removed' | 'added';
  readonly text: string;
  readonly fromLine: number | null;
  readonly toLine: number | null;
}

export interface PromptDiffHunk {
  readonly fromStart: number;
  readonly fromCount: number;
  readonly toStart: number;
  readonly toCount: number;
  readonly lines: readonly PromptDiffLine[];
}

export interface PromptDiffView {
  readonly from: PromptVersionItem;
  readonly to: PromptVersionItem;
  readonly hunks: readonly PromptDiffHunk[];
}

export interface PromptSaveSummary {
  readonly status: 'saved';
  readonly version: PromptVersionItem;
  readonly applied: readonly string[];
  readonly restart_required: readonly string[];
  readonly outside_serve: readonly string[];
  readonly active_hash: string;
  readonly file_hash: string;
  readonly affected_running: number;
  readonly context_rebuild: boolean;
}

/**
 * A prompt identical to the file records nothing. `version` is the version the
 * write would have duplicated, or null when the scope has none yet.
 */
export interface PromptSaveUnchanged {
  readonly status: 'unchanged';
  readonly version: PromptVersionItem | null;
}

export type PromptSaveResponse = PromptSaveSummary | PromptSaveUnchanged;

export interface PromptCancelRunningResult {
  readonly canceled_invocations: number;
  readonly expired_buckets: number;
}

/**
 * The version a failed prompt write still recorded. A config-apply failure
 * answers with `{ error, code, version }` after the prompt file was already
 * written: the version exists, only the running configuration did not move.
 */
export function failedPromptVersion(error: unknown): PromptVersionItem | null {
  if (!(error instanceof ApiError) || error.payload === null || typeof error.payload !== 'object') {
    return null;
  }
  const version = (error.payload as { readonly version?: unknown }).version;
  return version !== null && version !== undefined && typeof version === 'object'
    ? (version as PromptVersionItem)
    : null;
}

export function getPromptDocument(
  reference: PromptScopeRef,
  source: 'active' | 'file' = 'file',
): Promise<PromptDocument> {
  const params = new URLSearchParams({ source });
  if (reference.scope === 'group') {
    params.set('chat', reference.chat);
    return call<PromptDocument>(`/prompts/group?${params.toString()}`);
  }
  return call<PromptDocument>(`/prompts/global?${params.toString()}`);
}

export function getPromptVersions(reference: PromptScopeRef): Promise<PromptVersionsView> {
  const params = new URLSearchParams({ scope: reference.scope });
  if (reference.scope === 'group') {
    params.set('chat', reference.chat);
  }
  return call<PromptVersionsView>(`/prompts/versions?${params.toString()}`);
}

export function getPromptDiff(from: string, to: string): Promise<PromptDiffView> {
  return call<PromptDiffView>(`/prompts/diff?${new URLSearchParams({ from, to }).toString()}`);
}

/**
 * Writes one prompt version. `If-Match` carries the content hash of the
 * `source=file` read, so an edit made elsewhere in between is refused with
 * `409 prompt_conflict` instead of silently overwritten.
 */
export function savePrompt(
  reference: PromptScopeRef,
  body: { readonly prompt: string; readonly note?: string },
  contentHash: string,
): Promise<PromptSaveResponse> {
  const path =
    reference.scope === 'group'
      ? `/prompts/group?${new URLSearchParams({ chat: reference.chat }).toString()}`
      : '/prompts/global';
  return call<PromptSaveResponse>(path, {
    method: 'PUT',
    headers: writeHeaders(contentHash),
    body: JSON.stringify(body),
  });
}

export function restorePromptVersion(
  id: string,
  body: { readonly note?: string },
  contentHash: string,
): Promise<PromptSaveResponse> {
  return call<PromptSaveResponse>(`/prompts/versions/${encodeURIComponent(id)}/restore`, {
    method: 'POST',
    headers: writeHeaders(contentHash),
    body: JSON.stringify(body),
  });
}

export function cancelPromptRunning(reference: PromptScopeRef): Promise<PromptCancelRunningResult> {
  const body =
    reference.scope === 'group' ? { scope: 'group' as const, chat_id: reference.chat } : { scope: 'global' as const };
  return call<PromptCancelRunningResult>('/prompts/cancel-running', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
