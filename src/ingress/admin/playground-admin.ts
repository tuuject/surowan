/**
 * The Admin panel's Playground API: rooms, identities, the held-input timeline,
 * Release/retry, local pictures and the scoped invocation audit.
 *
 * Everything here is a session-authenticated route; the server router only
 * dispatches after the panel session is resolved, and programmatic API keys
 * never reach it (their permission面 stays Invocation read/replay). Reads never
 * start a run or a generation: opening a Release or retrying an attempt is the
 * caller's explicit action, and every one of them carries a request key so a
 * lost response is answered by the original result instead of a second run.
 *
 * Identifiers are decimal internal ids in paths and bodies; a value that is not
 * the canonical form of an id (kind prefix, sign, leading zero, out of int64)
 * is refused before it reaches the store, and a nested id must belong to the
 * room in the path or it reads as not found.
 */
import Type from 'typebox';
import { Compile } from 'typebox/compile';
import { LocalAssetRejected, type PlaygroundAssetStore } from '../../capabilities/media/local-assets.ts';
import type { PlaygroundIngress } from '../../ingress/playground.ts';
import {
  PlaygroundError,
  type PlaygroundStore,
  type RoomInvocationSummary,
  type RoomMember,
  type RoomState,
  type RoomStatus,
  type RoomSummary,
} from '../../store/playground.ts';
import type { BusinessStore } from '../../store/store.ts';

export interface PlaygroundAdminDeps {
  readonly store: BusinessStore;
  readonly rooms: PlaygroundStore;
  readonly ingress: PlaygroundIngress;
  readonly assets: PlaygroundAssetStore;
}

export type PlaygroundAdminResponse =
  | { readonly kind: 'json'; readonly status: number; readonly body: unknown }
  | { readonly kind: 'content'; readonly status: number; readonly bytes: Uint8Array; readonly mime: string };

/** Panel-triggered wakes: a queued Release launches without waiting a tick. */
export interface PlaygroundAdminContext {
  readonly username: string;
  readonly wake: () => void;
}

/** Room titles and identity names: printable, bounded, no control characters. */
const NAME_TEXT = Type.String({ minLength: 1, maxLength: 120, pattern: '^[^\\u0000-\\u001f\\u007f]+$' });
const REQUEST_KEY = Type.String({ minLength: 1, maxLength: 128, pattern: '^[a-zA-Z0-9_.:-]+$' });
/** A canonical unsigned int64 in decimal: no sign, no leading zero. */
const DECIMAL_ID = Type.String({ pattern: '^(0|[1-9][0-9]{0,18})$' });
const ROLE = Type.Union([Type.Literal('member'), Type.Literal('admin')]);
const RESOURCE_ID = Type.String({ pattern: '^[1-9][0-9]{0,18}$' });
/** One message may carry at most four pictures, matching the input limit. */
const MAX_MESSAGE_IMAGES = 4;
/** A room picture is at most 10 MiB; base64 adds a third, so this is the cap. */
const MAX_UPLOAD_TEXT_BYTES = 15_000_000;
/** Text length limit of one message, in characters (UTF-16 code units). */
const MAX_MESSAGE_TEXT = 16_384;
/**
 * The read limit is in encoded bytes while the text limit is in characters: a
 * `\uXXXX` escape spends six bytes on one code unit, so the worst valid text
 * plus the other fields still fits.
 */
const MAX_MESSAGE_BODY_BYTES = MAX_MESSAGE_TEXT * 6 + 8_192;
/** SQLite INTEGER is a signed 64-bit value; a larger id cannot be bound. */
const MAX_ID = 9_223_372_036_854_775_807n;

const createRoomValidator = Compile(
  Type.Object(
    {
      title: NAME_TEXT,
      members: Type.Optional(
        Type.Array(Type.Object({ name: NAME_TEXT, role: Type.Optional(ROLE) }, { additionalProperties: false }), {
          maxItems: 64,
        }),
      ),
      request_key: REQUEST_KEY,
    },
    { additionalProperties: false },
  ),
);
const participantValidator = Compile(
  Type.Object(
    {
      name: NAME_TEXT,
      role: Type.Optional(ROLE),
      request_key: REQUEST_KEY,
    },
    { additionalProperties: false },
  ),
);
const messageValidator = Compile(
  Type.Object(
    {
      request_key: REQUEST_KEY,
      sender_id: RESOURCE_ID,
      text: Type.Optional(Type.String({ maxLength: MAX_MESSAGE_TEXT })),
      reply_to_seq: Type.Optional(Type.Union([RESOURCE_ID, Type.Null()])),
      asset_ids: Type.Optional(
        Type.Array(Type.String({ minLength: 32, maxLength: 32, pattern: '^[a-f0-9]{32}$' }), {
          maxItems: MAX_MESSAGE_IMAGES,
        }),
      ),
    },
    { additionalProperties: false },
  ),
);
const releaseValidator = Compile(
  Type.Object(
    {
      request_key: REQUEST_KEY,
      revision: DECIMAL_ID,
      // A room with no admitted input releases through seq 0: the boundary is a
      // count, not an identity, so zero is a valid value here.
      through_seq: DECIMAL_ID,
    },
    { additionalProperties: false },
  ),
);
const retryValidator = Compile(Type.Object({ attempt_key: REQUEST_KEY }, { additionalProperties: false }));
const capabilitiesValidator = Compile(
  Type.Object({ image_enabled: Type.Boolean(), revision: DECIMAL_ID }, { additionalProperties: false }),
);
const uploadValidator = Compile(
  Type.Object(
    {
      content_base64: Type.String({ minLength: 1, maxLength: MAX_UPLOAD_TEXT_BYTES }),
      mime: Type.String({ minLength: 1, maxLength: 80 }),
      name: Type.Optional(Type.String({ maxLength: 120 })),
    },
    { additionalProperties: false },
  ),
);

/** Domain refusals map onto HTTP the way the panel shows them. */
const STATUS_BY_CODE: Readonly<Record<string, number>> = {
  room_not_found: 404,
  unknown_release: 404,
  unknown_sender: 404,
  unknown_asset: 404,
  unknown_input: 404,
  room_revision_mismatch: 409,
  release_conflict: 409,
  retry_refused: 409,
  input_conflict: 409,
  room_not_held: 409,
};

class PlaygroundAdminError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/**
 * Validates one request body against its schema. The validator's own type
 * predicate is kept in the signature, so a checked body is the schema's type
 * without an assertion.
 */
function requireValid<T>(validator: { Check(value: unknown): value is T }, value: unknown, label: string): T {
  if (!validator.Check(value)) {
    throw new PlaygroundAdminError('invalid_body', `${label} is invalid`, 400);
  }
  return value;
}

/** Room state plus the counters a list row carries; both shapes are accepted. */
type RoomJsonInput = RoomState & {
  readonly memberCount?: number;
  readonly heldCount?: number;
  readonly queuedInvocations?: number;
  readonly runningInvocations?: number;
  readonly createdAt?: string;
};

function roomJson(room: RoomJsonInput) {
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

function memberJson(member: RoomMember) {
  return { id: member.senderId.toString(), name: member.name, role: member.role };
}

function invocationJson(invocation: RoomInvocationSummary) {
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
  };
}

export function createPlaygroundAdminHandler(deps: PlaygroundAdminDeps) {
  const { rooms, ingress, assets } = deps;

  /** The room in the path, or a 404 that matches an unknown room exactly. */
  const requireRoom = (chatId: bigint): RoomSummary => {
    try {
      return rooms.roomSummary(chatId);
    } catch (error) {
      if (error instanceof PlaygroundError && error.code === 'room_not_found') {
        throw new PlaygroundAdminError('not_found', error.message, 404);
      }
      throw error;
    }
  };

  const roomDetail = (room: RoomSummary) => {
    const status = rooms.status(room.chatId);
    return {
      room: {
        ...roomJson(room),
        pending: status.held.length,
        expired_inputs: status.expiredInputs,
      },
      participants: rooms.members(room.chatId).map(memberJson),
      held: status.held.map((input) => ({
        input_id: input.inputId.toString(),
        seq: input.seq.toString(),
        message_id: input.messageId.toString(),
        sender_id: input.senderId.toString(),
        text: input.text,
        created_at: input.createdAt,
      })),
      staged_assets: rooms.stagedAssets(room.chatId).map((asset) => ({
        asset_id: asset.assetId,
        mime: asset.mime,
        byte_size: asset.byteSize,
        sha256: asset.sha256,
        created_at: asset.createdAt,
      })),
      releases: status.releases.map((release) => ({
        id: release.id.toString(),
        revision: release.revision.toString(),
        through_seq: release.throughSeq.toString(),
        invocation_id: release.invocationId?.toString() ?? null,
        invocation_state: release.invocationState,
        invocation_error_code: release.invocationErrorCode,
        created_at: release.createdAt,
      })),
    };
  };

  return async function handle(
    request: Request,
    segments: readonly string[],
    url: URL,
    context: PlaygroundAdminContext,
    readBody: (maxBytes?: number) => Promise<Record<string, unknown>>,
  ): Promise<PlaygroundAdminResponse> {
    const method = request.method;
    // Segments start after `/api/playground`: rooms / <id> / <nested> / <id> / <action>.
    const [resource, roomId, nested, nestedId, action] = segments;
    const jsonOk = (body: unknown, status = 200): PlaygroundAdminResponse => ({ kind: 'json', status, body });

    try {
      if (resource !== 'rooms') {
        return jsonOk({ error: 'not_found', message: 'Unknown playground route' }, 404);
      }

      // ---- rooms ----------------------------------------------------------
      if (roomId === undefined) {
        if (method === 'GET') {
          return jsonOk({ items: rooms.listRooms().map((room) => roomJson(room)) });
        }
        if (method === 'POST') {
          const body = requireValid(createRoomValidator, await readBody(), 'room creation');
          const created = rooms.createRoomWithKey({
            title: body.title,
            ...(body.members === undefined ? {} : { members: body.members }),
            requestKey: body.request_key,
          });
          return jsonOk({ room: roomJson(created.room), replayed: created.replayed }, created.replayed ? 200 : 201);
        }
        return jsonOk({ error: 'method_not_allowed', message: 'Rooms support GET and POST' }, 405);
      }

      const room = requireRoom(canonicalId(roomId, 'invalid_room_id', 'room id'));

      if (nested === undefined) {
        if (method === 'GET') {
          return jsonOk(roomDetail(room));
        }
        return jsonOk({ error: 'method_not_allowed', message: 'A room supports GET' }, 405);
      }

      // ---- participants ---------------------------------------------------
      if (nested === 'participants' && nestedId === undefined) {
        if (method !== 'POST') {
          return jsonOk({ error: 'method_not_allowed', message: 'Participants supports POST' }, 405);
        }
        const body = requireValid(participantValidator, await readBody(), 'participant');
        const added = rooms.addParticipantWithKey(room.chatId, {
          name: body.name,
          ...(body.role === undefined ? {} : { role: body.role }),
          requestKey: body.request_key,
        });
        return jsonOk({ member: memberJson(added.member), replayed: added.replayed }, added.replayed ? 200 : 201);
      }

      // ---- messages -------------------------------------------------------
      if (nested === 'messages' && nestedId === undefined) {
        if (method === 'GET') {
          const before = url.searchParams.get('before');
          const limit = parseLimit(url.searchParams.get('limit'));
          const page = rooms.timeline(room.chatId, {
            ...(before === null ? {} : { beforeSeq: canonicalId(before, 'invalid_before', 'before') }),
            limit,
          });
          return jsonOk({
            items: page.items.map((entry) => ({
              message_id: entry.messageId.toString(),
              seq: entry.seq.toString(),
              sent_by_bot: entry.sentByBot,
              created_at: entry.createdAt,
              kind: entry.kind,
              text: entry.text,
              caption: entry.caption,
              sender:
                entry.senderId === null
                  ? null
                  : { id: entry.senderId.toString(), name: entry.senderName, is_bot: entry.senderIsBot },
              reply_to_message_id: entry.replyToMessageId?.toString() ?? null,
              reply_to_seq: entry.replyToSeq?.toString() ?? null,
              input_state: entry.inputState,
              send_state: entry.sendState,
              media: entry.media.map((item) => ({
                media_id: item.id.toString(),
                kind: item.kind,
                mime: item.mimeType,
                width: item.width?.toString() ?? null,
                height: item.height?.toString() ?? null,
                asset_id: item.assetId,
              })),
            })),
            has_more: page.hasMore,
            status: roomStatusJson(rooms.status(room.chatId)),
          });
        }
        if (method === 'POST') {
          // A message may carry 16K characters of text plus four asset ids, so
          // it gets its own read limit instead of the 8 KiB default.
          const body = requireValid(messageValidator, await readBody(MAX_MESSAGE_BODY_BYTES), 'message');
          const result = await ingress.submit(room.chatId, {
            requestKey: body.request_key,
            senderId: body.sender_id,
            text: body.text ?? '',
            ...(body.reply_to_seq === undefined ? {} : { replyToSeq: body.reply_to_seq }),
            ...(body.asset_ids === undefined ? {} : { assetIds: body.asset_ids }),
          });
          return jsonOk(
            {
              input_id: result.inputId.toString(),
              seq: result.seq.toString(),
              revision: result.revision.toString(),
              admitted: result.admitted,
            },
            result.admitted ? 201 : 200,
          );
        }
        return jsonOk({ error: 'method_not_allowed', message: 'Messages support GET and POST' }, 405);
      }

      // ---- hold -----------------------------------------------------------
      if (nested === 'hold' && nestedId === undefined) {
        if (method !== 'PUT') {
          return jsonOk({ error: 'method_not_allowed', message: 'Hold supports PUT' }, 405);
        }
        // The endpoint takes no body: a request without one simply opens the
        // hold, and a request that carries one is read (so `{hold:false}` is
        // refused instead of silently ignored).
        const body = request.body === null ? {} : await readBody();
        if ('hold' in body && body.hold !== true) {
          throw new PlaygroundAdminError(
            'release_required',
            'closing the hold is a Release; PUT /hold only opens it',
            400,
          );
        }
        return jsonOk({ room: roomJson(rooms.hold(room.chatId)) });
      }

      // ---- releases -------------------------------------------------------
      if (nested === 'releases') {
        if (nestedId === undefined && method === 'POST') {
          const body = requireValid(releaseValidator, await readBody(), 'release');
          const result = ingress.release(room.chatId, {
            releaseKey: body.request_key,
            revision: body.revision,
            throughSeq: body.through_seq,
          });
          if (!result.replayed) {
            context.wake();
          }
          return jsonOk(
            {
              release_id: result.releaseId.toString(),
              through_seq: result.throughSeq.toString(),
              bucket_id: result.bucketId?.toString() ?? null,
              invocation_id: result.invocationId?.toString() ?? null,
              replayed: result.replayed,
            },
            result.replayed ? 200 : 201,
          );
        }
        const releaseId =
          nestedId === undefined ? undefined : canonicalId(nestedId, 'invalid_release_id', 'release id');
        if (releaseId !== undefined && action === undefined) {
          if (method !== 'GET') {
            return jsonOk({ error: 'method_not_allowed', message: 'A release supports GET' }, 405);
          }
          const detail = rooms.releaseDetail(room.chatId, releaseId);
          if (detail === undefined) {
            throw new PlaygroundAdminError('not_found', `release ${nestedId} does not exist`, 404);
          }
          return jsonOk({
            release: {
              id: detail.release.id.toString(),
              revision: detail.release.revision.toString(),
              through_seq: detail.release.throughSeq.toString(),
              bucket_id: detail.release.bucketId?.toString() ?? null,
              invocation_id: detail.release.invocationId?.toString() ?? null,
              created_at: detail.release.createdAt,
            },
            attempts: detail.attempts.map(invocationJson),
            sends: detail.sends.map((send) => ({
              id: send.id.toString(),
              invocation_id: send.invocationId.toString(),
              kind: send.kind,
              state: send.state,
              message_id: send.messageId?.toString() ?? null,
              error_code: send.errorCode,
              created_at: send.createdAt,
              finished_at: send.finishedAt,
            })),
          });
        }
        if (releaseId !== undefined && action === 'retry' && method === 'POST') {
          const body = requireValid(retryValidator, await readBody(), 'retry');
          const result = ingress.retry(room.chatId, { releaseId, attemptKey: body.attempt_key });
          if (!result.replayed) {
            context.wake();
          }
          return jsonOk(
            {
              retry_id: result.retryId.toString(),
              invocation_id: result.invocationId.toString(),
              bucket_id: result.bucketId.toString(),
              replayed: result.replayed,
            },
            result.replayed ? 200 : 201,
          );
        }
        return jsonOk({ error: 'not_found', message: 'Unknown release route' }, 404);
      }

      // ---- assets ---------------------------------------------------------
      if (nested === 'assets') {
        if (nestedId === undefined) {
          if (method === 'GET') {
            return jsonOk({
              items: rooms.stagedAssets(room.chatId).map((asset) => ({
                asset_id: asset.assetId,
                mime: asset.mime,
                byte_size: asset.byteSize,
                sha256: asset.sha256,
                created_at: asset.createdAt,
              })),
            });
          }
          if (method === 'POST') {
            const body = requireValid(uploadValidator, await readBody(MAX_UPLOAD_TEXT_BYTES + 8_192), 'upload');
            const bytes = Buffer.from(body.content_base64, 'base64');
            const asset = await assets.ingest(room.chatId, {
              bytes,
              declaredMime: body.mime,
              ...(body.name === undefined ? {} : { name: body.name }),
            });
            return jsonOk(
              {
                asset_id: asset.id,
                mime: asset.mime,
                width: asset.width,
                height: asset.height,
                byte_size: asset.byteSize,
                sha256: asset.sha256,
              },
              201,
            );
          }
          return jsonOk({ error: 'method_not_allowed', message: 'Assets support GET and POST' }, 405);
        }
        if (action === 'content' && method === 'GET') {
          const asset = assets.assetFor(room.chatId, nestedId);
          if (asset === null) {
            throw new PlaygroundAdminError('not_found', `asset ${nestedId} does not exist in this room`, 404);
          }
          const bytes = await assets.read(asset.id);
          if (bytes === null) {
            throw new PlaygroundAdminError('not_found', `asset ${nestedId} has no file`, 404);
          }
          return { kind: 'content', status: 200, bytes, mime: asset.mime };
        }
        return jsonOk({ error: 'not_found', message: 'Unknown asset route' }, 404);
      }

      // ---- capabilities ---------------------------------------------------
      if (nested === 'capabilities' && nestedId === undefined) {
        if (method !== 'PUT') {
          return jsonOk({ error: 'method_not_allowed', message: 'Capabilities supports PUT' }, 405);
        }
        const body = requireValid(capabilitiesValidator, await readBody(), 'capabilities');
        const updated = rooms.setImageEnabled(room.chatId, {
          enabled: body.image_enabled,
          actor: context.username,
          revision: canonicalId(body.revision, 'invalid_body', 'revision', { allowZero: true }),
        });
        return jsonOk({ room: roomJson(updated) });
      }

      // ---- invocations ----------------------------------------------------
      if (nested === 'invocations') {
        if (nestedId === undefined) {
          if (method !== 'GET') {
            return jsonOk({ error: 'method_not_allowed', message: 'Invocations supports GET' }, 405);
          }
          return jsonOk({
            items: rooms.roomInvocations(room.chatId, parseLimit(url.searchParams.get('limit'))).map(invocationJson),
          });
        }
        const invocationId = canonicalId(nestedId, 'invalid_invocation_id', 'invocation id');
        if (method !== 'GET') {
          return jsonOk({ error: 'method_not_allowed', message: 'An invocation supports GET' }, 405);
        }
        const found = rooms.roomInvocation(room.chatId, invocationId);
        if (found === undefined) {
          throw new PlaygroundAdminError('not_found', `invocation ${nestedId} does not belong to this room`, 404);
        }
        return jsonOk({ invocation: invocationJson(found) });
      }

      return jsonOk({ error: 'not_found', message: 'Unknown playground route' }, 404);
    } catch (error) {
      return playgroundErrorResponse(error);
    }
  };
}

/** Room counters as the status half of a poll response. */
function roomStatusJson(status: RoomStatus) {
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
function canonicalId(value: string, code: string, label: string, options: { readonly allowZero?: boolean } = {}) {
  const pattern = options.allowZero === true ? /^(0|[1-9][0-9]{0,18})$/ : /^[1-9][0-9]{0,18}$/;
  if (!pattern.test(value) || BigInt(value) > MAX_ID) {
    throw new PlaygroundAdminError(code, `${label} must be a canonical decimal id`, 400);
  }
  return BigInt(value);
}

function parseLimit(value: string | null): number {
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

function playgroundErrorResponse(error: unknown): PlaygroundAdminResponse {
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
