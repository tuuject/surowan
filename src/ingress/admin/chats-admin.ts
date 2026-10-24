import { eq } from 'drizzle-orm';
import Type, { type Static } from 'typebox';
import Compile from 'typebox/compile';
import type { AgentSettings, FileChat, FileConfig, RawConfig, TelegramSectionConfig } from '../../platform/config.ts';
import type { ConfigEdit } from '../../platform/config-write.ts';
import { resolveProactiveReply } from '../../platform/proactive-reply.ts';
import { supportedThinkingLevels } from '../../platform/thinking-levels.ts';
import type { BusinessStore } from '../../store/store.ts';
import { chatMigrations, chats } from '../../store/schema.ts';
import { AdminQueryError } from './audit.ts';
import { supervisedRestartEnabled } from './providers-admin-read.ts';
import { resolveAgentSettings } from '../../platform/config-resolve.ts';
import { ThinkingLevelSchema } from '../../platform/config-schema-model.ts';

const ChatIdSchema = Type.String({ pattern: '^-?[1-9][0-9]{0,15}$' });
const TopicIdSchema = Type.String({ pattern: '^[1-9][0-9]{0,15}$' });
// Mirrors the config file's ParticipationWindowSchema so the panel cannot write
// windows the configuration would reject. `end` additionally accepts `24:00`.
const ParticipationWindowSchema = Type.Object(
  {
    start: Type.String({ pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$' }),
    end: Type.String({ pattern: '^(([01][0-9]|2[0-3]):[0-5][0-9]|24:00)$' }),
    days: Type.Optional(Type.Array(Type.Integer({ minimum: 1, maximum: 7 }), { minItems: 1, uniqueItems: true })),
  },
  { additionalProperties: false },
);
const ParticipationBodySchema = Type.Object(
  {
    // `null` removes the Chat's active windows (inheriting the global schedule
    // or, without one, staying unrestricted); an array - including an empty one,
    // which keeps the chat trigger-only - replaces them wholesale.
    active_windows: Type.Union([Type.Array(ParticipationWindowSchema), Type.Null()]),
  },
  { additionalProperties: false },
);
const participationValidator = Compile(ParticipationBodySchema);
const ProbabilitySchema = Type.Number({ minimum: 0, maximum: 1 });
const ProactiveReplyBodySchema = Type.Union([
  Type.Object({ mode: Type.Literal('inherit') }, { additionalProperties: false }),
  Type.Object({ mode: Type.Literal('off') }, { additionalProperties: false }),
  Type.Object(
    {
      mode: Type.Literal('custom'),
      base_probability: ProbabilitySchema,
      increment: ProbabilitySchema,
      hard_pity: Type.Integer({ minimum: 1, maximum: 100 }),
    },
    { additionalProperties: false },
  ),
]);
const proactiveReplyValidator = Compile(ProactiveReplyBodySchema);
const SettingsProperties = {
  topic_ids: Type.Union([Type.Array(TopicIdSchema, { minItems: 1, uniqueItems: true }), Type.Null()]),
  provider: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  model: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  thinking_level: Type.Union([ThinkingLevelSchema, Type.Null()]),
};
const SettingsSchema = Type.Object(SettingsProperties, { additionalProperties: false });
const CreateSchema = Type.Object({ id: ChatIdSchema, ...SettingsProperties }, { additionalProperties: false });
const settingsValidator = Compile(SettingsSchema);
const createValidator = Compile(CreateSchema);

export type ChatSettingsBody = Static<typeof SettingsSchema>;
export type CreateChatBody = Static<typeof CreateSchema>;

/** Configuration IDs are numbers, but HTTP IDs stay strings until the safe-integer check. */
export function parseChatId(value: string): number {
  if (!/^-?[1-9][0-9]{0,15}$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new AdminQueryError('invalid_chat_id', 'Chat ID must be a nonzero safe integer');
  }
  return Number(value);
}

export function parseChatSettings(value: unknown): ChatSettingsBody {
  if (!settingsValidator.Check(value)) {
    throw new AdminQueryError(
      'invalid_body',
      'Expected topic_ids, provider, model and thinking_level; use null to inherit or allow all topics',
    );
  }
  return value;
}

export function parseCreateChat(value: unknown): CreateChatBody {
  if (!createValidator.Check(value)) {
    throw new AdminQueryError(
      'invalid_body',
      'Expected a string Chat ID and topic_ids, provider, model and thinking_level',
    );
  }
  return value;
}

export type ParticipationBody = Static<typeof ParticipationBodySchema>;

export function parseParticipation(value: unknown): ParticipationBody {
  if (!participationValidator.Check(value)) {
    throw new AdminQueryError(
      'invalid_body',
      'Expected active_windows: either null to remove the Chat schedule or an array of { start, end, days? } windows',
    );
  }
  return value;
}

export type ProactiveReplyBody = Static<typeof ProactiveReplyBodySchema>;

export function parseProactiveReply(value: unknown): ProactiveReplyBody {
  if (!proactiveReplyValidator.Check(value)) {
    throw new AdminQueryError(
      'invalid_body',
      'Expected { mode: "inherit" | "off" } or { mode: "custom", base_probability, increment, hard_pity }',
    );
  }
  return value;
}

function managedSettings(body: ChatSettingsBody): Omit<FileChat, 'id'> {
  if ((body.provider === null) !== (body.model === null)) {
    throw new AdminQueryError('invalid_model_reference', 'provider and model must both be set or both be null');
  }
  // An inherited thinking level would tie the global default to this Chat's model:
  // a later global change could then be rejected because of a Chat it never names.
  if (body.provider !== null && body.thinking_level === null) {
    throw new AdminQueryError('thinking_level_required', 'A Chat model override must also set thinking_level');
  }
  const topicIds = body.topic_ids?.map((id) => {
    const number = Number(id);
    if (!Number.isSafeInteger(number) || number <= 0) {
      throw new AdminQueryError('invalid_topic_id', 'Topic IDs must be positive safe integers');
    }
    return number;
  });
  return {
    ...(topicIds === undefined ? {} : { topic_ids: topicIds }),
    ...(body.provider === null ? {} : { provider: body.provider }),
    ...(body.model === null ? {} : { model: body.model }),
    ...(body.thinking_level === null ? {} : { thinking_level: body.thinking_level }),
  };
}

/** The file's Chat allowlist; a configuration without a `telegram` section has none. */
function fileChats(file: FileConfig): TelegramSectionConfig['chats'] {
  return file.telegram?.chats ?? [];
}

export function createChat(file: FileConfig, body: CreateChatBody): ConfigEdit[] {
  const id = parseChatId(body.id);
  const chats = fileChats(file);
  if (chats.some((chat) => chat.id === id)) {
    throw new AdminQueryError('chat_exists', `Chat ${id} is already configured`, 409);
  }
  return [{ path: ['telegram', 'chats', chats.length], value: { id, ...managedSettings(body) } }];
}

function chatIndex(file: FileConfig, id: number): number {
  const index = fileChats(file).findIndex((chat) => chat.id === id);
  if (index < 0) {
    throw new AdminQueryError('chat_not_found', `Chat ${id} is not configured in the file`, 404);
  }
  return index;
}

export function updateChat(file: FileConfig, id: number, body: ChatSettingsBody): ConfigEdit[] {
  const index = chatIndex(file, id);
  const current = fileChats(file)[index];
  const settings = managedSettings(body);
  const edits: ConfigEdit[] = [];
  // Edit only the managed fields, preserving instructions, participation and other Chat settings.
  for (const key of ['topic_ids', 'provider', 'model', 'thinking_level'] as const) {
    if (JSON.stringify(current?.[key]) !== JSON.stringify(settings[key])) {
      edits.push({ path: ['telegram', 'chats', index, key], value: settings[key] });
    }
  }
  return edits;
}

export function deleteChat(file: FileConfig, id: number): ConfigEdit[] {
  const index = chatIndex(file, id);
  // The allowlist may become empty: it just means no Chat is processed until one
  // is added again. The `telegram` section itself stays, because a token may
  // still be configured and the panel never deletes the section.
  return [{ path: ['telegram', 'chats', index], value: undefined }];
}

/**
 * Edits only the Chat's `participation.active_windows`. Other participation
 * fields (trigger keywords, attention window) are preserved, because they are
 * edited elsewhere and would silently disappear with the object. Removing the
 * windows of an object that carries nothing else removes the object itself: a
 * leftover empty `participation: {}` would keep the participation gate active
 * and turn the Chat trigger-only instead of restoring the inherited behavior.
 */
export function updateChatParticipation(file: FileConfig, id: number, body: ParticipationBody): ConfigEdit[] {
  const index = chatIndex(file, id);
  const chat = fileChats(file)[index];
  if (chat === undefined) {
    throw new AdminQueryError('chat_not_found', `Chat ${id} is not configured in the file`, 404);
  }
  if (chat.id > 0 && body.active_windows !== null) {
    throw new AdminQueryError('invalid_body', 'Private chats cannot configure participation windows');
  }
  for (const window of body.active_windows ?? []) {
    if (window.start === window.end) {
      throw new AdminQueryError('invalid_body', `An active window cannot be empty: ${window.start}-${window.end}`);
    }
  }
  const current = chat.participation;
  if (body.active_windows === null) {
    if (current?.active_windows === undefined) {
      return [];
    }
    const { active_windows: _removed, ...rest } = current;
    if (Object.keys(rest).length === 0) {
      return [{ path: ['telegram', 'chats', index, 'participation'], value: undefined }];
    }
    return [{ path: ['telegram', 'chats', index, 'participation', 'active_windows'], value: undefined }];
  }
  if (JSON.stringify(current?.active_windows) === JSON.stringify(body.active_windows)) {
    return [];
  }
  return [{ path: ['telegram', 'chats', index, 'participation', 'active_windows'], value: body.active_windows }];
}

/** Edits only the Chat's `proactive_reply` override, preserving every other field. */
export function updateChatProactiveReply(file: FileConfig, id: number, body: ProactiveReplyBody): ConfigEdit[] {
  const index = chatIndex(file, id);
  const chat = fileChats(file)[index];
  if (chat === undefined) {
    throw new AdminQueryError('chat_not_found', `Chat ${id} is not configured in the file`, 404);
  }
  if (chat.id > 0) {
    throw new AdminQueryError('invalid_body', 'Private chats cannot configure proactive replies');
  }
  const value =
    body.mode === 'inherit'
      ? undefined
      : body.mode === 'off'
        ? { enabled: false }
        : {
            enabled: true,
            base_probability: body.base_probability,
            increment: body.increment,
            hard_pity: body.hard_pity,
          };
  if (JSON.stringify(chat.proactive_reply) === JSON.stringify(value)) {
    return [];
  }
  return [{ path: ['telegram', 'chats', index, 'proactive_reply'], value }];
}

/** The API spells a missing identity field as `null`, never as an absent key. */
function agentSettingsView(config: { agent?: AgentSettings | null }, chat?: FileChat) {
  const settings = resolveAgentSettings(config, chat);
  return {
    provider: settings.provider ?? null,
    model: settings.model ?? null,
    thinking_level: settings.thinking_level ?? null,
  };
}

function chatSettings(
  config: { agent?: AgentSettings | null; telegram?: Pick<TelegramSectionConfig, 'proactive_reply'> },
  chat: FileChat | undefined,
) {
  return chat === undefined
    ? null
    : {
        topic_ids: chat.topic_ids?.map(String) ?? null,
        provider: chat.provider ?? null,
        model: chat.model ?? null,
        thinking_level: chat.thinking_level ?? null,
        participation: chat.participation ?? null,
        proactive_reply: chat.proactive_reply ?? null,
        effective_proactive_reply: resolveProactiveReply(config, chat),
        timezone: chat.timezone ?? null,
        effective: agentSettingsView(config, chat),
      };
}

export function listChats(
  file: FileConfig,
  active: RawConfig,
  store: BusinessStore,
  revision: string,
  restartRequired: readonly string[],
) {
  const savedChats = new Map((file.telegram?.chats ?? []).map((chat) => [chat.id, chat]));
  const activeChats = new Map(active.telegram.chats.map((chat) => [chat.id, chat]));
  return {
    revision,
    supervised: supervisedRestartEnabled(),
    restart_required: restartRequired,
    timezone: file.timezone,
    global_participation: file.telegram?.participation ?? null,
    global_proactive_reply: file.telegram?.proactive_reply ?? null,
    effective_global_proactive_reply: resolveProactiveReply(file),
    defaults: agentSettingsView(file),
    models: Object.entries(file.providers).flatMap(([provider, definition]) =>
      definition.models
        .filter((model) => model.input.includes('text'))
        .map((model) => ({
          provider,
          model: model.id,
          name: model.name ?? model.id,
          thinking_levels: supportedThinkingLevels(model),
        })),
    ),
    items: [...new Set([...savedChats.keys(), ...activeChats.keys()])].map((id) => {
      const migration = store.orm
        .select()
        .from(chatMigrations)
        .where(eq(chatMigrations.oldChatId, BigInt(id)))
        .get();
      const runtimeId = migration?.newChatId ?? BigInt(id);
      const known = store.orm.select().from(chats).where(eq(chats.telegramChatId, runtimeId)).get();
      return {
        id: String(id),
        runtime_chat_id: String(runtimeId),
        title: known?.title ?? null,
        type: known?.type ?? null,
        saved: chatSettings(file, savedChats.get(id)),
        active: chatSettings(active, activeChats.get(id)),
      };
    }),
  };
}
