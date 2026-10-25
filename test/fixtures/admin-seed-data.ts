import type { Orm } from '../../src/store/store.ts';
import { longTasks, taskReceipts } from '../../src/store/schema/index.ts';

/**
 * Deterministic row ids, seed timestamps, JSON payloads and the shared alarm
 * task builder for the admin panel fixtures. `admin-seed.ts` orchestrates the
 * per-domain modules that use them; the ids are fixed so tests can assert on
 * specific rows.
 */

export const T = {
  chat: 1_001n,
  conversation: 2_001n,
  bucketA: 3_001n,
  bucketB: 3_002n,
  invocationA: 4_001n,
  invocationB: 4_002n,
  sender: 5_001n,
  messageA: 6_001n,
  messageB: 6_002n,
  revisionA1: 6_101n,
  revisionA2: 6_102n,
  revisionB1: 6_103n,
  revisionB2: 6_104n,
  mediaPhoto: 6_201n,
  modelOkA: 7_001n,
  modelFailedB: 7_002n,
  modelOkB: 7_003n,
  toolReadA: 8_001n,
  toolSendA: 8_002n,
  toolReadB: 8_003n,
  sendA: 8_101n,
  stickerSet: 9_001n,
  stickerSetLegacy: 9_002n,
  analysisSticker: 9_101n,
  analysisImage: 9_102n,
  stickerStatic: 9_201n,
  stickerAnimated: 9_202n,
  alarm: 10_001n,
  context: 11_001n,
} as const;

export const AT = '2026-09-10T08:00:00.000Z';

export interface AlarmTaskSeed {
  readonly id: bigint;
  readonly conversationId: bigint;
  readonly targetUserId: bigint;
  readonly summary: string;
  readonly scheduledAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly createdByInvocationId?: bigint | null;
  readonly state?: 'waiting' | 'cancelled';
  readonly cancelledAt?: string;
  readonly cancelledBy?: string;
}

export function insertAlarmTask(orm: Orm, seed: AlarmTaskSeed): void {
  const targetDisplayName = 'Alice';
  const payload = JSON.stringify({
    target_user_id: seed.targetUserId.toString(),
    target_display_name: targetDisplayName,
    summary: seed.summary,
  });
  orm
    .insert(longTasks)
    .values({
      id: seed.id,
      pluginId: 'alarm',
      conversationId: seed.conversationId,
      createdByInvocationId: seed.createdByInvocationId ?? null,
      createdByUserId: seed.targetUserId,
      payloadJson: payload,
      state: seed.state ?? 'waiting',
      scheduledAt: seed.scheduledAt,
      timerResultJson: payload,
      deliveryJson: JSON.stringify({
        bypassDailyBudget: true,
        mentionUser: { userId: seed.targetUserId.toString(), displayName: targetDisplayName },
      }),
      createdAt: seed.createdAt,
      updatedAt: seed.updatedAt,
      finishedAt: seed.cancelledAt ?? null,
    })
    .run();
  if (seed.state === 'cancelled') {
    orm
      .insert(taskReceipts)
      .values({
        taskId: seed.id,
        status: 'cancelled',
        resultJson: null,
        errorJson: null,
        state: 'suppressed',
        createdAt: seed.createdAt,
        updatedAt: seed.updatedAt,
        claimedAt: null,
        handledAt: null,
        invocationId: null,
        invocationOutcome: null,
        completionReason: null,
        cancelledAt: seed.cancelledAt ?? seed.updatedAt,
        cancelledBy: seed.cancelledBy ?? 'admin-panel',
        adminCancelled: true,
        cancelReason: 'admin_cancelled',
      })
      .run();
  }
}

/** A JSON payload well above the frontend's 2_000-char collapse threshold. */
export const OVERSIZED_REQUEST_JSON: string = JSON.stringify({
  system: 'long payload fixture',
  instructions: 'x'.repeat(3_000),
  context_messages: Array.from({ length: 150 }, (_, index) => ({
    seq: index + 1,
    role: 'user',
    text: `message ${index + 1}`,
  })),
});

/** Redacted provider error detail: must never contain live keys. */
export const REDACTED_ERROR_DETAIL: string = JSON.stringify({
  error: 'provider_timeout',
  message: 'The provider timed out while streaming (redacted for display)',
  request_id: 'req_seed_001',
  hints: ['retry later', 'reduce max_tokens'],
  key: 'sk-***',
});

/** Context payload well above the admin API's 2_000-char preview cap. */
export const LONG_CONTEXT_PAYLOAD_JSON: string = JSON.stringify({
  role: 'user',
  kind: 'text',
  text: 'x'.repeat(2_200),
});
