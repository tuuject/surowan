import type { RawConfig } from '../platform/config.ts';
import type { Orm } from '../store/database.ts';

/**
 * One per-batch context injection: an untrusted block the runtime appends to
 * the newest injected message, between the sticker catalog and the Telegram
 * history. Injectors run after the batch's messages were selected, in plugin
 * load order, and each receives what is left of the character budget.
 *
 * De-duplication is the injector's own contract, expressed as opaque signature
 * strings: `render` reports the signatures its block carries, the runtime
 * accumulates them per injector, and `collect` reads them back out of a
 * retained transcript message after a GC or cache rebuild. The runtime never
 * interprets a signature.
 *
 * Trust boundary: a non-empty `text` MUST be wrapped in an `<untrusted_…>`
 * envelope and MUST NOT indent any of its lines. Telegram message bodies are
 * always rendered indented two spaces (`formatSnapshot`), so only the runtime's
 * own unindented lines can start an envelope or a signature tag; this is what
 * keeps chat text from forging a block or a dedupe signature.
 */
export interface ContextInjector {
  /** Injector name; also the audit key. `loadPlugins` requires a plugin-id-shaped name, unique across plugins. */
  readonly name: string;
  /**
   * Reads this injector's signatures out of one retained user message's text.
   * The runtime calls it for every retained message when rebuilding state
   * after a GC or agent cache miss.
   */
  collect(text: string): Iterable<string>;
  /** Renders this batch's injection block; an empty `text` injects nothing. */
  render(input: ContextInjectionInput): ContextInjectionResult;
}

export interface ContextInjectionInput {
  readonly config: RawConfig;
  readonly orm: Orm;
  readonly chatId: bigint;
  /** A private chat; it may only see global data, never another chat's. */
  readonly privateChat: boolean;
  /** The text and caption of this batch's selected messages (history + new), for on-demand matching. */
  readonly messageTexts: readonly string[];
  /** The character budget left after the messages and any earlier injector's block. */
  readonly remainingCharacters: number;
  /** Signatures this injector wrote that the retained transcript still carries. */
  readonly carried: ReadonlySet<string>;
}

export interface ContextInjectionResult {
  readonly text: string;
  /** Signatures written by this block; the runtime adds them to the carried set. */
  readonly signatures: readonly string[];
  /** Injected entry count, for the audit stream. */
  readonly count: number;
}
