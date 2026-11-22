/**
 * Localized synthetic content for the docs screenshot suite.
 *
 * The shared E2E fixture deliberately keeps one set of English placeholder rows
 * (`Surowan Test Group`, `Alice`, `E2E Room`). The docs suite photographs the
 * panel for two documentation locales, so the same server fixture is asked —
 * through `E2E_SEED_LOCALE`, set only by `playwright.docs.config.ts` — to seed
 * the matching language instead. Nothing here runs unless that variable is set:
 * every other Playwright suite keeps the original text and its assertions.
 *
 * Both sides read this module: the E2E server (config + store seed) and the
 * docs specs (the data they navigate to and assert on). Model ids, provider
 * aliases and keychain entry names are identifiers, not prose: they stay the
 * same in both locales.
 */
import { eq } from 'drizzle-orm';
import type { SqliteStore } from '../../../src/adapters/local-monolith/database.ts';
import {
  buckets,
  chats,
  groupMemories,
  invocations,
  longTasks,
  memoPadEntries,
  senders,
  warnings,
} from '../../../src/store/schema/index.ts';
import type { AdminSeedResult } from '../../../test/fixtures/admin-seed.ts';
import { T } from '../../../test/fixtures/admin-seed-data.ts';

export type DocsLocale = 'zh-CN' | 'en';

/** The Playwright project names of the docs config, in run order. */
export const DOCS_LOCALES: readonly DocsLocale[] = ['zh-CN', 'en'];

export function isDocsLocale(value: string | null | undefined): value is DocsLocale {
  return value === 'zh-CN' || value === 'en';
}

/** The locale this E2E server was asked to seed, or null for the shared fixture. */
export function requestedDocsLocale(): DocsLocale | null {
  const value = process.env.E2E_SEED_LOCALE;
  return isDocsLocale(value) ? value : null;
}

/** Model ids the docs fixture's loopback providers expose. */
export const DOCS_MODELS = {
  /** Agent role: reasoning, text + image. */
  agent: 'relay-model-a',
  /** Vision role: no reasoning, text + image. */
  vision: 'relay-model-b',
  /** The model the health check asks for; the loopback upstream answers `ok`. */
  health: 'health-ok',
  /** The Tool Model behind the dictionary merge and MCP description draft. */
  tool: 'e2e-merge-model',
} as const;

/** Provider aliases the docs fixture configures. */
export const DOCS_PROVIDERS = {
  relay: 'relay',
  health: 'demo',
  tool: 'merge',
} as const;

/**
 * Keychain entry names. They are config identifiers, so both locales share
 * them; the panel shows the name and the config paths that reference it.
 * `openrouter` is deliberately unused: the Keychain page has a real orphan to
 * show and purge.
 */
export const DOCS_KEYCHAIN = {
  telegram: 'telegram',
  relay: 'relay-api-key',
  relayHeader: 'relay-header',
  health: 'health-api-key',
  mcpHeader: 'mcp-header',
  unused: 'openrouter',
} as const;

export interface DocsPlaygroundRoom {
  readonly title: string;
  /** The held message the room starts with: the "test scene" the docs describe. */
  readonly message: string;
}

export interface DocsSeedText {
  readonly chatTitle: string;
  readonly chatUsername: string;
  readonly chatInstructions: string;
  readonly globalPrompt: string;
  readonly senderName: string;
  readonly otherSenderName: string;
  readonly channelName: string;
  readonly models: {
    readonly agent: string;
    readonly vision: string;
    readonly health: string;
    readonly tool: string;
  };
  readonly playground: {
    readonly botName: string;
    readonly memberName: string;
    readonly rooms: readonly DocsPlaygroundRoom[];
    /** Scripted model reply the release scenarios publish into the room. */
    readonly reply: string;
    /** A message the hold scenario types into the archive room. */
    readonly followUp: string;
  };
  readonly memories: {
    readonly activeSummary: string;
    readonly activeDetail: string;
    readonly expiredSummary: string;
    readonly groupSummary: string;
    readonly alarmSummary: string;
  };
  readonly apiKeys: {
    readonly read: string;
    readonly readWrite: string;
    readonly readPaid: string;
  };
  readonly passkeys: {
    readonly laptop: string;
    readonly phone: string;
  };
}

export const DOCS_SEED: Record<DocsLocale, DocsSeedText> = {
  'zh-CN': {
    chatTitle: '产品讨论组',
    chatUsername: 'surowan_product',
    chatInstructions: '只在被点名时回答，日常闲聊不要插话。',
    globalPrompt:
      '你是群聊里的助理「小碗」。先读懂大家在聊什么，再用简短、自然的中文回应；不确定的事情直接说不确定，不要编造。',
    senderName: '小林',
    otherSenderName: '阿泽',
    channelName: '发布频道',
    models: {
      agent: '中继模型 A',
      vision: '中继模型 B',
      health: '演示模型',
      tool: '工具模型',
    },
    playground: {
      botName: '小碗',
      memberName: '小林',
      rooms: [
        { title: '人设试验室', message: '今晚要发的版本说明，帮我起个舒服一点的语气。' },
        { title: '闲聊备份', message: '这个房间只是留档，不用回复。' },
      ],
      reply: '好呀，我用轻松一点的语气写一版，先给你看开头两句。',
      followUp: '再记一条：周五之前都不用回复。',
    },
    memories: {
      activeSummary: '小林喜欢简短、先给结论的回复。',
      activeDetail: '小林喜欢简短、先给结论的回复。长解释放在后面，也可以省略。',
      expiredSummary: '已经过期的旧备注。',
      groupSummary: '小林和阿泽讨论了这次的版本说明。',
      alarmSummary: '提醒小林提交版本说明',
    },
    apiKeys: {
      read: '审计脚本',
      readWrite: '值班面板',
      readPaid: '图片批处理',
    },
    passkeys: {
      laptop: '办公笔记本',
      phone: '备用手机',
    },
  },
  en: {
    chatTitle: 'Product group',
    chatUsername: 'surowan_product',
    chatInstructions: 'Answer only when addressed; stay out of ordinary chatter.',
    globalPrompt:
      "You are Surowan, the group's assistant. Read what people are discussing, then reply briefly and naturally. Say when you are unsure instead of making something up.",
    senderName: 'Ada',
    otherSenderName: 'Bo',
    channelName: 'Release channel',
    models: {
      agent: 'Relay Model A',
      vision: 'Relay Model B',
      health: 'Demo Model',
      tool: 'Tool Model',
    },
    playground: {
      botName: 'Surowan',
      memberName: 'Ada',
      rooms: [
        { title: 'Persona lab', message: "Help me find a friendlier tone for tonight's release note." },
        { title: 'Chat archive', message: 'This room is only kept for reference; no reply needed.' },
      ],
      reply: "Sure — here's a lighter take. The first two lines are ready for you to read.",
      followUp: 'One more for the archive: nothing to answer before Friday.',
    },
    memories: {
      activeSummary: 'Ada prefers short answers that lead with the conclusion.',
      activeDetail: 'Ada prefers short answers that lead with the conclusion. Long explanations come last, if at all.',
      expiredSummary: 'An older note that already expired.',
      groupSummary: 'Ada and Bo discussed the release note for this version.',
      alarmSummary: 'Remind Ada to submit the release note',
    },
    apiKeys: {
      read: 'Audit script',
      readWrite: 'On-call panel',
      readPaid: 'Image batch',
    },
    passkeys: {
      laptop: 'Office laptop',
      phone: 'Backup phone',
    },
  },
};

export function docsSeedText(locale: DocsLocale): DocsSeedText {
  return DOCS_SEED[locale];
}

/** The seed text for this server process, or null when it runs the shared fixture. */
export function requestedDocsSeed(): DocsSeedText | null {
  const locale = requestedDocsLocale();
  return locale === null ? null : DOCS_SEED[locale];
}

/**
 * Rewrites the human-readable rows `seedAdminFixture`/`seedAdminBulkRows` wrote
 * so the panel never mixes an English placeholder into a Chinese screenshot or
 * the reverse. Ids, timestamps and states stay exactly as seeded: only prose
 * changes, and the rows themselves are read back through the API afterwards.
 */
export function localizeAdminSeed(store: SqliteStore, seed: AdminSeedResult, text: DocsSeedText): void {
  const orm = store.orm;
  orm.update(chats).set({ title: text.chatTitle, username: text.chatUsername }).where(eq(chats.id, T.chat)).run();
  orm.update(senders).set({ displayName: text.senderName }).where(eq(senders.id, T.sender)).run();
  // The two senders `seedAdminBulkRows` adds for the message revisions of the
  // padding rows (5_002 channel, 5_003 member).
  orm.update(senders).set({ displayName: text.channelName }).where(eq(senders.id, 5_002n)).run();
  orm.update(senders).set({ displayName: text.otherSenderName }).where(eq(senders.id, 5_003n)).run();
  orm
    .update(memoPadEntries)
    .set({ summary: text.memories.activeSummary, detail: text.memories.activeDetail })
    .where(eq(memoPadEntries.id, seed.memoryActiveId))
    .run();
  orm
    .update(memoPadEntries)
    .set({ summary: text.memories.expiredSummary, detail: text.memories.expiredSummary })
    .where(eq(memoPadEntries.id, seed.memoryExpiredId))
    .run();
  orm
    .update(groupMemories)
    .set({ summary: text.memories.groupSummary })
    .where(eq(groupMemories.id, seed.groupMemoryId))
    .run();
  const alarm = orm.select().from(longTasks).where(eq(longTasks.id, T.alarm)).get();
  if (alarm !== undefined) {
    // The payload and its timer result carry the summary and the target name.
    const renamePayload = (json: string | null): string | null => {
      if (json === null) {
        return null;
      }
      const value = JSON.parse(json) as Record<string, unknown>;
      if (typeof value.summary === 'string') {
        value.summary = text.memories.alarmSummary;
      }
      if (typeof value.target_display_name === 'string') {
        value.target_display_name = text.senderName;
      }
      return JSON.stringify(value);
    };
    // The delivery policy has its own shape and keeps the mention's name nested;
    // adding a top-level summary there would break the delivery schema.
    const renameDelivery = (json: string | null): string | null => {
      if (json === null) {
        return null;
      }
      const value = JSON.parse(json) as { mentionUser?: { displayName?: unknown } };
      if (typeof value.mentionUser?.displayName === 'string') {
        value.mentionUser.displayName = text.senderName;
      }
      return JSON.stringify(value);
    };
    orm
      .update(longTasks)
      .set({
        payloadJson: renamePayload(alarm.payloadJson) ?? alarm.payloadJson,
        timerResultJson: renamePayload(alarm.timerResultJson),
        deliveryJson: renameDelivery(alarm.deliveryJson) ?? alarm.deliveryJson,
      })
      .where(eq(longTasks.id, T.alarm))
      .run();
  }
}

/**
 * The docs instance is a healthy one.
 *
 * The shared fixture deliberately keeps a failing Invocation and an unread
 * critical warning so the E2E suites can assert on them; a documentation
 * screenshot of a fresh panel would read as a broken deployment. Only the
 * synthetic states change here (rows, ids, timestamps and prose stay as
 * seeded), and only when the docs suite asked for its seeded data.
 */
export function normalizeDocsInstance(store: SqliteStore): void {
  const orm = store.orm;
  // A completed run keeps the completion reason a real successful run stores,
  // so the list and the detail page agree (the seed's failed run says model_error).
  orm
    .update(invocations)
    .set({ state: 'completed', completionReason: 'turn_limit_reached', errorCode: null })
    .where(eq(invocations.state, 'failed'))
    .run();
  orm.update(buckets).set({ state: 'completed', errorCode: null }).where(eq(buckets.state, 'failed')).run();
  orm
    .update(warnings)
    .set({ readAt: '2026-09-10T08:02:00.000Z' })
    .where(eq(warnings.code, 'invocation_failure_rate'))
    .run();
  orm
    .update(warnings)
    .set({ readAt: '2026-09-09T07:05:00.000Z' })
    .where(eq(warnings.code, 'admin_login_failures'))
    .run();
}
