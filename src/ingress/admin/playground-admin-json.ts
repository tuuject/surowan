/**
 * The JSON shapes the Playground routes return, plus the parameter parsing and
 * error mapping they share.
 */
import { LocalAssetRejected } from '../../capabilities/media/local-assets.ts';
import type { RoomInvocationSummary, RoomMember, RoomState, RoomStatus } from '../../store/playground.ts';
import type { PlaygroundAdminResponse } from './playground-admin.ts';
import { MAX_ID, PlaygroundAdminError, STATUS_BY_CODE } from './playground-admin-schemas.ts';
import { PlaygroundError } from '../../store/playground/shared.ts';

/** Room state plus the counters a list row carries; both shapes are accepted. */
type RoomJsonInput = RoomState & {
  readonly memberCount?: number;
  readonly heldCount?: number;
  readonly queuedInvocations?: number;
  readonly runningInvocations?: number;
  readonly createdAt?: string;
};

export function roomJson(room: RoomJsonInput) {
  return {
    id: room.chatId.toString(),
    title: room.title,
    revision: room.revision.toString(),
    hold: room.hold,
    next_seq: room.nextSeq.toString(),
    latest_input_seq: room.latestInputSeq.toString(),
    image_enabled: room.imageEnabled,
    image_enabled_by: room.imageEnabledBy,
    image_enabled_at: room.imageEnabledAt,
    ...(room.memberCount === undefined ? {} : { member_count: room.memberCount }),
    ...(room.heldCount === undefined ? {} : { held_count: room.heldCount }),
    ...(room.queuedInvocations === undefined ? {} : { queued_invocations: room.queuedInvocations }),
    ...(room.runningInvocations === undefined ? {} : { running_invocations: room.runningInvocations }),
    ...(room.createdAt === undefined ? {} : { created_at: room.createdAt }),
  };
}

export function memberJson(member: RoomMember) {
  return { id: member.senderId.toString(), name: member.name, role: member.role };
}

export function invocationJson(invocation: RoomInvocationSummary) {
  return {
    id: invocation.id.toString(),
    state: invocation.state,
    error_code: invocation.errorCode,
    completion_reason: invocation.completionReason,
    created_at: invocation.createdAt,
    started_at: invocation.startedAt,
    finished_at: invocation.finishedAt,
    sends_used: invocation.sendsUsed,
    tool_calls_used: invocation.toolCallsUsed,
    side_effect_started: invocation.sideEffectStarted,
    total_tokens: invocation.totalTokens,
    total_cost: invocation.totalCost,
    receipt_state: invocation.receiptState,
    receipt_status: invocation.receiptStatus,
    retry_of_invocation_id: invocation.retryOfInvocationId?.toString() ?? null,
    release_id: invocation.releaseId?.toString() ?? null,
  };
}

/** Room counters as the status half of a poll response. */
export function roomStatusJson(status: RoomStatus) {
  return {
    revision: status.revision.toString(),
    hold: status.hold,
    next_seq: status.nextSeq.toString(),
    latest_input_seq: status.latestInputSeq.toString(),
    image_enabled: status.imageEnabled,
    pending: status.held.length,
    expired_inputs: status.expiredInputs,
  };
}

/**
 * An id or sequence in canonical decimal and within SQLite's int64: a value
 * past it would reach the store as a binding error instead of a refusal.
 */
export function canonicalId(
  value: string,
  code: string,
  label: string,
  options: { readonly allowZero?: boolean } = {},
) {
  const pattern = options.allowZero === true ? /^(0|[1-9][0-9]{0,18})$/ : /^[1-9][0-9]{0,18}$/;
  if (!pattern.test(value) || BigInt(value) > MAX_ID) {
    throw new PlaygroundAdminError(code, `${label} must be a canonical decimal id`, 400);
  }
  return BigInt(value);
}

export function parseLimit(value: string | null): number {
  if (value === null || value.length === 0) {
    return 50;
  }
  if (!/^[1-9][0-9]{0,2}$/.test(value)) {
    throw new PlaygroundAdminError('invalid_limit', 'limit must be a decimal between 1 and 200', 400);
  }
  const limit = Number(value);
  if (limit > 200) {
    throw new PlaygroundAdminError('invalid_limit', 'limit must be a decimal between 1 and 200', 400);
  }
  return limit;
}

export function playgroundErrorResponse(error: unknown): PlaygroundAdminResponse {
  if (error instanceof PlaygroundAdminError) {
    return { kind: 'json', status: error.status, body: { error: error.code, message: error.message } };
  }
  if (error instanceof PlaygroundError) {
    const status = STATUS_BY_CODE[error.code] ?? 400;
    return { kind: 'json', status, body: { error: error.code, message: error.message } };
  }
  if (error instanceof LocalAssetRejected) {
    // A payload the room store refuses is a client problem, not a server one.
    return { kind: 'json', status: 422, body: { error: `upload_${error.reason}`, message: error.message } };
  }
  throw error;
}
