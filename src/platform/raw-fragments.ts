/**
 * The readers every `raw_fragment_json` consumer goes through.
 *
 * A revision's raw fragment is host data: Telegram stores the whole message,
 * a playground room stores none. Core code never parses the JSON itself — it
 * resolves the row's host here and asks for either the message's trigger cues
 * or its rendered body. A fragment that lost its shape degrades to no cues
 * and the stored body, never a crash.
 */

import { type BotIdentity, EMPTY_MESSAGE_CUES, type MessageCues } from './im-host/cues.ts';
import type { HostKind } from './im-host/identity.ts';
import { bodyFromFragment, type RenderedBody } from './telegram-markdown/index.ts';
import { asksFromFragment, cuesFromFragment } from './telegram-markdown/cues.ts';

/** The stored revision fields a body render may need besides the fragment. */
export interface RawFragmentStoredBody {
  readonly text: string | null;
  readonly caption: string | null;
  readonly reply_snapshot?: unknown;
  /** Media rows of the revision; slots are only kept when they match one to one. */
  readonly mediaCount: number;
}

export interface RawFragmentReader {
  cues(rawFragmentJson: string | null | undefined, bot: BotIdentity): MessageCues;
  /**
   * Only the original-ask cue. Backlog scans (catch-up, proactive reply) pay
   * for this narrow read instead of extracting every cue from every row.
   */
  asks(rawFragmentJson: string | null | undefined, bot: BotIdentity): boolean;
  body(rawFragmentJson: string | null | undefined, stored: RawFragmentStoredBody): RenderedBody;
}

export const RAW_FRAGMENT_READERS: Record<HostKind, RawFragmentReader> = {
  telegram: {
    cues: cuesFromFragment,
    asks: asksFromFragment,
    body: bodyFromFragment,
  },
  playground: {
    // A room message keeps no fragment: nothing to match, and its stored body
    // is already what the model reads.
    cues: () => EMPTY_MESSAGE_CUES,
    asks: () => false,
    body: (_rawFragmentJson, stored) => ({ text: stored.text, caption: stored.caption }),
  },
};

export function rawFragmentReader(host: HostKind): RawFragmentReader {
  return RAW_FRAGMENT_READERS[host];
}
