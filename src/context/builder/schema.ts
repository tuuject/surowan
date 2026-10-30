import Type, { type Static } from 'typebox';
import Compile from 'typebox/compile';
import type { HostKind } from '../../platform/im-host/identity.ts';
import type { ContextRefStore } from '../refs.ts';
import type { ContextHeader } from '../store.ts';

const Strict = { additionalProperties: false } as const;
const RangeArraySchema = Type.Array(
  Type.Object(
    {
      start: Type.Integer(),
      end: Type.Integer(),
    },
    Strict,
  ),
);
const MediaSnapshotSchema = Type.Object(
  {
    id: Type.String(),
    kind: Type.String(),
    file_unique_id: Type.String(),
    mime_type: Type.Union([Type.String(), Type.Null()]),
    width: Type.Union([Type.String(), Type.Null()]),
    height: Type.Union([Type.String(), Type.Null()]),
  },
  Strict,
);
export const MessageSnapshotSchema = Type.Object(
  {
    message_id: Type.String(),
    message_thread_id: Type.Optional(Type.String()),
    telegram_date: Type.String(),
    sent_by_bot: Type.Boolean(),
    revision: Type.String(),
    sender: Type.Object(
      {
        id: Type.Union([Type.String(), Type.Null()]),
        name: Type.Union([Type.String(), Type.Null()]),
        username: Type.Union([Type.String(), Type.Null()]),
      },
      Strict,
    ),
    kind: Type.String(),
    text: Type.Union([Type.String(), Type.Null()]),
    caption: Type.Union([Type.String(), Type.Null()]),
    match_text: Type.Optional(Type.Array(Type.String())),
    spoilers: Type.Optional(
      Type.Object(
        {
          text: Type.Optional(RangeArraySchema),
          caption: Type.Optional(RangeArraySchema),
          reply: Type.Optional(RangeArraySchema),
        },
        Strict,
      ),
    ),
    // Where each of a rich message's media sits in `text`, in media order.
    media_slots: Type.Optional(RangeArraySchema),
    reply_to_message_id: Type.Union([Type.String(), Type.Null()]),
    reply_snapshot: Type.Unknown(),
    forward_origin: Type.Unknown(),
    media_group_id: Type.Union([Type.String(), Type.Null()]),
    media: Type.Array(MediaSnapshotSchema),
  },
  Strict,
);

/** The frozen format a Telegram invocation writes. */
export const TELEGRAM_SNAPSHOT_FORMAT = 'plasticwan.invocation-snapshot.v1';

/** The frozen format a Playground invocation writes. */
export const ROOM_SNAPSHOT_FORMAT = 'plasticwan.invocation-snapshot.playground.v1';

/**
 * A room message as it was frozen for one invocation.
 *
 * A room has no Telegram message id, so `message_id` is the room's own
 * monotonic sequence — the same token the model sees and may reply to. Sender
 * identity is a room-scoped member ref; it is deliberately not a Telegram user
 * id, and core never treats it as one.
 */
export const RoomMessageSnapshotSchema = Type.Object(
  {
    host: Type.Literal('playground'),
    message_id: Type.String(),
    sent_at: Type.String(),
    sent_by_bot: Type.Boolean(),
    revision: Type.String(),
    sender: Type.Object(
      {
        ref: Type.String(),
        name: Type.String(),
        role: Type.Optional(Type.String()),
      },
      Strict,
    ),
    kind: Type.String(),
    text: Type.Union([Type.String(), Type.Null()]),
    caption: Type.Union([Type.String(), Type.Null()]),
    reply_to_message_id: Type.Union([Type.String(), Type.Null()]),
    reply_snapshot: Type.Unknown(),
    media: Type.Array(MediaSnapshotSchema),
  },
  Strict,
);
const snapshotValidator = Compile(MessageSnapshotSchema);
const roomSnapshotValidator = Compile(RoomMessageSnapshotSchema);

export const imageReceiptValidator = Compile(
  Type.Object({
    generation_id: Type.String(),
    outputs: Type.Array(Type.Object({ asset_id: Type.String() })),
  }),
);

type MessageSnapshot = Static<typeof MessageSnapshotSchema>;

export interface PreparedSnapshot extends Omit<MessageSnapshot, 'revision' | 'media'> {
  /** Room-scoped member ref; null for a Telegram message. */
  readonly senderRef?: string | null;
  readonly media: readonly {
    readonly image_ref: string;
    readonly figure?: string;
    readonly kind: string;
    readonly mime_type: string | null;
    readonly width: string | null;
    readonly height: string | null;
  }[];
}

export interface FormatOptions {
  readonly timezone: string;
  readonly now: Date;
  /** Message IDs rendered in the same batch; replies to them skip the quote. */
  readonly inlineReplies: ReadonlySet<string>;
}

export interface ReplySnapshot {
  readonly sender: string;
  readonly content: string;
}

/**
 * Rewrites media snapshots into stable, context-scoped `img_` references.
 * References are created once and reused while they live, so retained history
 * keeps the same tokens instead of re-minting them on every invocation.
 */
export function prepareSnapshot(
  refs: ContextRefStore,
  json: string,
  format: string,
  hostKind: HostKind,
  header: ContextHeader,
  sourceSeq: bigint,
  mediaIds: Map<string, bigint>,
  now: Date,
): PreparedSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('Stored invocation message contains invalid JSON');
  }
  // The frozen row names its format; it must agree with the invocation's
  // host. That keeps a Telegram payload from being read as a room payload
  // (or the reverse) even if a row is copied between hosts.
  const expectedFormat = hostKind === 'telegram' ? TELEGRAM_SNAPSHOT_FORMAT : ROOM_SNAPSHOT_FORMAT;
  if (format !== expectedFormat) {
    throw new Error(`Stored invocation message has format ${format}, expected ${expectedFormat}`);
  }
  const validator = hostKind === 'telegram' ? snapshotValidator : roomSnapshotValidator;
  if (!validator.Check(parsed)) {
    throw new Error('Stored invocation message does not match its schema');
  }
  const payload = parsed as unknown as {
    message_id: string;
    message_thread_id?: string;
    telegram_date: string;
    sent_at: string;
    sent_by_bot: boolean;
    sender: { id: string | null; name: string | null; username: string | null };
    kind: string;
    text: string | null;
    caption: string | null;
    match_text?: MessageSnapshot['match_text'];
    spoilers?: MessageSnapshot['spoilers'];
    media_slots?: MessageSnapshot['media_slots'];
    reply_to_message_id: string | null;
    reply_snapshot: unknown;
    forward_origin: unknown;
    media_group_id: string | null;
    media: Array<{
      id: string;
      kind: string;
      mime_type: string | null;
      width: string | null;
      height: string | null;
    }>;
  };
  const media = payload.media.map((entry) => {
    const mediaId = BigInt(entry.id);
    const reference = refs.mediaRef(header, mediaId, sourceSeq, now);
    mediaIds.set(reference, mediaId);
    return {
      image_ref: reference,
      kind: entry.kind,
      mime_type: entry.mime_type,
      width: entry.width,
      height: entry.height,
    };
  });
  if (hostKind === 'playground') {
    const room = payload as unknown as {
      message_id: string;
      sent_at: string;
      sent_by_bot: boolean;
      sender: { ref: string; name: string };
      kind: string;
      text: string | null;
      caption: string | null;
      reply_to_message_id: string | null;
      reply_snapshot: unknown;
    };
    return {
      message_id: room.message_id,
      telegram_date: room.sent_at,
      sent_by_bot: room.sent_by_bot,
      sender: { id: null, name: room.sender.name, username: null },
      senderRef: room.sender.ref,
      kind: room.kind,
      text: room.text,
      caption: room.caption,
      reply_to_message_id: room.reply_to_message_id,
      reply_snapshot: room.reply_snapshot,
      forward_origin: null,
      media_group_id: null,
      media,
    };
  }
  return {
    message_id: payload.message_id,
    ...(payload.message_thread_id === undefined ? {} : { message_thread_id: payload.message_thread_id }),
    telegram_date: payload.telegram_date,
    sent_by_bot: payload.sent_by_bot,
    sender: payload.sender,
    senderRef: null,
    kind: payload.kind,
    text: payload.text,
    caption: payload.caption,
    ...(payload.match_text === undefined ? {} : { match_text: payload.match_text }),
    ...(payload.spoilers === undefined ? {} : { spoilers: payload.spoilers }),
    ...(payload.media_slots === undefined ? {} : { media_slots: payload.media_slots }),
    reply_to_message_id: payload.reply_to_message_id,
    reply_snapshot: payload.reply_snapshot,
    forward_origin: payload.forward_origin,
    media_group_id: payload.media_group_id,
    media,
  };
}
