import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { CORE_AGENT_PROTOCOL } from '../../platform/agent-protocol.ts';
import { type AgentPromptLayers, composeAgentPrompt } from '../../platform/agent-prompt.ts';
import type { RawConfig } from '../../platform/config/index.ts';
import type { HostKind } from '../../platform/im-host/identity.ts';
import type { CompletionContext, DirectImage, VisibleSender } from '../../platform/invocation-context.ts';
import { resolveInvocationPolicy, type InvocationPolicy } from '../../platform/invocation-policy.ts';
import type { PromptTemplateModel, PromptTemplateValues } from '../../platform/prompt-template.ts';
import { PRODUCT_KNOWLEDGE_INDEX } from '../../platform/product-knowledge.ts';
import { renderSkillIndexPrompt, type SystemSkill } from '../../platform/system-resources.ts';
import type { BusinessStore } from '../../store/store.ts';
import { LongTaskService } from '../../store/long-tasks/index.ts';
import { parseSnapshotLines } from './format.ts';
import { renderInjection, stickerCatalogFor } from './render.ts';
import type { ContextInjector } from '../injector.ts';
import type { ContextRefStore } from '../refs.ts';
import type { ContextHeader } from '../store.ts';
import { MemoryStore } from '../memory.ts';
import { activeVisionModel } from '../../platform/config/resolve.ts';

/**
 * The batch of new room messages does not fit the remaining context budget.
 *
 * Thrown before any reply ref is registered or a checkpoint is written: the
 * injection left no trace, so the same batch can be retried once the window
 * grows or the transcript shrinks.
 */
export class InjectionTooLargeError extends Error {
  override readonly name = 'InjectionTooLargeError';
}

const MEMORY_GUIDANCE =
  'Memory: short-term notes you deliberately saved for this conversation with the add_memory capability (called via execute). Keep each note under 100 characters; the hard limit is 150. Notes expire after their TTL (1 day by default). Delete wrong or obsolete notes with the delete_memory capability. Setting a long TTL nominates stable knowledge for human review; durable rules live in agents.md and are curated by humans.';

interface InvocationIdentityRow {
  readonly conversation_id: bigint;
  readonly chat_id: bigint;
  readonly host_kind: HostKind;
  readonly telegram_chat_id: bigint | null;
  readonly message_thread_id: bigint;
  readonly chat_type: string;
  readonly bucket_kind: 'realtime' | 'startup_catch_up';
  readonly bucket_id: bigint;
}

export interface ContextIdentity {
  readonly invocationId: bigint;
  readonly conversationId: bigint;
  /** The host's chat id: Telegram chat id, or the internal chat id of a room. */
  readonly chatId: bigint;
  readonly hostKind: HostKind;
  readonly threadId: bigint;
  readonly chatType: string;
  readonly bucketKind: 'realtime' | 'startup_catch_up';
  readonly completion: CompletionContext | null;
  readonly timezone: string;
  /** Everything the run needs from the host, resolved once. */
  readonly policy: InvocationPolicy;
}

export interface StablePrompt {
  readonly systemPrompt: string;
  readonly systemPromptHash: string;
  /** Current prompt layers and template values; scene tests replace only global/group. */
  readonly promptLayers: AgentPromptLayers;
  readonly templateValues: PromptTemplateValues;
}

export interface InjectionInput {
  readonly header: ContextHeader;
  readonly identity: ContextIdentity;
  readonly bucketId: bigint;
  /** Sequence number the injection message will occupy in the canonical history. */
  readonly seq: bigint;
  /**
   * Telegram message IDs already carried by the retained transcript. History
   * rows for them are not re-rendered — the transcript *is* the history. Rows
   * that were never injected (a message blocked by a participation gate, for
   * example) still have to be rendered, or the model would never see them.
   */
  readonly injectedMessageIds: ReadonlySet<string>;
  readonly sleepy: boolean;
  readonly supportsImages: boolean;
  readonly contextWindow: number;
  readonly toolDefinitionCharacters: number;
  readonly maxOutputTokens: number;
  /** Estimated characters already held by the retained transcript. */
  readonly transcriptCharacters: number;
  /**
   * The newest sticker catalog the retained transcript already carries, or `null`.
   * The catalog is rendered only when it differs: it is the same few hundred
   * characters on every batch, and each copy lands in the canonical history, so
   * a long-lived run used to accumulate one copy per injection.
   */
  readonly carriedStickerCatalog: string | null;
  /** Per-injector signatures the retained transcript still carries; names follow the registered injectors. */
  readonly carriedInjections: ReadonlyMap<string, ReadonlySet<string>>;
  readonly agentModel: PromptTemplateModel;
  readonly now?: Date;
}

export interface Injection {
  readonly text: string;
  readonly completion: CompletionContext | null;
  readonly directImages: readonly DirectImage[];
  /** `img_` reference of this batch mapped to the media row it authorizes. */
  readonly mediaRefs: ReadonlyMap<string, bigint>;
  readonly visibleSenders: readonly VisibleSender[];
  readonly callerUserId: bigint | null;
  readonly omittedNewMessages: number;
  readonly messageCount: number;
  readonly historyCount: number;
  /** The current catalog, whether or not this batch had to render it. */
  readonly stickerCatalog: string;
  /** One entry per registered context injector, in run order; `count` is 0 when nothing was injected. */
  readonly injections: readonly ContextInjectionContribution[];
}

export interface ContextInjectionContribution {
  readonly name: string;
  readonly text: string;
  readonly signatures: readonly string[];
  readonly count: number;
}

export class ContextBuilder {
  readonly #store: BusinessStore;
  readonly #memory: MemoryStore;
  readonly #skills: readonly SystemSkill[];
  readonly #refs: ContextRefStore;
  readonly #injectors: readonly ContextInjector[];

  constructor(
    store: BusinessStore,
    refs: ContextRefStore,
    skills: readonly SystemSkill[] = [],
    injectors: readonly ContextInjector[] = [],
  ) {
    this.#store = store;
    this.#memory = new MemoryStore(store.orm);
    this.#refs = refs;
    this.#skills = skills;
    this.#injectors = injectors;
  }

  identity(config: RawConfig, invocationId: bigint): ContextIdentity {
    const identity = this.#store.orm
      .all<InvocationIdentityRow>(
        sql`SELECT i.conversation_id, c.id AS chat_id, c.host_kind, c.telegram_chat_id,
                v.message_thread_id, c.type AS chat_type,
                b.kind AS bucket_kind, b.id AS bucket_id
         FROM invocations i
         JOIN buckets b ON b.id = i.bucket_id
         JOIN conversations v ON v.id = i.conversation_id
         JOIN chats c ON c.id = v.chat_id
         WHERE i.id = ${invocationId}`,
      )
      .at(0);
    if (identity === undefined) {
      throw new Error(`Invocation ${invocationId} does not exist`);
    }
    const hostKind: HostKind = identity.host_kind;
    // A Telegram chat is addressed by its platform id; a room by its internal
    // chat id. Neither is ever used as the other host's id.
    const chatId = hostKind === 'telegram' ? (identity.telegram_chat_id ?? 0n) : identity.chat_id;
    const policy = resolveInvocationPolicy(config, this.#store.orm, {
      hostKind,
      chatId,
      chatType: identity.chat_type,
    });
    return {
      invocationId,
      conversationId: identity.conversation_id,
      chatId: policy.chatId,
      hostKind,
      threadId: identity.message_thread_id,
      chatType: identity.chat_type,
      bucketKind: identity.bucket_kind,
      completion: new LongTaskService(this.#store.orm).getCompletion(invocationId, identity.bucket_id) ?? null,
      timezone: policy.timezone,
      policy,
    };
  }

  /**
   * The stable part of the prompt: everything that may live for the whole
   * Conversation Context. Anything that changes per invocation (time, memory,
   * sleep state, completion receipt, catch-up note) is rendered by
   * `renderInjection` instead, because a changing system prompt invalidates the
   * context and the provider prefix cache every run.
   */
  buildSystemPrompt(
    config: RawConfig,
    identity: ContextIdentity,
    supportsImages: boolean,
    agentModel: PromptTemplateModel,
    /** Optional per-invocation visibility rule; hides capability skills that are off. */
    options?: {
      readonly skillFilter?: (skill: SystemSkill) => boolean;
      readonly imageInput?: 'direct' | 'on_demand';
    },
  ): StablePrompt {
    const vision = activeVisionModel(config.vision);
    const templateValues: PromptTemplateValues = {
      agent: agentModel,
      vision: { provider: vision?.provider ?? '', model: vision?.model ?? '' },
      timezone: identity.timezone,
    };
    const conversationMode =
      identity.chatType === 'private' ? 'Conversation mode: private chat.' : 'Conversation mode: group chat.';
    const directImages = supportsImages && options?.imageInput !== 'on_demand';
    const hostImages = identity.hostKind === 'telegram' ? 'Telegram images and Stickers' : 'images posted in the room';
    const imageHandling =
      vision === undefined
        ? directImages
          ? 'Photos and supported image Documents from the newest injected messages are attached directly to the multimodal Agent input, in the same order as the [kind figure_N img_ref] media lines inside the messages. Treat each attached image as the media of the message that lists the matching figure_N. Attachments are not kept, and no vision model is configured: older images, earlier figure_N images and Stickers cannot be inspected, and the read_image capability is unavailable. Do not claim visual details you cannot see.'
          : `No vision model is configured: ${hostImages} cannot be inspected, and the read_image capability is unavailable. Do not claim visual details you cannot see.`
        : directImages
          ? 'Photos and supported image Documents from the newest injected messages are attached directly to the multimodal Agent input, in the same order as the [kind figure_N img_ref] media lines inside the messages. Treat each attached image as the media of the message that lists the matching figure_N. Attachments are not kept: older images, including earlier figure_N images, are inspected on demand with the read_image capability (called via execute) using their img_ refs. read_image never accepts figure_N refs.'
          : `${hostImages.charAt(0).toUpperCase()}${hostImages.slice(1)} are available through the read_image capability (called via execute). Call it when visual details are needed.`;
    const stickerCatalog = stickerCatalogFor(this.#store.orm, identity.hostKind);
    const stickerCatalogHandling =
      stickerCatalog.length === 0
        ? ''
        : 'An untrusted sticker catalog is included as sticker_id:emoji entries. Emoji is only a coarse hint. To inspect one or more candidates and authorize sending, call the search_stickers capability via execute with ids; use only the returned sticker_ref with send. search_stickers also supports semantic queries.';
    // Everything in this array is hashed below, so a change to the skill index or
    // to the sticker catalog's presence restarts each Conversation Context on its
    // next invocation. Scene tests reuse the same current layers, with only the
    // global/group templates replaceable.
    const skillIndex = options?.skillFilter === undefined ? this.#skills : this.#skills.filter(options.skillFilter);
    const promptLayers: AgentPromptLayers = {
      prefix: [
        CORE_AGENT_PROTOCOL,
        PRODUCT_KNOWLEDGE_INDEX,
        renderSkillIndexPrompt(skillIndex),
        imageHandling,
        stickerCatalogHandling,
      ]
        .filter((part) => part.length > 0)
        .join('\n\n'),
      global: config.agent.system_prompt,
      middle: [conversationMode, MEMORY_GUIDANCE].filter((part) => part.length > 0).join('\n\n'),
      // The chat entry contributes its instructions to the group layer. A room
      // has no chat entry, so the layer is empty and stable.
      group: identity.policy.instructions,
    };
    const systemPrompt = composeAgentPrompt(promptLayers, templateValues);
    return {
      systemPrompt,
      systemPromptHash: createHash('sha256').update(systemPrompt).digest('hex'),
      promptLayers,
      templateValues,
    };
  }

  /**
   * Renders one injected batch: a trusted runtime-state block followed by the
   * untrusted Telegram snapshots of exactly this batch. The retained transcript
   * is not replayed — except for history rows that never reached it (a message
   * blocked by a participation gate, for example), which are the only way the
   * model can still see them.
   */
  renderInjection(config: RawConfig, input: InjectionInput): Injection {
    // Rendering registers refs as it goes. A refused batch must leave none of
    // them behind, so the whole render commits or rolls back as one unit.
    return this.#store.transaction(() =>
      renderInjection(
        {
          orm: this.#store.orm,
          memory: this.#memory,
          refs: this.#refs,
          injectors: this.#injectors,
          InjectionTooLargeError,
        },
        config,
        input,
      ),
    );
  }

  /**
   * Rebuilds the senders visible in a retained injection batch. This only reads
   * back the message headers `renderInjection` wrote; it keeps visible users available after the agent cache was evicted or
   * the process restarted.
   */
  static collectVisibleSenders(text: string): VisibleSender[] {
    const senders = new Map<string, VisibleSender>();
    for (const snapshot of parseSnapshotLines(text)) {
      const sender = snapshot.sender;
      if (sender.id === null) {
        continue;
      }
      senders.set(sender.id, {
        userId: BigInt(sender.id),
        displayName: sender.name,
        username: sender.username,
      });
    }
    return [...senders.values()];
  }

  /**
   * The sticker catalog a transcript batch carries, or `null`. The block is
   * runtime-written with literal newlines around it; Telegram text only ever
   * appears on indented body lines, so it cannot forge the block.
   */
  static collectStickerCatalog(text: string): string | null {
    const matches = [...text.matchAll(/<untrusted_sticker_catalog>\n([^\n]*)\n<\/untrusted_sticker_catalog>/g)];
    return matches.at(-1)?.[1] ?? null;
  }

  /**
   * Telegram message IDs already carried by a transcript batch. Used to skip
   * re-rendering history the transcript already holds.
   */
  static collectInjectedMessageIds(text: string): string[] {
    return [...new Set(parseSnapshotLines(text).map((snapshot) => snapshot.message_id))];
  }
}
