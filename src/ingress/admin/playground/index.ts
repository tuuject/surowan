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
import type { PlaygroundAssetStore } from '../../../capabilities/media/local-assets.ts';
import type { PlaygroundIngress } from '../../playground.ts';
import type { PlaygroundStore, RoomSummary } from '../../../store/playground/index.ts';
import type { BusinessStore } from '../../../store/store.ts';
import {
  canonicalId,
  invocationJson,
  memberJson,
  parseLimit,
  playgroundErrorResponse,
  roomJson,
  roomStatusJson,
} from './json.ts';
import {
  capabilitiesValidator,
  createRoomValidator,
  MAX_MESSAGE_BODY_BYTES,
  MAX_ROOM_BODY_BYTES,
  MAX_UPLOAD_TEXT_BYTES,
  messageValidator,
  participantValidator,
  PlaygroundAdminError,
  releaseValidator,
  requireValid,
  retryValidator,
  uploadValidator,
} from './schemas.ts';
import { PlaygroundError } from '../../../store/playground/shared.ts';

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
      // No route is deeper than five segments; a longer path must not reach a
      // write by its prefix.
      if (resource !== 'rooms' || segments.length > 5) {
        return jsonOk({ error: 'not_found', message: 'Unknown playground route' }, 404);
      }

      // ---- rooms ----------------------------------------------------------
      if (roomId === undefined) {
        if (method === 'GET') {
          return jsonOk({ items: rooms.listRooms().map((room) => roomJson(room)) });
        }
        if (method === 'POST') {
          const body = requireValid(createRoomValidator, await readBody(MAX_ROOM_BODY_BYTES), 'room creation');
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
            const asset = await ingress.upload(room.chatId, {
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
