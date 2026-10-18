import { eq } from 'drizzle-orm';
import type { HostKind } from '../platform/im-host.ts';
import { chats, conversations } from '../store/schema.ts';
import type { BusinessStore } from '../store/store.ts';

/**
 * Which image generations one process may execute.
 *
 * The image database is shared by every host of one installation, but a
 * process may serve only part of them (`serve --playground-only`). The worker's
 * recovery, queue and claim paths and the bridge's reconciliation all ask the
 * same question, so they get the same answer from one predicate: work belonging
 * to a host this process does not serve stays untouched — still queued, still
 * waiting — for the process that does serve it.
 *
 * A generation whose actor is not a conversation's agent (the Admin workspace
 * submits with an admin actor) belongs to no host and touches no transport, so
 * it is always eligible.
 */
export function generationEligibilityForHosts(
  store: BusinessStore,
  hosts: readonly HostKind[],
): (generation: { readonly id: string; readonly actorId: string }) => boolean {
  if (hosts.includes('telegram') && hosts.includes('playground')) {
    return () => true;
  }
  return (generation) => {
    const conversationId = agentConversationId(generation.actorId);
    if (conversationId === null) {
      return true;
    }
    const row = store.orm
      .select({ hostKind: chats.hostKind })
      .from(conversations)
      .innerJoin(chats, eq(chats.id, conversations.chatId))
      .where(eq(conversations.id, conversationId))
      .get();
    if (row === undefined) {
      return false;
    }
    return row.hostKind === 'telegram' ? hosts.includes('telegram') : hosts.includes('playground');
  };
}

/** The conversation an `agent:<conversationId>` actor id names, when it is one. */
function agentConversationId(actorId: string): bigint | null {
  const prefix = 'agent:';
  if (!actorId.startsWith(prefix)) {
    return null;
  }
  const value = actorId.slice(prefix.length);
  if (!/^[1-9][0-9]{0,18}$/.test(value)) {
    return null;
  }
  return BigInt(value);
}
