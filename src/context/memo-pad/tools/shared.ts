import { resolveChatConfig, type BusinessStore } from '../../../store/store.ts';
import type { CapabilityRefResolver, InvocationContext } from '../../../platform/invocation-context.ts';
import type { RuntimeConfigurationStore } from '../../../platform/runtime-config.ts';
import type { MemoBlobStore } from '../blobs.ts';
import type { MemoPadStore } from '../store.ts';

/** The subset the two read primitives need; the write/image capabilities add more. */
export interface MemoReadEnvironment {
  readonly store: BusinessStore;
  readonly memoPad: MemoPadStore;
  readonly context: InvocationContext;
}

/** Everything the Memo tools read; all fields are the live invocation objects. */
export interface MemoToolEnvironment extends MemoReadEnvironment {
  readonly blobs: MemoBlobStore;
  readonly configStore: RuntimeConfigurationStore;
  readonly capabilities: CapabilityRefResolver;
  /** Loads one context-authorized media ref as a normalized image. */
  readonly prepareImage: (mediaId: bigint, signal: AbortSignal) => Promise<{ base64: string; mime: string }>;
}

/**
 * Writes are refused once the Telegram Chat has left the active configuration.
 * That closes the window between an Admin delete and an in-flight tool that was
 * already executing; a Chat outside the config can never gain a new record.
 */
export function memoChatRemoved(env: MemoToolEnvironment): boolean {
  if (env.context.hostKind !== 'telegram') {
    return false;
  }
  return resolveChatConfig(env.configStore.current().config, env.store.orm, env.context.chatId) === undefined;
}

/** One-line summary for a tool result; summaries are untrusted data, not markup. */
export function plainSummary(summary: string): string {
  return summary.replace(/\s+/g, ' ').trim();
}
