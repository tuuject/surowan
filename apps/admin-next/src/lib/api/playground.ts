import { call, postJson } from './core.ts';

// ---------------------------------------------------------------------------
// Playground (virtual rooms)
// ---------------------------------------------------------------------------
/** One room as the list and the detail header show it. */
export interface PlaygroundRoom {
  readonly id: string;
  readonly title: string;
  readonly revision: string;
  readonly hold: boolean;
  readonly next_seq: string;
  /** Seq of the latest admitted input; a Release names its boundary with it. */
  readonly latest_input_seq: string;
  readonly image_enabled: boolean;
  readonly image_enabled_by: string | null;
  readonly image_enabled_at: string | null;
  readonly member_count?: number;
  readonly held_count?: number;
  readonly queued_invocations?: number;
  readonly running_invocations?: number;
  /** Detail only: held inputs right now and inputs retention already expired. */
  readonly pending?: number;
  readonly expired_inputs?: number;
}

export interface PlaygroundParticipant {
  readonly id: string;
  readonly name: string;
  readonly role: 'member' | 'admin';
}

export interface PlaygroundMedia {
  readonly media_id: string;
  readonly kind: string;
  readonly mime: string | null;
  readonly width: string | null;
  readonly height: string | null;
  /** Local asset of this room; content is fetched from the asset endpoint. */
  readonly asset_id: string | null;
}

export interface PlaygroundTimelineItem {
  readonly message_id: string;
  readonly seq: string;
  readonly sent_by_bot: boolean;
  readonly created_at: string;
  readonly kind: string;
  readonly text: string | null;
  readonly caption: string | null;
  readonly sender: { readonly id: string; readonly name: string | null; readonly is_bot: boolean } | null;
  readonly reply_to_message_id: string | null;
  readonly reply_to_seq: string | null;
  /** `held` / `released` / `expired` for an admitted input, null for output. */
  readonly input_state: string | null;
  /** `pending` / `success` / `error` / `outcome_unknown` for bot output. */
  readonly send_state: string | null;
  readonly media: readonly PlaygroundMedia[];
}

export interface PlaygroundStatusSummary {
  readonly revision: string;
  readonly hold: boolean;
  readonly next_seq: string;
  readonly latest_input_seq: string;
  readonly image_enabled: boolean;
  readonly pending: number;
  readonly expired_inputs: number;
}

export interface PlaygroundTimeline {
  readonly items: readonly PlaygroundTimelineItem[];
  readonly has_more: boolean;
  readonly status: PlaygroundStatusSummary;
}

export interface PlaygroundHeldInput {
  readonly input_id: string;
  readonly seq: string;
  readonly message_id: string;
  readonly sender_id: string;
  readonly text: string;
  readonly created_at: string;
}

export interface PlaygroundStagedAsset {
  readonly asset_id: string;
  readonly mime: string;
  readonly byte_size: number;
  readonly sha256: string;
  readonly created_at: string;
}

export interface PlaygroundReleaseSummary {
  readonly id: string;
  readonly revision: string;
  readonly through_seq: string;
  readonly invocation_id: string | null;
  readonly invocation_state: string | null;
  readonly invocation_error_code: string | null;
  readonly created_at: string;
}

export interface PlaygroundRoomDetail {
  readonly room: PlaygroundRoom;
  readonly participants: readonly PlaygroundParticipant[];
  readonly held: readonly PlaygroundHeldInput[];
  readonly staged_assets: readonly PlaygroundStagedAsset[];
  readonly releases: readonly PlaygroundReleaseSummary[];
}

export interface PlaygroundInvocation {
  readonly id: string;
  readonly state: string;
  readonly error_code: string | null;
  readonly completion_reason: string | null;
  readonly created_at: string;
  readonly started_at: string | null;
  readonly finished_at: string | null;
  readonly sends_used: number;
  readonly tool_calls_used: number;
  readonly side_effect_started: boolean;
  readonly total_tokens: number;
  readonly total_cost: number | null;
  readonly receipt_state: string | null;
  readonly receipt_status: string | null;
  readonly retry_of_invocation_id: string | null;
  /** The Release this attempt belongs to; a retry is addressed by it. */
  readonly release_id: string | null;
}

export interface PlaygroundSend {
  readonly id: string;
  readonly invocation_id: string;
  readonly kind: string;
  readonly state: string;
  readonly message_id: string | null;
  readonly error_code: string | null;
  readonly created_at: string;
  readonly finished_at: string | null;
}

export interface PlaygroundReleaseDetail {
  readonly release: {
    readonly id: string;
    readonly revision: string;
    readonly through_seq: string;
    readonly bucket_id: string | null;
    readonly invocation_id: string | null;
    readonly created_at: string;
  };
  readonly attempts: readonly PlaygroundInvocation[];
  readonly sends: readonly PlaygroundSend[];
}

export interface PlaygroundSubmitResult {
  readonly input_id: string;
  readonly seq: string;
  readonly revision: string;
  readonly admitted: boolean;
}

export interface PlaygroundReleaseResult {
  readonly release_id: string;
  readonly through_seq: string;
  readonly bucket_id: string | null;
  readonly invocation_id: string | null;
  readonly replayed: boolean;
}

export interface PlaygroundUploadResult {
  readonly asset_id: string;
  readonly mime: string;
  readonly width: number;
  readonly height: number;
  readonly byte_size: number;
  readonly sha256: string;
}

export function listPlaygroundRooms(): Promise<{ readonly items: readonly PlaygroundRoom[] }> {
  return call<{ readonly items: readonly PlaygroundRoom[] }>('/playground/rooms');
}

export function createPlaygroundRoom(body: {
  readonly title: string;
  readonly members?: readonly { readonly name: string; readonly role?: 'member' | 'admin' }[];
  readonly request_key: string;
}): Promise<{ readonly room: PlaygroundRoom; readonly replayed: boolean }> {
  return postJson<{ readonly room: PlaygroundRoom; readonly replayed: boolean }>('/playground/rooms', body);
}

export function getPlaygroundRoom(roomId: string): Promise<PlaygroundRoomDetail> {
  return call<PlaygroundRoomDetail>(`/playground/rooms/${encodeURIComponent(roomId)}`);
}

export function addPlaygroundParticipant(
  roomId: string,
  body: { readonly name: string; readonly role?: 'member' | 'admin'; readonly request_key: string },
): Promise<{ readonly member: PlaygroundParticipant; readonly replayed: boolean }> {
  return postJson<{ readonly member: PlaygroundParticipant; readonly replayed: boolean }>(
    `/playground/rooms/${encodeURIComponent(roomId)}/participants`,
    body,
  );
}

export function listPlaygroundMessages(
  roomId: string,
  options: { readonly before?: string; readonly limit?: number } = {},
): Promise<PlaygroundTimeline> {
  const params = new URLSearchParams();
  if (options.before !== undefined) {
    params.set('before', options.before);
  }
  if (options.limit !== undefined) {
    params.set('limit', String(options.limit));
  }
  const suffix = params.size === 0 ? '' : `?${params.toString()}`;
  return call<PlaygroundTimeline>(`/playground/rooms/${encodeURIComponent(roomId)}/messages${suffix}`);
}

export function submitPlaygroundMessage(
  roomId: string,
  body: {
    readonly request_key: string;
    readonly sender_id: string;
    readonly text: string;
    readonly reply_to_seq?: string | null;
    readonly asset_ids?: readonly string[];
  },
): Promise<PlaygroundSubmitResult> {
  return postJson<PlaygroundSubmitResult>(`/playground/rooms/${encodeURIComponent(roomId)}/messages`, body);
}

export function holdPlaygroundRoom(roomId: string): Promise<{ readonly room: PlaygroundRoom }> {
  return call<{ readonly room: PlaygroundRoom }>(`/playground/rooms/${encodeURIComponent(roomId)}/hold`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
}

export function releasePlaygroundRoom(
  roomId: string,
  body: { readonly request_key: string; readonly revision: string; readonly through_seq: string },
): Promise<PlaygroundReleaseResult> {
  return postJson<PlaygroundReleaseResult>(`/playground/rooms/${encodeURIComponent(roomId)}/releases`, body);
}

export function getPlaygroundRelease(roomId: string, releaseId: string): Promise<PlaygroundReleaseDetail> {
  return call<PlaygroundReleaseDetail>(
    `/playground/rooms/${encodeURIComponent(roomId)}/releases/${encodeURIComponent(releaseId)}`,
  );
}

export function retryPlaygroundRelease(
  roomId: string,
  releaseId: string,
  body: { readonly attempt_key: string },
): Promise<{
  readonly retry_id: string;
  readonly invocation_id: string;
  readonly bucket_id: string;
  readonly replayed: boolean;
}> {
  return postJson(
    `/playground/rooms/${encodeURIComponent(roomId)}/releases/${encodeURIComponent(releaseId)}/retry`,
    body,
  );
}

export function uploadPlaygroundAsset(
  roomId: string,
  body: { readonly content_base64: string; readonly mime: string; readonly name?: string },
): Promise<PlaygroundUploadResult> {
  return postJson<PlaygroundUploadResult>(`/playground/rooms/${encodeURIComponent(roomId)}/assets`, body);
}

/** Content URL of one room asset; the endpoint requires the panel session. */
export function playgroundAssetUrl(roomId: string, assetId: string): string {
  return `/api/playground/rooms/${encodeURIComponent(roomId)}/assets/${encodeURIComponent(assetId)}/content`;
}

export function listPlaygroundInvocations(
  roomId: string,
  limit = 20,
): Promise<{ readonly items: readonly PlaygroundInvocation[] }> {
  return call<{ readonly items: readonly PlaygroundInvocation[] }>(
    `/playground/rooms/${encodeURIComponent(roomId)}/invocations?limit=${String(limit)}`,
  );
}

export function setPlaygroundCapabilities(
  roomId: string,
  body: { readonly image_enabled: boolean; readonly revision: string },
): Promise<{ readonly room: PlaygroundRoom }> {
  return call<{ readonly room: PlaygroundRoom }>(`/playground/rooms/${encodeURIComponent(roomId)}/capabilities`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
