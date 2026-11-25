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
  /** The image section's OpenRouter credential. */
  image: 'image',
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
  /**
   * The group Chat the Chats-page dialog shots use (active hours, proactive
   * reply, entry gate, MCP binding, group memory). The shared fixture only has a
   * private Chat, and those dialogs exist for groups only.
   */
  readonly groupChatTitle: string;
  readonly groupChatUsername: string;
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
    /** Sticker analysis text the Sticker sets page shows next to the indexed sticker. */
    readonly stickerDescription: string;
    /** The seeded set's title; the alias and Telegram name stay the fixture's. */
    readonly stickerSetTitle: string;
  };
  /** The completed, tool-using run the Tool calls and Reviews shots document. */
  readonly toolRun: {
    readonly history: string;
    readonly incoming: string;
    readonly reply: string;
    readonly reasoning: string;
    readonly sendIntro: string;
    /** A real bundled `system:///` document, read with the runtime's `{ uri }` input. */
    readonly readUri: string;
  };
  /** The failed run the Resume shot documents (its own Conversation, nothing newer). */
  readonly resumeRun: {
    readonly incoming: string;
    readonly errorDetail: string;
    readonly reasoning: string;
    /** A real bundled `system:///` document, read with the runtime's `{ uri }` input. */
    readonly readUri: string;
  };
  readonly reviews: {
    readonly goal: string;
    readonly overall: string;
    readonly toolComment: string;
  };
  readonly dictionary: {
    readonly term: string;
    readonly definition: string;
    readonly alias: string;
    readonly importedTerm: string;
    readonly importedDefinition: string;
    readonly importedAliases: readonly [string, string];
  };
  readonly search: {
    readonly engineId: string;
    readonly note: string;
    readonly filter: string;
    readonly testUrl: string;
  };
  readonly alarm: {
    readonly title: string;
    readonly prompt: string;
  };
  readonly mcp: {
    readonly description: string;
  };
  /** The image features: one configured model, one prompt asset, one reference image. */
  readonly images: {
    readonly modelName: string;
    readonly modelNotes: string;
    readonly promptAssetName: string;
    readonly promptAssetBody: string;
    readonly referenceName: string;
    readonly referenceDescription: string;
    readonly referenceCategory: string;
    readonly referenceKeywords: string;
    readonly promptPrefix: string;
    readonly promptSuffix: string;
    readonly extractedName: string;
    readonly extractedKeywords: readonly string[];
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
    groupChatTitle: '版本发布组',
    groupChatUsername: 'surowan_release',
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
      stickerDescription: '一只挥手打招呼的吉祥物贴纸',
      stickerSetTitle: '小碗表情包',
    },
    toolRun: {
      history: '上一版的说明已经发出去了，这次只改了两句。',
      incoming: '这版的版本说明，帮我看看语气会不会太硬。',
      reply: '看过了，开头两句更轻松一点就可以直接发。',
      reasoning: '先读一遍发布规范，再用 send 回复。',
      sendIntro: '看完规范，可以直接回复了。',
      readUri: 'system:///skills/memory/SKILL.md',
    },
    resumeRun: {
      incoming: '把今天的构建日志整理成一段摘要。',
      errorDetail: '上游模型在 30 秒内没有返回（token 已打码）',
      reasoning: '先读一遍使用说明，再整理成摘要。',
      readUri: 'system:///skills/user-manual/SKILL.md',
    },
    reviews: {
      goal: '让回复更短，并在开头先给结论。',
      overall: '回复已经发出来了，但开头可以更短，结论放第一句。',
      toolComment: '这里发出去的内容比预期长，可以再压缩一些。',
    },
    dictionary: {
      term: '发版窗口',
      definition: '每周四 18:00 之后不再合并新的改动，紧急修复除外。',
      alias: '冻结期',
      importedTerm: '灰度比例',
      importedDefinition: '新版本先放给 10% 的用户，观察一小时再继续。',
      importedAliases: ['分批放量', 'canary 比例'],
    },
    search: {
      engineId: 'blog',
      note: '用来查中文开发者博客和版本发布说明。',
      filter: 'csdn\\.net',
      testUrl: 'https://blog.csdn.net/surowan/article/details/1',
    },
    alarm: {
      title: '每周版本提醒',
      prompt: '提醒大家本周的版本说明还没写。',
    },
    mcp: {
      description: '查询版本发布记录与变更单的服务器。',
    },
    images: {
      modelName: '作图模型 A',
      modelNotes: '默认模型；适合扁平插画和发布配图。',
      promptAssetName: '发布配图风格',
      promptAssetBody: '扁平插画，浅色背景，右侧留出标题的位置。',
      referenceName: '配色参考',
      referenceDescription: '浅蓝与米色的配色示例。',
      referenceCategory: '风格',
      referenceKeywords: '配色, 浅蓝, 米色',
      promptPrefix: '按 ',
      promptSuffix: ' 的配色画一张版本发布插画，扁平风格，浅色背景。',
      extractedName: '浅蓝配色的发布插画',
      extractedKeywords: ['浅蓝', '米色', '扁平插画'],
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
    groupChatTitle: 'Release group',
    groupChatUsername: 'surowan_release',
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
      stickerDescription: 'A cheerful mascot waving hello',
      stickerSetTitle: 'Surowan Mascot',
    },
    toolRun: {
      history: 'The previous release note is out; this one only changes two lines.',
      incoming: 'Have a look at the release note — does the tone sound too harsh?',
      reply: 'Checked. The first two lines are lighter now, so this can go out.',
      reasoning: 'Read the release guide first, then reply with send.',
      sendIntro: 'The guide is clear, so I can answer directly.',
      readUri: 'system:///skills/memory/SKILL.md',
    },
    resumeRun: {
      incoming: 'Turn the build log for today into a short summary.',
      errorDetail: 'The upstream model did not answer within 30 s (token redacted)',
      reasoning: 'Read the manual first, then summarize it.',
      readUri: 'system:///skills/user-manual/SKILL.md',
    },
    reviews: {
      goal: 'Make replies shorter and lead with the conclusion.',
      overall: 'The reply went out, but the opening can be shorter and the point comes first.',
      toolComment: 'The sent text is longer than it needs to be.',
    },
    dictionary: {
      term: 'release window',
      definition: 'After 18:00 on Thursday no new change lands, unless it is an urgent fix.',
      alias: 'freeze period',
      importedTerm: 'canary share',
      importedDefinition: 'Ship to 10% of users first, watch for an hour, then continue.',
      importedAliases: ['rolled release', 'percentage rollout'],
    },
    search: {
      engineId: 'blog',
      note: 'For Chinese developer blogs and release notes.',
      filter: 'csdn\\.net',
      testUrl: 'https://blog.csdn.net/surowan/article/details/1',
    },
    alarm: {
      title: 'Weekly release reminder',
      prompt: 'Remind everyone that the release note for this week is still unwritten.',
    },
    mcp: {
      description: 'Look up releases and change tickets.',
    },
    images: {
      modelName: 'Illustration Model A',
      modelNotes: 'Default model; flat illustrations and release artwork.',
      promptAssetName: 'Release artwork style',
      promptAssetBody: 'Flat illustration, light background, room for a headline on the right.',
      referenceName: 'Palette reference',
      referenceDescription: 'A light blue and cream palette sample.',
      referenceCategory: 'style',
      referenceKeywords: 'palette, light blue, cream',
      promptPrefix: 'Use the palette of ',
      promptSuffix: ' for a flat release illustration with a light background.',
      extractedName: 'Light blue release illustration',
      extractedKeywords: ['light blue', 'cream', 'flat illustration'],
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
