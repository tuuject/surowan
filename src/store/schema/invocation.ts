import { sql } from 'drizzle-orm';
import {
  type AnySQLiteColumn,
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { sqliteBigInt, sqliteBigIntId } from './shared.ts';
import { conversations } from './core.ts';
import { media, messageRevisions, messages } from './messaging.ts';

export const buckets = sqliteTable(
  'buckets',
  {
    id: sqliteBigIntId('id').primaryKey(),
    conversationId: sqliteBigInt('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    state: text('state').notNull(),
    kind: text('kind').notNull().default('realtime'),
    firstReceivedAt: text('first_received_at').notNull(),
    deadlineAt: text('deadline_at').notNull(),
    queuedAt: text('queued_at'),
    startedAt: text('started_at'),
    finishedAt: text('finished_at'),
    mergedIntoBucketId: sqliteBigInt('merged_into_bucket_id').references((): AnySQLiteColumn => buckets.id),
    errorCode: text('error_code'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    check(
      'buckets_state_check',
      sql`state IN ('collecting', 'queued', 'running', 'completed', 'failed', 'aborted', 'outcome_unknown', 'merged', 'expired', 'skipped_budget')`,
    ),
    check('buckets_kind_check', sql`kind IN ('realtime', 'startup_catch_up')`),
    uniqueIndex('one_collecting_bucket_per_conversation').on(t.conversationId).where(sql`state = 'collecting'`),
    index('buckets_schedule_idx').on(t.state, t.deadlineAt, t.id),
  ],
);

export const bucketMessages = sqliteTable(
  'bucket_messages',
  {
    bucketId: sqliteBigInt('bucket_id')
      .notNull()
      .references(() => buckets.id, { onDelete: 'cascade' }),
    messageId: sqliteBigInt('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    sequenceNo: sqliteBigInt('sequence_no').notNull(),
    sourceBucketId: sqliteBigInt('source_bucket_id'),
  },
  (t) => [
    primaryKey({ columns: [t.bucketId, t.messageId] }),
    uniqueIndex('bucket_messages_bucket_sequence_unique').on(t.bucketId, t.sequenceNo),
  ],
);

export const invocations = sqliteTable(
  'invocations',
  {
    id: sqliteBigIntId('id').primaryKey(),
    bucketId: sqliteBigInt('bucket_id')
      .notNull()
      .references(() => buckets.id),
    conversationId: sqliteBigInt('conversation_id')
      .notNull()
      .references(() => conversations.id),
    state: text('state').notNull(),
    configHash: text('config_hash').notNull(),
    promptVersion: sqliteBigInt('prompt_version').notNull(),
    toolRegistryHash: text('tool_registry_hash'),
    toolRegistryJson: text('tool_registry_json'),
    startedAt: text('started_at'),
    finishedAt: text('finished_at'),
    completionReason: text('completion_reason'),
    errorCode: text('error_code'),
    sendsUsed: sqliteBigInt('sends_used').notNull().default(0n),
    toolCallsUsed: sqliteBigInt('tool_calls_used').notNull().default(0n),
    turnsUsed: sqliteBigInt('turns_used').notNull().default(0n),
    sideEffectStarted: integer('side_effect_started', { mode: 'boolean' }).notNull().default(false),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    check(
      'invocations_state_check',
      sql`state IN ('queued', 'running', 'completed', 'failed', 'aborted', 'outcome_unknown', 'skipped_budget')`,
    ),
    uniqueIndex('one_running_invocation_per_conversation').on(t.conversationId).where(sql`state = 'running'`),
    index('invocations_queue_idx').on(t.state, t.id),
  ],
);

export const invocationMessages = sqliteTable(
  'invocation_messages',
  {
    invocationId: sqliteBigInt('invocation_id')
      .notNull()
      .references(() => invocations.id, { onDelete: 'cascade' }),
    messageId: sqliteBigInt('message_id')
      .notNull()
      .references(() => messages.id),
    revisionId: sqliteBigInt('revision_id')
      .notNull()
      .references(() => messageRevisions.id),
    section: text('section').notNull(),
    sequenceNo: sqliteBigInt('sequence_no').notNull(),
    sourceBucketId: sqliteBigInt('source_bucket_id'),
    omittedBefore: sqliteBigInt('omitted_before').notNull().default(0n),
    snapshotJson: text('snapshot_json').notNull(),
    /**
     * Format identifier for the frozen snapshot payload. Rows written before
     * the column existed carry the legacy value through the column default;
     * their JSON payload is never rewritten.
     */
    snapshotFormat: text('snapshot_format').notNull().default('plasticwan.invocation-snapshot.v1'),
  },
  (t) => [
    primaryKey({ columns: [t.invocationId, t.sequenceNo] }),
    check('invocation_messages_section_check', sql`section IN ('history', 'new')`),
  ],
);

/**
 * One persistent canonical history per Conversation. `head_seq` is the first
 * retained row after discard-only GC; `next_seq` is the next free row. The
 * agent transcript is seeded from `context_messages` and written back to it, so
 * continuity survives process restarts and agent-cache eviction.
 */
export const conversationContexts = sqliteTable('conversation_contexts', {
  id: sqliteBigIntId('id').primaryKey(),
  conversationId: sqliteBigInt('conversation_id')
    .notNull()
    .unique()
    .references(() => conversations.id, { onDelete: 'cascade' }),
  headSeq: sqliteBigInt('head_seq').notNull().default(1n),
  nextSeq: sqliteBigInt('next_seq').notNull().default(1n),
  sendCountTotal: sqliteBigInt('send_count_total').notNull().default(0n),
  systemPromptHash: text('system_prompt_hash').notNull(),
  activeInvocationId: sqliteBigInt('active_invocation_id').references(() => invocations.id, { onDelete: 'set null' }),
  lastActiveAt: text('last_active_at').notNull(),
  lastGcAt: text('last_gc_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const contextMessages = sqliteTable(
  'context_messages',
  {
    contextId: sqliteBigInt('context_id')
      .notNull()
      .references(() => conversationContexts.id, { onDelete: 'cascade' }),
    seq: sqliteBigInt('seq').notNull(),
    role: text('role').notNull(),
    payloadJson: text('payload_json').notNull(),
    invocationId: sqliteBigInt('invocation_id').references(() => invocations.id, { onDelete: 'set null' }),
    isCheckpoint: integer('is_checkpoint', { mode: 'boolean' }).notNull().default(false),
    sendSeq: sqliteBigInt('send_seq'),
    estTokens: sqliteBigInt('est_tokens').notNull(),
    evictedAt: text('evicted_at'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.contextId, t.seq] }),
    check('context_messages_role_check', sql`role IN ('user', 'assistant', 'toolResult')`),
    index('context_messages_checkpoint_idx').on(t.contextId, t.isCheckpoint, t.seq),
    index('context_messages_evicted_idx').on(t.evictedAt),
  ],
);

/**
 * Capability references scoped to a Conversation Context with a TTL, so a
 * reference quoted in retained history stays usable across invocations.
 * `sourceSeq` is the context message that carried the reference.
 */
export const contextRefs = sqliteTable(
  'context_refs',
  {
    contextId: sqliteBigInt('context_id')
      .notNull()
      .references(() => conversationContexts.id, { onDelete: 'cascade' }),
    ref: text('ref').notNull(),
    kind: text('kind').notNull(),
    sourceSeq: sqliteBigInt('source_seq').notNull(),
    mediaId: sqliteBigInt('media_id').references(() => media.id, { onDelete: 'cascade' }),
    stickerFileId: text('sticker_file_id'),
    targetConversationId: sqliteBigInt('target_conversation_id').references(() => conversations.id, {
      onDelete: 'cascade',
    }),
    targetThreadId: sqliteBigInt('target_thread_id'),
    expiresAt: text('expires_at').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.contextId, t.ref] }),
    check('context_refs_kind_check', sql`kind IN ('media', 'sticker', 'reply')`),
    index('context_refs_expiry_idx').on(t.expiresAt),
  ],
);

/** Bucket-to-invocation join: one long-lived invocation may consume many buckets. */
export const invocationBuckets = sqliteTable(
  'invocation_buckets',
  {
    invocationId: sqliteBigInt('invocation_id')
      .notNull()
      .references(() => invocations.id, { onDelete: 'cascade' }),
    bucketId: sqliteBigInt('bucket_id')
      .notNull()
      .references(() => buckets.id, { onDelete: 'cascade' }),
    attachedAt: text('attached_at').notNull(),
    injectedAt: text('injected_at'),
  },
  (t) => [primaryKey({ columns: [t.invocationId, t.bucketId] }), index('invocation_buckets_bucket_idx').on(t.bucketId)],
);
