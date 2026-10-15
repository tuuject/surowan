/**
 * Shared invocation-context value types. This is a leaf module: it must not
 * import any other src module, because context-builder, memory, and every tool
 * boundary depend on these types. (Type-only pi-ai imports are erased and do not
 * create a src dependency.)
 */
import type { Message, TextContent } from '@earendil-works/pi-ai';

// ── JSON value types (leaf, shared by store and plugins) ───────────

/** Serializable JSON values that survive TypeBox + JSON.stringify round-trips. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { readonly [key: string]: JsonValue };

/** Delivery policy frozen at task creation, consumed when the receipt is injected. */
export interface DeliveryPolicy {
  readonly bypassDailyBudget: boolean;
  readonly mentionUser?:
    | {
        readonly userId: bigint;
        readonly displayName: string;
      }
    | undefined;
}

/** Completion receipt currently being handled by the agent (one receipt per round). */
export interface CompletionContext {
  readonly taskId: bigint;
  readonly pluginId: string;
  readonly payload: JsonValue;
  readonly status: 'completed' | 'failed' | 'cancelled';
  readonly resultJson?: JsonValue;
  readonly errorJson?: JsonValue;
  readonly delivery: DeliveryPolicy;
}

// ── Invocation context ────────────────────────────────────────────

export interface ReplyTarget {
  readonly conversationId: bigint;
  readonly threadId: bigint;
}
export interface DirectImage {
  readonly mediaId: bigint;
  readonly imageRef: string;
}
export interface VisibleSender {
  readonly userId: bigint;
  readonly displayName: string;
  readonly username: string | null;
}

/**
 * Model-visible Telegram user IDs are compacted to dense integers (1, 2, 3, …)
 * for the duration of one invocation, so a request is not padded with repeated
 * 10-digit ids. The map is invocation-local and never persisted: the stored
 * transcript and every Telegram/DB id stay the real value; only the text handed
 * to the model is rewritten at the LLM request boundary.
 *
 * Real ids are handled as decimal strings end to end (never `Number`), because a
 * Telegram user id can exceed `Number.MAX_SAFE_INTEGER`. Short ids are ordinary
 * small integers and are safe as numbers.
 */
export class UserIdMap {
  #realToShort = new Map<string, number>();
  #shortToReal = new Map<number, bigint>();
  #next = 1;

  /** Returns the dense short id for a real Telegram user id, assigning on first use. */
  shorten(realId: string): number {
    const existing = this.#realToShort.get(realId);
    if (existing !== undefined) {
      return existing;
    }
    const short = this.#next++;
    this.#realToShort.set(realId, short);
    this.#shortToReal.set(short, BigInt(realId));
    return short;
  }

  /** Resolves a short id back to the real Telegram user id, or `undefined` when unknown. */
  resolve(shortId: number): bigint | undefined {
    return this.#shortToReal.get(shortId);
  }
}

/**
 * Parses a model-supplied short user id. Rejects anything that is not a plain
 * positive decimal integer within the safe-integer range, so a real (possibly
 * huge) Telegram id or a malformed value can never resolve to some other user.
 */
export function parseShortUserId(value: string): number | null {
  if (!/^[1-9][0-9]*$/.test(value)) {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * Rewrites the runtime-controlled user-id tokens in one rendered message batch:
 * `uid:<real>` in a message header and `"target_user_id":"<real>"` in a task
 * receipt. Both are assigned a short id (populating `map`) so the same user keeps
 * one id across headers and receipts.
 *
 * Only lines the runtime owns are touched. `formatSnapshot` indents every
 * Telegram-authored body line with two spaces, so those (and any `uid:` a user
 * typed into their message) are left verbatim. Message ids, `re:` reply ids and
 * `topic:` ids use different token prefixes and are never matched.
 */
export function shortenUserIdsInText(text: string, map: UserIdMap): string {
  const marker = '</runtime_state>';
  const cut = text.lastIndexOf(marker);
  const prefix = cut === -1 ? '' : text.slice(0, cut + marker.length);
  const body = cut === -1 ? text : text.slice(cut + marker.length);
  const rewritten = body
    .split('\n')
    .map((line) => (line.startsWith('  ') ? line : shortenRuntimeLine(line, map)))
    .join('\n');
  return prefix + rewritten;
}

function shortenRuntimeLine(line: string, map: UserIdMap): string {
  return line
    .replace(/uid:([0-9]+)/g, (_match, id: string) => `uid:${map.shorten(id)}`)
    .replace(/"target_user_id":"([0-9]+)"/g, (_match, id: string) => `"target_user_id":"${map.shorten(id)}"`);
}

/**
 * Compacts the model-visible Telegram user ids in one LLM request at the request
 * boundary. Only user messages are rewritten: they carry the runtime-rendered
 * `uid:` headers and task receipts. Assistant messages keep the model's own
 * short ids in their tool-call arguments untouched, and system messages carry no
 * user ids. The transcript and the canonical history are never mutated — the
 * rewritten copy is handed to the provider for this request only, so the same
 * invocation-local map keeps every reference consistent.
 */
export function shortenContextUserIds(messages: readonly Message[], map: UserIdMap): Message[] {
  return messages.map((message) => {
    if (message.role !== 'user') {
      return message;
    }
    if (typeof message.content === 'string') {
      return { ...message, content: shortenUserIdsInText(message.content, map) };
    }
    const content = message.content.map((block) =>
      block.type === 'text' ? ({ ...block, text: shortenUserIdsInText(block.text, map) } satisfies TextContent) : block,
    );
    return { ...message, content };
  });
}

/**
 * Resolves capability references (`img_`, `stk_`, `reply:<message id>`) for the
 * Conversation Context currently running. References live in the context with a
 * TTL, so a ref quoted in retained history keeps working across invocations and
 * stops working once its message is evicted. A ref never resolves outside the
 * context that minted it.
 */
export interface CapabilityRefResolver {
  resolveMedia(ref: string): bigint | undefined;
  resolveStickerRef(ref: string): string | undefined;
  resolveReplyTarget(messageId: string): ReplyTarget | undefined;
  /** Authorizes one sticker file for the rest of the context's reference TTL. */
  registerStickerRef(stickerFileId: string): string;
}

/** Resolver for contexts that authorize nothing (registry validation, previews). */
export function unavailableCapabilities(): CapabilityRefResolver {
  return {
    resolveMedia: () => undefined,
    resolveStickerRef: () => undefined,
    resolveReplyTarget: () => undefined,
    registerStickerRef: () => {
      throw new Error('Sticker authorization is unavailable outside a running conversation context');
    },
  };
}

export interface InvocationContext {
  readonly invocationId: bigint;
  readonly conversationId: bigint;
  readonly chatId: bigint;
  readonly threadId: bigint;
  readonly systemPrompt: string;
  readonly userPrompt: string;
  readonly directImages: readonly DirectImage[];
  readonly visibleSenders: ReadonlyMap<string, VisibleSender>;
  readonly callerUserId: bigint | null;
  readonly completion: CompletionContext | null;
  readonly omittedNewMessages: number;
  /**
   * Resolves a model-supplied short user id back to the real Telegram user id.
   * Absent only outside a live invocation (registry previews); callers must treat
   * an absent resolver or an unresolvable short id as an error, never fall back to
   * guessing a user.
   */
  readonly resolveModelUserId?: (shortId: string) => bigint | null;
}

/**
 * Mutable context for one running invocation.
 *
 * Tools capture this object once and read it at call time, so each injected
 * batch refreshes the parts that grow with the conversation (visible senders,
 * direct images, the newest caller) instead of forcing a tool rebuild that the
 * agent loop would not pick up mid-run anyway.
 */
export class InvocationContextState implements InvocationContext {
  readonly invocationId: bigint;
  readonly conversationId: bigint;
  readonly chatId: bigint;
  readonly threadId: bigint;
  #systemPrompt = '';
  #userPrompt = '';
  #directImages: DirectImage[] = [];
  #visibleSenders = new Map<string, VisibleSender>();
  #callerUserId: bigint | null = null;
  #completion: CompletionContext | null = null;
  #omittedNewMessages = 0;
  #userIdMap = new UserIdMap();

  constructor(identity: {
    readonly invocationId: bigint;
    readonly conversationId: bigint;
    readonly chatId: bigint;
    readonly threadId: bigint;
    readonly completion: CompletionContext | null;
  }) {
    this.invocationId = identity.invocationId;
    this.conversationId = identity.conversationId;
    this.chatId = identity.chatId;
    this.threadId = identity.threadId;
    this.#completion = identity.completion;
  }

  get systemPrompt(): string {
    return this.#systemPrompt;
  }
  get userPrompt(): string {
    return this.#userPrompt;
  }
  get directImages(): readonly DirectImage[] {
    return this.#directImages;
  }
  get visibleSenders(): ReadonlyMap<string, VisibleSender> {
    return this.#visibleSenders;
  }
  get callerUserId(): bigint | null {
    return this.#callerUserId;
  }
  get completion(): CompletionContext | null {
    return this.#completion;
  }
  get omittedNewMessages(): number {
    return this.#omittedNewMessages;
  }

  /**
   * The invocation-local real↔short user id map. The LLM request boundary fills
   * it while shortening the model-visible text; tools read it to resolve a short
   * id back to the real Telegram user.
   */
  get userIdMap(): UserIdMap {
    return this.#userIdMap;
  }

  resolveModelUserId(shortId: string): bigint | null {
    const parsed = parseShortUserId(shortId);
    return parsed === null ? null : (this.#userIdMap.resolve(parsed) ?? null);
  }

  setSystemPrompt(systemPrompt: string): void {
    this.#systemPrompt = systemPrompt;
  }

  /** Applies one injected batch: the newest state wins, senders accumulate. */
  applyInjection(injection: {
    readonly callerUserId: bigint | null;
    readonly completion: CompletionContext | null;
    readonly directImages: readonly DirectImage[];
    readonly omittedNewMessages: number;
    readonly text: string;
    readonly visibleSenders: readonly VisibleSender[];
  }): void {
    this.#userPrompt = injection.text;
    this.#directImages = [...injection.directImages];
    this.#omittedNewMessages = injection.omittedNewMessages;
    this.#completion = injection.completion;
    // A completion is not a new user request and must not inherit the previous
    // speaker's authority to inspect or cancel their tasks.
    if (injection.completion !== null || injection.callerUserId !== null) {
      this.#callerUserId = injection.callerUserId;
    }
    for (const sender of injection.visibleSenders) {
      this.#visibleSenders.set(sender.userId.toString(), sender);
    }
  }

  finishCompletion(): void {
    this.#completion = null;
  }

  /** Drops state for messages that no longer exist in the retained segment. */
  retainVisibleSenders(senders: readonly VisibleSender[]): void {
    this.#visibleSenders = new Map(senders.map((sender) => [sender.userId.toString(), sender]));
  }

  /** Recomputes the trusted caller after history was collected. */
  setCallerUserId(callerUserId: bigint | null): void {
    this.#callerUserId = this.#completion === null ? callerUserId : null;
  }
}

/** Neutral context for registry-time tool validation, outside any invocation. */
export function previewContext(): InvocationContext {
  return {
    invocationId: 0n,
    conversationId: 0n,
    chatId: 0n,
    threadId: 0n,
    systemPrompt: '',
    userPrompt: '',
    directImages: [],
    visibleSenders: new Map(),
    callerUserId: null,
    completion: null,
    omittedNewMessages: 0,
  };
}
