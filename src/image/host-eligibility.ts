import { eq } from 'drizzle-orm';
import type { HostReadiness } from '../orchestration/host-scope.ts';
import type { HostKind } from '../platform/im-host.ts';
import { chats, conversations } from '../store/schema/index.ts';
import type { BusinessStore } from '../store/store.ts';

/**
 * Which image generations one process may execute.
 *
 * The image database is shared by every host of one installation, but a
 * process may serve only some of them, and a host it serves may still not be
 * ready to act (Telegram disabled, misconfigured or connecting). The worker's
 * recovery, queue and claim paths and the bridge's reconciliation all ask the
 * same live question, so work that cannot run now stays queued for the pass
 * that can.
 *
 * A generation whose actor is not a conversation's agent (the Admin workspace
 * submits with an admin actor) belongs to no host and touches no transport, so
 * it is always eligible.
 */
export function generationEligibilityForHosts(
  store: BusinessStore,
  hosts: readonly HostKind[],
  isHostReady: HostReadiness,
): (generation: { readonly id: string; readonly actorId: string }) => boolean {
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
    const host: HostKind = row.hostKind === 'telegram' ? 'telegram' : 'playground';
    return hosts.includes(host) && isHostReady(host);
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
