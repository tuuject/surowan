/**
 * The Telegram host: the one place that knows what Telegram actually looks like.
 *
 * Everything transport-specific lives here - the parameter and response shapes,
 * how a mention becomes a clickable entity or a MarkdownV2 inline link, which
 * failures are worth retrying, and how the chat action stays fresh. The platform
 * above sees only `ImHost` from `src/platform/im-host.ts`.
 */

import { GrammyError, HttpError, InputFile, type Api } from 'grammy';
import type { MessageEntity } from 'grammy/types';

import {
  conversationKey,
  resolveConversationPolicy,
  type ImActivity,
  type ImComposedPart,
  type ImConversationPolicy,
  type ImConversationRef,
  type ImDelivery,
  type ImDeliveryFailure,
  type ImDeliveryOutcome,
  type ImDeliveryRequest,
  type ImDeliveredMessage,
  type ImDeliveryTarget,
  type ImHost,
  type ImMentionRequest,
  type ImOutgoingPart,
  type ImSendRatePolicy,
  type SenderId,
} from '../../platform/im-host.ts';

const REFRESH_MILLISECONDS = 4_000;
// Telegram retains an action for up to five seconds; leave that tail inside the cap.
const CAP_MILLISECONDS = 55_000;

export interface TelegramSendResponse {
  readonly message_id: number;
  readonly date: number;
  readonly chat: { readonly id: number };
  /** Sizes of a sent photo (largest last); present on image deliveries. */
  readonly photo?:
    | readonly {
        readonly file_id: string;
        readonly file_unique_id: string;
        readonly width: number;
        readonly height: number;
      }[]
    | undefined;
}

export interface TelegramMessageOptions {
  readonly message_thread_id?: number;
  readonly parse_mode?: 'MarkdownV2';
  readonly reply_parameters?: { readonly message_id: number };
  readonly entities?: MessageEntity[];
}

export interface TelegramMediaOptions {
  readonly message_thread_id?: number;
  readonly reply_parameters?: { readonly message_id: number };
  readonly caption?: string;
}

/**
 * Everything this host asks of a Telegram client. Narrower than grammY's `Api`
 * on purpose, so a test can stand in for Telegram without a network.
 */
export interface TelegramTransport {
  /** Cosmetic status only; hosts without chat actions can omit it. */
  sendTyping?(chatId: string, threadId: bigint, signal: AbortSignal): Promise<void>;
  sendMessage(chatId: string, text: string, options: TelegramMessageOptions): Promise<TelegramSendResponse>;
  sendSticker(chatId: string, sticker: string, options: TelegramMessageOptions): Promise<TelegramSendResponse>;
  /**
   * Delivers one generated picture. Optional so hosts that never ship image
   * generation can reuse this interface; the send tool rejects image sends
   * with a clear error when it is missing.
   */
  sendGeneratedPhoto?(
    chatId: string,
    bytes: Uint8Array,
    fileName: string,
    options: TelegramMediaOptions,
  ): Promise<TelegramSendResponse>;
  /** Delivers several pictures of one generation as a single album. */
  sendGeneratedPhotoGroup?(
    chatId: string,
    pictures: readonly { readonly bytes: Uint8Array; readonly fileName: string }[],
    options: TelegramMediaOptions,
  ): Promise<TelegramSendResponse[]>;
}

/** Adapts a grammY client to {@link TelegramTransport}. */
export function grammyTelegramTransport(api: Api): TelegramTransport {
  // Telegram drops a chat action after five seconds, so overlapping pings and
  // pings that arrive less than one refresh apart are both wasted requests.
  const typingRequests = new Map<string, { readonly at: number; pending: boolean }>();
  const narrow = (message: TelegramSendResponse): TelegramSendResponse => {
    const raw = message.photo;
    const sizes = Array.isArray(raw) ? raw : undefined;
    return {
      message_id: message.message_id,
      date: message.date,
      chat: message.chat,
      ...(sizes === undefined ? {} : { photo: sizes }),
    };
  };
  return {
    sendTyping: async (chatId, threadId, signal) => {
      const key = `${chatId}:${threadId}`;
      const previous = typingRequests.get(key);
      if (signal.aborted || (previous !== undefined && (previous.pending || Date.now() - previous.at < 4_000))) {
        return;
      }
      const current = { at: Date.now(), pending: true };
      typingRequests.set(key, current);
      try {
        await api.sendChatAction(
          chatId,
          'typing',
          threadId === 0n ? {} : { message_thread_id: Number(threadId) },
          // grammY still types its signal as the older abort-controller shim; it forwards abort events.
          AbortSignal.any([signal, AbortSignal.timeout(3_500)]) as unknown as Parameters<Api['sendChatAction']>[3],
        );
      } finally {
        current.pending = false;
        const cleanup = setTimeout(
          () => {
            if (typingRequests.get(key) === current) {
              typingRequests.delete(key);
            }
          },
          Math.max(0, current.at + 4_000 - Date.now()),
        );
        // Never hold the process open for a cosmetic status.
        cleanup.unref?.();
      }
    },
    sendMessage: async (chatId, text, options) => narrow(await api.sendMessage(chatId, text, options)),
    sendSticker: async (chatId, sticker, options) => narrow(await api.sendSticker(chatId, sticker, options)),
    sendGeneratedPhoto: async (chatId, bytes, fileName, options) => {
      const message = await api.sendPhoto(chatId, new InputFile(Buffer.from(bytes), fileName), {
        ...(options.message_thread_id === undefined ? {} : { message_thread_id: options.message_thread_id }),
        ...(options.reply_parameters === undefined ? {} : { reply_parameters: options.reply_parameters }),
        ...(options.caption === undefined ? {} : { caption: options.caption }),
      });
      return narrow(message);
    },
    sendGeneratedPhotoGroup: async (chatId, pictures, options) => {
      const messages = await api.sendMediaGroup(
        chatId,
        pictures.map((picture, index) => ({
          type: 'photo' as const,
          media: new InputFile(Buffer.from(picture.bytes), picture.fileName),
          ...(index === 0 && options.caption !== undefined ? { caption: options.caption } : {}),
        })),
        {
          ...(options.message_thread_id === undefined ? {} : { message_thread_id: options.message_thread_id }),
          ...(options.reply_parameters === undefined ? {} : { reply_parameters: options.reply_parameters }),
        },
      );
      return messages.map(narrow);
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Mentions                                                                   */
/* -------------------------------------------------------------------------- */

/** The visible label of a mention, and nothing else. */
export function telegramMentionLabel(mention: ImMentionRequest): string {
  return mention.displayName.length > 0 ? `@${mention.displayName}` : `@${mention.senderId.toString()}`;
}

/** The deep link Telegram uses to ping a user by id. */
export function telegramMentionUrl(senderId: SenderId): string {
  return `tg://user?id=${senderId.toString()}`;
}

/** MarkdownV2 needs these escaped inside a link label. */
export function escapeMarkdownV2LinkText(text: string): string {
  return text.replaceAll(/([_*[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

/**
 * Shapes one part the way Telegram needs it, without sending anything. The
 * platform measures the result, so the size checks see what the wire will see.
 */
export function composeTelegramPart(part: ImOutgoingPart): ImComposedPart {
  switch (part.kind) {
    case 'text': {
      if (part.mention === undefined) {
        return { text: part.text, markup: part.markup ?? null };
      }
      const label = telegramMentionLabel(part.mention);
      const url = telegramMentionUrl(part.mention.senderId);
      if (part.markup === 'markdown_v2') {
        return { text: `[${escapeMarkdownV2LinkText(label)}](${url}) ${part.text}`, markup: 'markdown_v2' };
      }
      return { text: `${label} ${part.text}`, markup: null };
    }
    case 'photo':
    case 'photo_album':
      return { text: part.caption ?? null, markup: null };
    case 'sticker':
      return { text: null, markup: null };
  }
}

/** The entity that makes the mention prefix clickable in a plain text message. */
function mentionEntities(part: ImOutgoingPart): MessageEntity[] | undefined {
  if (part.kind !== 'text' || part.mention === undefined || part.markup === 'markdown_v2') {
    return undefined;
  }
  const label = telegramMentionLabel(part.mention);
  return [
    {
      type: 'text_link',
      offset: 0,
      length: label.length,
      url: telegramMentionUrl(part.mention.senderId),
    },
  ];
}

/* -------------------------------------------------------------------------- */
/* Failure classification                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Turns whatever a Telegram client threw into the contract's vocabulary. A
 * caller branches on `reason`; only this function knows about HTTP status codes
 * and grammY error classes.
 */
export function classifyTelegramDeliveryError(error: unknown): ImDeliveryFailure {
  if (error instanceof GrammyError) {
    if (error.error_code === 429) {
      return {
        reason: 'rate_limited',
        code: 'telegram_429',
        outcomeUnknown: false,
        retryAfterSeconds: error.parameters.retry_after ?? 1,
        description: error.description,
      };
    }
    if (error.error_code >= 500) {
      return {
        reason: 'transient',
        code: `telegram_${error.error_code}`,
        outcomeUnknown: true,
        description: error.description,
      };
    }
    return {
      reason: 'permanent',
      code: `telegram_${error.error_code}`,
      outcomeUnknown: false,
      description: error.description,
    };
  }
  if (error instanceof HttpError) {
    return {
      reason: 'network',
      code: 'telegram_network',
      outcomeUnknown: true,
      description: error.message,
    };
  }
  return {
    reason: 'network',
    code: 'telegram_network',
    outcomeUnknown: true,
    description: error instanceof Error ? error.message : String(error),
  };
}

/** An abort is not a transport failure, but callers still branch on a failure. */
export function abortedTelegramDelivery(): ImDeliveryFailure {
  return {
    reason: 'aborted',
    code: 'aborted',
    outcomeUnknown: true,
    description: 'the send was aborted',
  };
}

/* -------------------------------------------------------------------------- */
/* The host                                                                   */
/* -------------------------------------------------------------------------- */

export interface TelegramHostOptions {
  readonly transport: TelegramTransport;
  /** Read per call, so a configuration reload reaches the next delivery. */
  readonly sendRate: () => ImSendRatePolicy;
  /** Injectable for tests; millisecond clock. */
  readonly now?: () => number;
}

export interface TelegramHost extends ImHost {
  readonly host: 'telegram';
  readonly delivery: ImDelivery;
  readonly activity: ImActivity;
}

export function createTelegramHost(options: TelegramHostOptions): TelegramHost {
  const { transport } = options;
  const now = options.now ?? (() => Date.now());

  const policyFor = (conversation: ImConversationRef): ImConversationPolicy => {
    // Resolved per call rather than cached: it is pure, and the configured send
    // rate can change under a running process.
    return resolveConversationPolicy({
      host: 'telegram',
      scope: conversation.scope,
      sendRate: options.sendRate(),
    });
  };

  /** One chat action round per conversation; repeats refresh the same round. */
  const activityRounds = new Map<string, { readonly controller: AbortController; readonly stop: () => void }>();

  const activity: ImActivity = {
    start: (target: ImDeliveryTarget) => {
      const key = conversationKey(target.conversation);
      if (activityRounds.has(key)) {
        return;
      }
      if (transport.sendTyping === undefined || target.policy.activity.kind === 'none') {
        return;
      }
      const controller = new AbortController();
      const expiresAt = now() + (target.policy.activity.capMs ?? CAP_MILLISECONDS);
      const refreshMs = target.policy.activity.refreshMs ?? REFRESH_MILLISECONDS;
      const chatId = target.conversation.chatId.toString();
      const threadId = BigInt(target.conversation.topicId ?? 0);
      const ping = (): void => {
        void Promise.resolve()
          .then(() => {
            if (controller.signal.aborted || now() >= expiresAt) {
              return undefined;
            }
            return transport.sendTyping?.(chatId, threadId, controller.signal);
          })
          .catch(() => undefined);
      };
      ping();
      const refresh = setInterval(ping, refreshMs);
      const cap = setTimeout(() => stopRound(key), Math.max(0, expiresAt - now()));
      refresh.unref?.();
      cap.unref?.();
      activityRounds.set(key, {
        controller,
        stop: () => {
          clearInterval(refresh);
          clearTimeout(cap);
          controller.abort();
        },
      });
    },
    stop: (conversation: ImConversationRef) => stopRound(conversationKey(conversation)),
    stopAll: () => {
      for (const key of [...activityRounds.keys()]) {
        stopRound(key);
      }
    },
  };

  function stopRound(key: string): void {
    const round = activityRounds.get(key);
    if (round === undefined) {
      return;
    }
    activityRounds.delete(key);
    round.stop();
  }

  const delivery: ImDelivery = {
    compose: composeTelegramPart,
    // A reply may address another topic of the same chat, which is a different
    // conversation row.
    crossConversationTargets: true,
    deliver: async (request: ImDeliveryRequest): Promise<ImDeliveryOutcome> => {
      const messages: ImDeliveredMessage[] = [];
      const { signal } = request;
      const aborted = (): boolean => signal?.aborted === true;
      for (const [partIndex, part] of request.parts.entries()) {
        if (aborted()) {
          return messages.length === 0
            ? { kind: 'rejected', failure: abortedTelegramDelivery() }
            : { kind: 'delivered', messages, recordedByHost: false };
        }
        try {
          const response = await sendPart(part, request);
          const largest = response.photo?.[response.photo.length - 1];
          messages.push({
            partIndex,
            messageId: BigInt(response.message_id),
            sentAtSeconds: response.date,
            ...(largest === undefined
              ? {}
              : {
                  photo: {
                    fileRef: largest.file_id,
                    fileUniqueRef: largest.file_unique_id,
                    width: largest.width,
                    height: largest.height,
                  },
                }),
          });
        } catch (error) {
          if (error instanceof MissingTransportCapability) {
            return {
              kind: 'rejected',
              failure: {
                reason: 'unsupported',
                code: 'send_unsupported',
                outcomeUnknown: false,
                description: error.message,
              },
            };
          }
          if (aborted()) {
            // A transport that rejects on abort reports the abort, not a failure.
            if (messages.length === 0) {
              return { kind: 'rejected', failure: abortedTelegramDelivery() };
            }
            return { kind: 'delivered', messages, recordedByHost: false };
          }
          // A published part already cleared the chat action; keep it that way.
          if (messages.length > 0) {
            stopRound(conversationKey(request.target.conversation));
          }
          return { kind: 'rejected', failure: classifyTelegramDeliveryError(error) };
        }
      }
      // Telegram keeps showing the action for a moment after the message lands.
      stopRound(conversationKey(request.target.conversation));
      return { kind: 'delivered', messages, recordedByHost: false };
    },
  };

  async function sendPart(part: ImOutgoingPart, request: ImDeliveryRequest): Promise<TelegramSendResponse> {
    const chatId = request.target.conversation.chatId.toString();
    const base = {
      ...(request.target.conversation.topicId === null
        ? {}
        : { message_thread_id: request.target.conversation.topicId }),
      ...(request.replyToMessageId === undefined
        ? {}
        : { reply_parameters: { message_id: Number(request.replyToMessageId) } }),
    };
    const composed = composeTelegramPart(part);
    switch (part.kind) {
      case 'text': {
        const entities = mentionEntities(part);
        return await transport.sendMessage(chatId, composed.text ?? part.text, {
          ...base,
          ...(composed.markup === null ? {} : { parse_mode: 'MarkdownV2' as const }),
          ...(entities === undefined ? {} : { entities }),
        });
      }
      case 'sticker':
        return await transport.sendSticker(chatId, part.stickerRef, base);
    case 'photo': {
        if (transport.sendGeneratedPhoto === undefined) {
          throw new MissingTransportCapability('generated photos');
        }
        return await transport.sendGeneratedPhoto(chatId, part.bytes, part.fileName, {
          ...base,
          ...(part.caption === undefined ? {} : { caption: part.caption }),
        });
      }
      case 'photo_album': {
        if (transport.sendGeneratedPhotoGroup === undefined) {
          throw new MissingTransportCapability('generated photo albums');
        }
        const responses = await transport.sendGeneratedPhotoGroup(chatId, part.pictures, {
          ...base,
          ...(part.caption === undefined ? {} : { caption: part.caption }),
        });
        const [first] = responses;
        if (first === undefined) {
          throw new Error('the album delivery returned no messages');
        }
        return first;
      }
    }
  }

  return {
    host: 'telegram',
    policy: policyFor,
    delivery,
    activity,
  };
}

/** Raised when a host is asked for a delivery kind its transport cannot make. */
export class MissingTransportCapability extends Error {
  readonly capability: string;

  constructor(capability: string) {
    super(`this host cannot deliver ${capability}`);
    this.name = 'MissingTransportCapability';
    this.capability = capability;
  }
}
