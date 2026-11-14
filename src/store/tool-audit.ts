import type { BusinessStore } from './store.ts';
import { finishToolCall, rejectToolCall, startToolCall } from './store.ts';

/**
 * Invocation-bound audit for a capability that records its own `tool_calls`
 * row next to the `execute` row. Plugins get this instead of the store, so
 * audit stays the only database access a stateless plugin has.
 */
export interface ToolAudit {
  start(toolCallId: string, toolName: string, argumentsJson: string, sideEffect: boolean): ToolAuditRecord;
  reject(toolCallId: string, toolName: string, argumentsJson: string, sideEffect: boolean, errorCode: string): void;
}

export interface ToolAuditRecord {
  /**
   * `resultContentJson` is the `{ content, details }` result of a call that
   * carries tool images, so the panel can show them and asset retention keeps them.
   */
  succeed(resultText: string, options?: { readonly resultContentJson?: string }): void;
  fail(errorCode: string): void;
}

export function createToolAudit(store: BusinessStore, invocationId: bigint): ToolAudit {
  return {
    start(toolCallId, toolName, argumentsJson, sideEffect) {
      const startedAt = performance.now();
      const auditId = startToolCall(store.orm, invocationId, toolCallId, toolName, argumentsJson, sideEffect);
      return {
        succeed: (resultText, options) =>
          finishToolCall(store.orm, auditId, 'success', resultText, null, {
            startedAt,
            pendingOnly: true,
            ...(options?.resultContentJson === undefined ? {} : { resultContentJson: options.resultContentJson }),
          }),
        fail: (errorCode) =>
          finishToolCall(store.orm, auditId, 'error', null, errorCode, { startedAt, pendingOnly: true }),
      };
    },
    reject(toolCallId, toolName, argumentsJson, sideEffect, errorCode) {
      rejectToolCall(store.orm, invocationId, toolCallId, toolName, argumentsJson, sideEffect, errorCode);
    },
  };
}
