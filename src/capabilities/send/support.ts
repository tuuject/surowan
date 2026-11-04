/**
 * Shapes and pure helpers shared by the send and send_reply tools: the tool
 * environment, input narrowing, and the wording each host's result uses.
 *
 * Split out of send-tool.ts; the schemas and the tools themselves stay there.
 */

import type { Static } from 'typebox';
import { type ImConversationRef, toSenderId } from '../../platform/im-host/identity.ts';
import type { ImDeliveryFailure, ImMentionRequest, ImOutgoingPart } from '../../platform/im-host/delivery.ts';
import type { ImHost } from '../../platform/im-host/index.ts';
import type { AgentRuntimeConfig, EmptyTextSendStrategy } from '../../platform/config/index.ts';
import type { CapabilityRefResolver, InvocationContext } from '../../platform/invocation-context.ts';
import type { BusinessStore } from '../../store/store.ts';
import type { SendInputSchema, SendToolInput } from './index.ts';

export type { EmptyTextSendStrategy };

/**
 * Tool error for a send held back by the barrier. The new batch is injected at
 * the next turn boundary, so the model reads it right after this result.
 */
export const SEND_BARRIER_TEXT =
  'Not sent: new messages arrived in this conversation before this reply went out. They follow as a new batch; read them, then decide again what, if anything, to send. One message can answer both batches when they continue the same discussion; when they are separate discussions, answer each with its own send.';

/** Duplicate rejections an invocation may collect; one more ends the run. */
export const DUPLICATE_SEND_REJECTION_LIMIT = 3;

/** The guard option for `agent.send_duplicate_guard_enabled`; only an explicit `false` turns it off. */
export function duplicateSendGuard(
  enabled: boolean | undefined,
  onRejected: () => void = () => {},
): Pick<SendToolEnvironment, 'duplicateSendGuard'> {
  return enabled === false ? {} : { duplicateSendGuard: { onRejected } };
}

export const SEND_DUPLICATE_TEXT =
  'Not sent: send_duplicate. This exact message was already published in this run and Telegram accepted it. Do not send it again; if nothing else needs saying, stop without calling send.';

export const SEND_REPEAT_TEXT =
  'Not sent: send_duplicate. Your previous message in this run already published this same content and Telegram accepted it; changing or omitting reply_to_message_id does not make it a new message. Do not send it again; if nothing else needs saying, stop without calling send.';

export const SEND_BYPASS_TEXT =
  'Not sent: send_bypass. This exact message was already rejected by the reply policy in this run; omitting or changing reply_to_message_id does not make it sendable. Write something new, or stop without calling send.';

/** The fields that say what one message carries; `send` and every `send_reply` part share them. */
type SendContent = Pick<
  Static<typeof SendInputSchema>,
  'kind' | 'text' | 'parse_mode' | 'sticker_ref' | 'image_generation_id' | 'image_ref'
>;

/** The kind a message resolves to: text unless it names a sticker or image; `undefined` when ambiguous. */
function inferredKind(input: SendContent): SendContent['kind'] {
  return (
    input.kind ??
    (input.sticker_ref === undefined && input.image_generation_id === undefined && input.image_ref === undefined
      ? 'text'
      : undefined)
  );
}

/** How many silent empty-text sends in a row end the run, matching the repeated-failure breaker. */
export const SILENT_SEND_LIMIT = 3;

/** What a silent-success result tells the model: handled, but nothing was published. */
export const silentSendText = (part?: number): string =>
  part === undefined
    ? 'Handled without sending: the call had no text, and the silent-success empty-text strategy processed it. No Telegram message was published, so this is a successful fallback rather than a delivery. Do not retry the same empty call.'
    : `Part ${part} was handled without sending: it had no text, and the silent-success empty-text strategy processed it. No Telegram message was published for that part.`;

/**
 * The strategy in force for one tool environment. A fallback list without an
 * explicit strategy keeps the pre-strategy behavior (random text).
 */
export function effectiveEmptyTextStrategy(
  environment: Pick<SendToolEnvironment, 'emptyTextStrategy' | 'emptyTextFallback'>,
): EmptyTextSendStrategy {
  return environment.emptyTextStrategy ?? (environment.emptyTextFallback === undefined ? 'reject' : 'random_text');
}

/** The environment option for the resolved `agent.send_empty_text_strategy`. */
export function emptyTextHandling(
  agent: Pick<AgentRuntimeConfig, 'send_empty_text_strategy' | 'send_empty_text_fallback_texts'>,
): Pick<SendToolEnvironment, 'emptyTextStrategy' | 'emptyTextFallback'> {
  return {
    emptyTextStrategy: agent.send_empty_text_strategy,
    ...(agent.send_empty_text_strategy === 'random_text'
      ? { emptyTextFallback: agent.send_empty_text_fallback_texts }
      : {}),
  };
}

/**
 * Gives a text message the model left without text one of the configured
 * fallback texts, picked at random. It runs before anything else reads the
 * input, so every check, guard and audit row sees what is actually published.
 * The fallback goes out as plain text: nothing escaped it for any markup.
 */
export function fillEmptyText<T extends SendContent>(input: T, fallback: readonly string[] | undefined): T {
  const text = fallback?.[Math.floor(Math.random() * fallback.length)];
  if (text === undefined || input.text !== undefined || inferredKind(input) !== 'text') {
    return input;
  }
  const { parse_mode: _plain, ...rest } = input;
  return { ...rest, text } as T;
}

/** Tells the model which words went out for a message it sent without text. */
export const fallbackSentText = (text: string, part?: number): string =>
  ` ${part === undefined ? 'The call' : `Part ${part}`} had no text, so the configured fallback text ${JSON.stringify(text)} was sent.`;

/**
 * Resolves the kind of one message and keeps only the fields that apply to it.
 * Fields of another kind are ignored, since some models fill every optional
 * field with placeholders; what is rejected is a field that asks for something
 * the runtime would silently not do (a sticker caption, a non-image resend).
 * `problem` tells the model what to change, so it does not retry blindly.
 */
export function narrowSendInput(
  input: Static<typeof SendInputSchema>,
): { readonly send: SendToolInput } | { readonly problem: string; readonly missingText?: true } {
  const kind = inferredKind(input);
  if (kind === undefined) {
    return { problem: 'kind is required when sticker_ref, image_generation_id or image_ref is set' };
  }
  if (kind !== 'image' && input.resend === true) {
    return { problem: `resend applies only to kind:image; omit it for kind:${kind}` };
  }
  const reply = input.reply_to_message_id === undefined ? {} : { reply_to_message_id: input.reply_to_message_id };
  if (kind === 'text') {
    if (input.text === undefined) {
      // Kind falls back to text, so this is also what a send carrying nothing
      // but reply_to_message_id hits; spell out where the words go.
      return {
        problem:
          'text is missing — put the message itself in text (kind defaults to text); for a sticker or image, set kind with sticker_ref or image_generation_id. Plain assistant text is never published',
        missingText: true,
      };
    }
    const parseMode = input.parse_mode !== undefined ? { parse_mode: input.parse_mode } : {};
    return { send: { kind, text: input.text, ...parseMode, ...reply } };
  }
  if (kind === 'sticker') {
    if (input.sticker_ref === undefined) {
      return { problem: 'kind:sticker needs sticker_ref' };
    }
    if (input.text !== undefined) {
      return { problem: 'a sticker cannot carry text; send the text as its own message, or use send_reply' };
    }
    return { send: { kind, sticker_ref: input.sticker_ref, ...reply } };
  }
  const caption = input.text === undefined ? {} : { text: input.text };
  if (kind === 'file') {
    if (input.image_generation_id !== undefined && input.image_ref === undefined) {
      return { send: { kind, image_generation_id: input.image_generation_id, ...caption, ...reply } };
    }
    if (input.image_ref !== undefined && input.image_generation_id === undefined) {
      return { send: { kind, image_ref: input.image_ref, ...caption, ...reply } };
    }
    return { problem: 'kind:file needs exactly one of image_generation_id or image_ref' };
  }
  if (input.image_generation_id === undefined) {
    return { problem: 'kind:image needs image_generation_id' };
  }
  return {
    send: {
      kind: 'image',
      image_generation_id: input.image_generation_id,
      ...(input.resend === undefined ? {} : { resend: input.resend }),
      ...caption,
      ...reply,
    },
  };
}

/**
 * Whether this input is exactly a text message without `text`, and would be
 * rejected for that reason alone. Other shape errors stay errors under every
 * strategy.
 */
export function isMissingTextSend(input: Static<typeof SendInputSchema>): boolean {
  const narrowed = narrowSendInput(input);
  return 'problem' in narrowed && narrowed.missingText === true;
}

export interface SendToolEnvironment {
  readonly store: BusinessStore;
  /** The host that carries this conversation; the only thing that speaks Telegram. */
  readonly host: ImHost;
  /** The conversation the bot publishes into, resolved by the server. */
  readonly conversation: ImConversationRef;
  readonly context: InvocationContext;
  readonly capabilities: CapabilityRefResolver;
  /**
   * Sliding-window send rate limit, applied per Telegram chat: a long-lived
   * invocation may legitimately send many times, but a loop must never flood
   * one group.
   */
  readonly sendRateLimit: { readonly sendsPerWindow: number; readonly windowSeconds: number };
  readonly maxTextLength: number | undefined;
  readonly disallowBlankLines: boolean;
  readonly allowReplyMessageMultipleTimes?: boolean;
  /**
   * Duplicate send guard: rejects a text or sticker identical to one this
   * invocation already published, or repeating its last message's content
   * under another reply target, and reports each rejection so the run can
   * stop a model that keeps repeating itself. Reply-policy bypass rejections
   * (`send_bypass`) report through the same hook. Absent when the guard is off.
   */
  readonly duplicateSendGuard?: { readonly onRejected: () => void };
  /**
   * What a text message without `text` does. Absent means `reject`; a
   * fallback list without a strategy keeps the pre-strategy random behavior.
   */
  readonly emptyTextStrategy?: EmptyTextSendStrategy;
  /**
   * Texts a text message without `text` is sent with under `random_text`,
   * one picked at random per message. Absent when no fallback texts apply.
   */
  readonly emptyTextFallback?: readonly string[];
  /**
   * Reports what a send tool really did: `published` for a message the host
   * accepted, `silent` for a handled empty-text call that published nothing.
   * The runtime counts consecutive silent outcomes to keep the circuit breaker.
   */
  readonly onSendOutcome?: (outcome: 'published' | 'silent') => void;
  readonly deadline: number;
  readonly bot: { readonly id: bigint; readonly displayName: string; readonly username: string | null };
  /**
   * Send barrier: returns true when this send must not go out because newer
   * messages of the conversation are about to be injected. Absent when the
   * barrier is off.
   */
  readonly holdForNewMessages?: () => boolean;
  /**
   * Resolves a generated picture set for delivery. Authorization is the
   * generation's owning conversation: `undefined` for unknown or foreign ids.
   * Absent when the host runs without image generation.
   */
  readonly imageGeneration?: {
    readonly resolve: (
      generationId: string,
      conversationId: bigint,
    ) =>
      | readonly {
          readonly assetId: string;
          readonly bytes: Uint8Array;
          readonly fileName: string;
          readonly mime: string;
        }[]
      | undefined;
  };
  /**
   * Reads one conversation-authorized media row as the host stored it, never
   * re-encoded, for a file send. Absent when this runtime cannot read media.
   */
  readonly mediaFiles?: {
    readonly read: (mediaId: bigint, signal: AbortSignal) => Promise<OutgoingFile>;
  };
}

/** One file a send delivers as it is. */
export interface OutgoingFile {
  readonly bytes: Uint8Array;
  readonly fileName: string;
  readonly mime: string;
}

/**
 * The sender this completion should mention, if any. Turning that into a
 * clickable mention is the host's job, not ours.
 */
export function completionMention(completion: InvocationContext['completion']): ImMentionRequest | null {
  const target = completion?.delivery.mentionUser;
  if (target === undefined) {
    return null;
  }
  return {
    senderId: toSenderId(target.userId),
    displayName: target.displayName,
  };
}

export type SendDetails = {
  /** The wire id, under the key Telegram consumers have always read. */
  telegramMessageId?: string;
  /** The id of the message a host published itself: a room's sequence number. */
  messageId?: string;
  replayed?: boolean;
};
export type SendReplyDetails = {
  telegramMessageIds?: string[];
  /** The same ids under a neutral key, for a host that has no wire. */
  messageIds?: string[];
};

/** Whether this host reports ids from a wire, rather than publishing them. */
export const reportsWireIds = (host: ImHost): boolean => host.host === 'telegram';

/**
 * How a send result names what it published. Telegram keeps the wire id under
 * the key and wording it has always used, so nothing that reads a send result
 * has to know which host ran it; a room reports the sequence number of the
 * message it recorded, the same number its messages and replies carry.
 */
export const sentMessageResult = (host: ImHost, messageId: bigint): string =>
  reportsWireIds(host) ? `telegram_message_id=${messageId}` : `message_id=${messageId}`;

export const sentMessagesResult = (host: ImHost, ids: readonly string[]): string =>
  reportsWireIds(host) ? `telegram_message_ids=${ids.join(',')}` : `message_ids=${ids.join(',')}`;

export const sentDetails = (host: ImHost, messageId: string, replayed?: boolean): SendDetails =>
  reportsWireIds(host)
    ? { telegramMessageId: messageId, ...(replayed === undefined ? {} : { replayed }) }
    : { messageId, ...(replayed === undefined ? {} : { replayed }) };

export const sentReplyDetails = (host: ImHost, ids: readonly string[]): SendReplyDetails =>
  reportsWireIds(host) ? { telegramMessageIds: [...ids] } : { messageIds: [...ids] };

export const sentCountText = (host: ImHost, count: number, ids: readonly string[]): string =>
  reportsWireIds(host)
    ? `Sent ${count} Telegram messages in order: ${ids.join(', ')}`
    : `Sent ${count} messages in order: ${ids.join(', ')}`;

/** A delivery the host refused, carrying the host's own classification. */
export class DeliveryRejected extends Error {
  readonly failure: ImDeliveryFailure;

  constructor(failure: ImDeliveryFailure) {
    super(`send rejected: ${failure.code}`);
    this.name = 'DeliveryRejected';
    this.failure = failure;
  }
}

/**
 * Picks the single part one audited send carries. Which part it is comes from
 * the input, never from the transport.
 */
export function resolveOutgoingPart(input: {
  readonly textPart: ImOutgoingPart | undefined;
  readonly stickerFileId: string | undefined;
  readonly generationPictures:
    | readonly { readonly bytes: Uint8Array; readonly fileName: string; readonly mime: string }[]
    | undefined;
  readonly files: readonly OutgoingFile[] | undefined;
  readonly send: Static<typeof SendInputSchema>;
}): ImOutgoingPart {
  if (input.textPart !== undefined) {
    return input.textPart;
  }
  if (input.stickerFileId !== undefined) {
    return { kind: 'sticker', stickerRef: input.stickerFileId };
  }
  if (input.files !== undefined) {
    return {
      kind: 'document',
      files: input.files.map((file) => ({ bytes: file.bytes, fileName: file.fileName, mime: file.mime })),
      ...(input.send.text === undefined ? {} : { caption: input.send.text }),
    };
  }
  const pictures = input.generationPictures;
  if (pictures === undefined) {
    throw new Error('sticker_ref is not authorized in this conversation context');
  }
  const caption = input.send.kind === 'image' && input.send.text !== undefined ? { caption: input.send.text } : {};
  if (pictures.length === 1) {
    const [only] = pictures;
    return {
      kind: 'photo',
      bytes: only?.bytes ?? new Uint8Array(),
      fileName: only?.fileName ?? 'image.png',
      mime: only?.mime ?? 'image/png',
      ...caption,
    };
  }
  return {
    kind: 'photo_album',
    pictures: pictures.map((picture) => ({
      bytes: picture.bytes,
      fileName: picture.fileName,
      mime: picture.mime,
    })),
    ...caption,
  };
}

/** Delivers one message through the full send pipeline: checks, audit, barrier and Telegram. */
export type Deliver = (
  toolCallId: string,
  input: Static<typeof SendInputSchema>,
  signal: AbortSignal | undefined,
  options: { readonly barrier: boolean },
) => Promise<{ content: { type: 'text'; text: string }[]; details: SendDetails }>;
