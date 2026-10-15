import type { AgentTool } from '@earendil-works/pi-agent-core';
import Type from 'typebox';
import { parseShortUserId, type InvocationContext } from '../platform/invocation-context.ts';
import type { BusinessStore } from '../store/store.ts';
import { finishToolCall, startToolCall } from '../store/store.ts';

export const ResolveUserIdInputSchema = Type.Object(
  { user_id: Type.String({ pattern: '^[1-9][0-9]{0,6}$' }) },
  { additionalProperties: false },
);

export interface ResolveUserIdToolOptions {
  readonly store: BusinessStore;
  readonly context: InvocationContext;
}

/**
 * The `resolve_user_id` runtime primitive: turns a model-visible compact user id
 * (`uid:N` in message headers, 1, 2, 3, ...) back into the real Telegram user id.
 * The mapping lives on the current invocation context only -- it never survives
 * the invocation, never touches the database, and an unknown id fails instead of
 * guessing a user. The real id is returned as a decimal string so Telegram ids
 * beyond the safe-integer range keep full precision.
 */
export function createResolveUserIdTool(
  options: ResolveUserIdToolOptions,
): AgentTool<typeof ResolveUserIdInputSchema, { user_id: string; telegram_user_id: string }> {
  return {
    name: 'resolve_user_id',
    label: 'Resolve a user id',
    description:
      'Resolve a compact user id from the conversation context (the small number after uid: in a message header) into the real Telegram user id. Use it only when a tool or an integration needs the real Telegram id; ordinary replies and replies by message id never do. The compact ids are valid only inside the current invocation; pass exactly the number shown, never a computed, padded, or guessed value. Returns the real Telegram user id as a decimal string, or fails when the id is not visible in this invocation.',
    parameters: ResolveUserIdInputSchema,
    executionMode: 'sequential',
    execute: async (toolCallId, input) => {
      const startedAt = performance.now();
      const auditId = startToolCall(
        options.store.orm,
        options.context.invocationId,
        toolCallId,
        'resolve_user_id',
        JSON.stringify(input),
        false,
      );
      const fail = (code: string): never => {
        finishToolCall(options.store.orm, auditId, 'error', null, code, { startedAt, pendingOnly: true });
        throw new Error(`resolve_user_id failed: ${code}`);
      };
      const shortId = parseShortUserId(input.user_id);
      if (shortId === null) {
        return fail('resolve_user_id_invalid');
      }
      const realId = options.context.resolveModelUserId?.(input.user_id);
      if (realId === undefined || realId === null) {
        return fail('resolve_user_id_unknown');
      }
      const text = realId.toString();
      finishToolCall(options.store.orm, auditId, 'success', text, null, { startedAt, pendingOnly: true });
      return {
        content: [{ type: 'text', text }],
        details: { user_id: input.user_id, telegram_user_id: text },
      };
    },
  };
}
