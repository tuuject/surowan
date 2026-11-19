/**
 * What an inbound message means to the host-neutral core: the signals
 * participation, proactive replies and catch-up need, without the transport
 * message that produced them. A host edge computes cues once per message (live
 * or from its stored raw fragment) and core code never reads the transport
 * shape itself.
 */

/** The bot account a cue is judged against. */
export interface BotIdentity {
  readonly id: bigint;
  readonly username: string | null;
}

export interface MessageCues {
  /** The message @-mentions this bot or text-mentions its user id. */
  readonly mentionsBot: boolean;
  /** The message replies to a message this bot sent. */
  readonly repliesToBot: boolean;
  /**
   * The message is an original `/ask` to this bot — revision one can itself be
   * an edit when the original update was never received, so an edited-in ask
   * does not count.
   */
  readonly asksBot: boolean;
  /**
   * Every visible string keyword rules may search: text, caption, and a rich
   * message's flattened visible text. Hosts whose rows carry no searchable
   * fragment text contribute an empty list.
   */
  readonly texts: readonly string[];
}
