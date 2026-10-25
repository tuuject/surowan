/**
 * Host-neutral instant messaging contract.
 *
 * The *platform* (prompt rendering, tool schemas, tool argument parsing, tool
 * result and error copy) is host-neutral: it never sees a transport client.
 * This directory is the whole vocabulary that crosses that seam. Everything a
 * transport needs in order to put one modelled message on the wire, and
 * everything the platform needs back from it, is expressed here as values.
 *
 * Three rules keep the boundary honest.
 *
 * 1. This directory is a leaf: its modules import only each other. No IO, no
 *    storage, no clock, no configuration reads. Policy values arrive as
 *    arguments.
 * 2. No transport library type may appear in these signatures. Telegram is
 *    expressed as host kind + conversation policy + ordered delivery parts +
 *    a delivery-failure vocabulary. The mapping onto the Telegram API lives in
 *    `src/adapters/local-monolith/telegram/host.ts`, and only there.
 * 3. Internal identifiers and model-visible references are different things.
 *    Models never see a chat id or a raw transport user id; they see a rendered
 *    `SenderRef` or nothing at all. See {@link SenderRef}.
 *
 * Ownership of the model-facing surface, so later changes land on one side:
 *
 * - The platform owns prompt text, the message-envelope format, tool names,
 *   tool schemas, argument validation messages, and the copy returned to the
 *   model for a rejected send.
 * - The host owns delivery part order, transport limits, mention entity
 *   construction, retry classification, and activity cadence.
 */

import type { ImDelivery, ImDeliveryOutcome } from './delivery.ts';
import type { HostKind, ImConversationRef } from './identity.ts';
import { type ImConversationPolicy, type ImDeliveryTarget, resolveConversationPolicy } from './policy.ts';

/* -------------------------------------------------------------------------- */
/* Activity                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * How long an activity round lives besides its cap. A status the runtime shows
 * on its own (a mention) ends once the bot publishes into the conversation,
 * because the published message answers it. A status the model asked for keeps
 * refreshing through its sends until it is stopped, since the work it covers
 * may continue after a message went out.
 */
export type ActivityLifetime = 'until_delivery' | 'until_stop';

export interface ImActivity {
  /**
   * Shows the "working" indicator for one conversation and keeps it fresh.
   * Idempotent per conversation while a round is live, except that an
   * `until_stop` request takes over an `until_delivery` round; cosmetic
   * failures are swallowed by the host.
   */
  start(target: ImDeliveryTarget, lifetime: ActivityLifetime): void;
  /** Clears the indicator for one conversation. Safe when nothing is running. */
  stop(conversation: ImConversationRef): void;
  /** Clears every indicator this instance owns. */
  stopAll(): void;
}

/**
 * The transport seam. One instance per host kind; a caller resolves a
 * conversation through the server and then holds only this interface.
 */
export interface ImHost {
  readonly host: HostKind;
  /** Resolved policy for one conversation. Pure. */
  policy(conversation: ImConversationRef): ImConversationPolicy;
  readonly delivery: ImDelivery;
  readonly activity: ImActivity;
}

/**
 * A host that carries nothing. Used where the platform must be able to build
 * its tools but must never reach a transport, such as replaying a retained
 * scene. It refuses every delivery and ignores every activity, rather than
 * throwing, so a stray call fails at the send audit - where it is visible -
 * instead of in the middle of message rendering.
 */
export function unwiredImHost(host: HostKind, reason: string): ImHost {
  const policy = (conversation: ImConversationRef): ImConversationPolicy =>
    resolveConversationPolicy({ host, scope: conversation.scope, sendRate: { sendsPerWindow: 1, windowSeconds: 1 } });
  return {
    host,
    policy,
    delivery: {
      // It never delivers anywhere, so no target is ever in scope.
      crossConversationTargets: false,
      // There is no wire to shape for, so the part is previewed as it stands.
      compose: (part) =>
        part.kind === 'text'
          ? { text: part.text, markup: part.markup ?? null }
          : {
              text: part.kind === 'sticker' ? null : (part.caption ?? null),
              markup: null,
            },
      deliver: () =>
        Promise.resolve<ImDeliveryOutcome>({
          kind: 'rejected',
          failure: { reason: 'unsupported', code: 'send_unsupported', outcomeUnknown: false, description: reason },
        }),
    },
    activity: {
      start: () => undefined,
      stop: () => undefined,
      stopAll: () => undefined,
    },
  };
}
