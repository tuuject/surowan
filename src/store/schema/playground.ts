import { sql } from 'drizzle-orm';
import { check, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { sqliteBigInt, sqliteBigIntId } from './shared.ts';
import { chats } from './core.ts';
import { media, messageRevisions, messages, senders } from './messaging.ts';
import { buckets, invocations } from './invocation.ts';

/**
 * Per-room state for virtual (playground) rooms. `revision` is the optimistic
 * concurrency token for room settings; `next_seq` is the high-water mark for
 * local message sequence numbers and is never rewound, so a released batch can
 * always be ordered even after retention drops older rows. `image_enabled` is
 * the room's opt-in for the paid image pipeline; the operator columns record
 * who last decided it and when (T08).
 */
export const rooms = sqliteTable('rooms', {
  chatId: sqliteBigIntId('chat_id')
    .primaryKey()
    .references(() => chats.id, { onDelete: 'cascade' }),
  revision: sqliteBigInt('revision').notNull().default(0n),
  nextSeq: sqliteBigInt('next_seq').notNull().default(1n),
  hold: integer('hold', { mode: 'boolean' }).notNull().default(true),
  imageEnabled: integer('image_enabled', { mode: 'boolean' }).notNull().default(false),
  /** Who last flipped the image switch; null until an operator decides. */
  imageEnabledBy: text('image_enabled_by'),
  imageEnabledAt: text('image_enabled_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

/**
 * Admin-side creation idempotency: one row per accepted create request.
 *
 * `room_chat_id` is 0 for the room-creation key itself and the owning room for
 * nested keys, so both the uniqueness scope and every lookup match the room a
 * key belongs to - a key can never return another room's result.
 */
export const playgroundMutations = sqliteTable(
  'playground_mutations',
  {
    id: sqliteBigIntId('id').primaryKey(),
    kind: text('kind').notNull(),
    roomChatId: sqliteBigInt('room_chat_id').notNull().default(0n),
    requestKey: text('request_key').notNull(),
    fingerprint: text('fingerprint').notNull(),
    resultJson: text('result_json').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    check('playground_mutations_kind_check', sql`kind IN ('room', 'participant')`),
    uniqueIndex('playground_mutations_key_idx').on(t.kind, t.roomChatId, t.requestKey),
  ],
);

/**
 * Membership of a sender in a room. A playground identity only exists as a
 * participant of exactly the rooms it was admitted to, which is what makes an
 * identity table without a Telegram id meaningful.
 */
export const roomParticipants = sqliteTable(
  'room_participants',
  {
    chatId: sqliteBigInt('chat_id')
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    senderId: sqliteBigInt('sender_id')
      .notNull()
      .references(() => senders.id, { onDelete: 'cascade' }),
    role: text('role').notNull().default('member'),
    joinedAt: text('joined_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.chatId, t.senderId] }),
    check('room_participants_role_check', sql`role IN ('member', 'admin')`),
    index('room_participants_sender_key').on(t.senderId),
  ],
);

/**
 * Inputs admitted into a room, held until a release seals them.
 *
 * A held input is a canonical message plus its ledger row: it is visible to
 * nobody, creates no bucket and never appears in a snapshot. `seq` is allocated
 * from `rooms.next_seq` inside the same transaction and is never reused, so a
 * released batch keeps its order even after retention.
 */
export const playgroundInputs = sqliteTable(
  'playground_inputs',
  {
    id: sqliteBigIntId('id').primaryKey(),
    chatId: sqliteBigInt('chat_id')
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    seq: sqliteBigInt('seq').notNull(),
    requestKey: text('request_key').notNull(),
    fingerprint: text('fingerprint').notNull(),
    // Nulled by retention: the row stays as the request key's tombstone.
    messageId: sqliteBigInt('message_id').references(() => messages.id, { onDelete: 'set null' }),
    revisionId: sqliteBigInt('revision_id').references(() => messageRevisions.id, { onDelete: 'set null' }),
    state: text('state').notNull().default('held'),
    releaseId: sqliteBigInt('release_id'),
    createdAt: text('created_at').notNull(),
    releasedAt: text('released_at'),
  },
  (t) => [
    check('playground_inputs_state_check', sql`state IN ('held', 'released', 'expired')`),
    check(
      'playground_inputs_held_message_check',
      sql`state <> 'held' OR (message_id IS NOT NULL AND revision_id IS NOT NULL)`,
    ),
    uniqueIndex('playground_inputs_room_seq_idx').on(t.chatId, t.seq),
    uniqueIndex('playground_inputs_request_idx').on(t.chatId, t.requestKey),
    index('playground_inputs_held_idx').on(t.chatId, t.state, t.seq),
    index('playground_inputs_message_idx').on(t.messageId).where(sql`message_id IS NOT NULL`),
  ],
);

/**
 * A local static image that belongs to one room.
 *
 * The bytes live under the media cache; the row keeps the real format, the
 * content hash used for dedupe and cache identity, and the lifecycle state so
 * a staged upload that never became a message can be swept.
 */
export const playgroundAssets = sqliteTable(
  'playground_assets',
  {
    id: text('id').primaryKey(),
    chatId: sqliteBigInt('chat_id')
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    sha256: text('sha256').notNull(),
    mime: text('mime').notNull(),
    byteSize: sqliteBigInt('byte_size').notNull(),
    width: sqliteBigInt('width').notNull(),
    height: sqliteBigInt('height').notNull(),
    storagePath: text('storage_path').notNull(),
    state: text('state').notNull().default('staged'),
    mediaId: sqliteBigInt('media_id').references(() => media.id, { onDelete: 'set null' }),
    createdAt: text('created_at').notNull(),
    attachedAt: text('attached_at'),
  },
  (t) => [
    check('playground_assets_state_check', sql`state IN ('staged', 'attached')`),
    uniqueIndex('playground_assets_content_idx').on(t.chatId, t.sha256),
    index('playground_assets_state_idx').on(t.state, t.createdAt),
  ],
);

/**
 * One sealed release of a room's held inputs.
 *
 * The release points at the bucket and invocation it created. A release with
 * no held inputs just closes the hold and leaves both null.
 */
export const playgroundReleases = sqliteTable(
  'playground_releases',
  {
    id: sqliteBigIntId('id').primaryKey(),
    chatId: sqliteBigInt('chat_id')
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    releaseKey: text('release_key').notNull(),
    revision: sqliteBigInt('revision').notNull(),
    throughSeq: sqliteBigInt('through_seq').notNull(),
    bucketId: sqliteBigInt('bucket_id').references(() => buckets.id, { onDelete: 'set null' }),
    invocationId: sqliteBigInt('invocation_id').references(() => invocations.id, {
      onDelete: 'set null',
    }),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('playground_releases_key_idx').on(t.chatId, t.releaseKey),
    uniqueIndex('playground_releases_revision_idx').on(t.chatId, t.revision),
    uniqueIndex('playground_releases_invocation_idx').on(t.invocationId),
  ],
);

/**
 * A conservative retry of a terminated, side-effect-free release attempt.
 *
 * The retry never mutates the original invocation: it creates a new one from
 * the original frozen snapshot and records both, plus the caller's unique
 * attempt key, so the same retry cannot be applied twice.
 */
export const playgroundRetries = sqliteTable(
  'playground_retries',
  {
    id: sqliteBigIntId('id').primaryKey(),
    chatId: sqliteBigInt('chat_id')
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    releaseId: sqliteBigInt('release_id')
      .notNull()
      .references(() => playgroundReleases.id, { onDelete: 'cascade' }),
    invocationId: sqliteBigInt('invocation_id')
      .notNull()
      .references(() => invocations.id, { onDelete: 'cascade' }),
    retryOfInvocationId: sqliteBigInt('retry_of_invocation_id')
      .notNull()
      .references(() => invocations.id, { onDelete: 'cascade' }),
    attemptKey: text('attempt_key').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('playground_retries_key_idx').on(t.chatId, t.attemptKey),
    uniqueIndex('playground_retries_invocation_idx').on(t.invocationId),
  ],
);
