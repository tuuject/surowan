import { afterAll, describe, expect, test } from 'vitest';
import { BOT_COMMANDS, parseBotCommand } from '../../src/ingress/telegram-ingestion/commands.ts';
import {
  ADMIN_DESCRIPTION_SUFFIX,
  BOT_COMMAND_CATALOG,
  type BotCommandCatalogEntry,
  type ControlCommandName,
} from '../../src/orchestration/bot-commands/catalog.ts';
import { visibleCommands } from '../../src/orchestration/bot-commands/help.ts';
import type { CommandSender, ParsedCommand } from '../../src/orchestration/bot-commands/index.ts';
import {
  ALICE,
  BOT_USERNAME,
  type ConfigTransform,
  FIXED_NOW,
  cleanupDirectories,
  commandUpdate,
  message,
  setup,
  textUpdate,
} from './fixtures.ts';

afterAll(cleanupDirectories);

const CHAT = { hostKind: 'telegram', hostChatId: 123456789n } as const;
const DENIED = '该命令仅对本 Bot 的管理员可用。';
const IGNORED_HINT = '你已让 Bot 忽略你在本 Chat 的消息，发送 /unignoreme 可恢复。';

const MEMBER_COMMANDS = [
  '/ask — 显式唤起 Bot 回答这条消息',
  '/help — 查看你可以使用的命令',
  '/status — 查看当前模型、thinking effort 与本日 token 用量',
  '/whoami — 查看你的 Telegram 数字 ID',
  '/ignoreme — 让 Bot 忽略你在本 Chat 的消息',
  '/unignoreme — 恢复 Bot 接收你在本 Chat 的消息',
];

const ADMIN_COMMANDS = [
  '/pause — 暂停本群互动',
  '/resume — 恢复本群互动',
  '/model — 查看或切换 agent 模型',
  '/effort — 查看或设置本群模型的思考强度',
  '/cut_topic — 切掉此消息及更早的历史，仅对新会话生效',
  '/rebuild_context — 丢弃并重建此话题的连续 Context，保留聊天记录',
  '/allowlist — 将本群加入白名单，立即生效',
];

/** The commands a `/help` reply advertises, in reply order. */
function listedCommands(reply: string): string[] {
  return reply.split('\n').flatMap((line) => {
    const match = /^\/([a-z_]+) — /.exec(line);
    return match === null ? [] : [match[1] ?? ''];
  });
}

function withIgnoredUser(transform: ConfigTransform): ConfigTransform {
  return (config) => {
    transform(config);
    const chat = config.telegram.chats[0];
    if (chat === undefined) {
      throw new Error('Expected a chat fixture');
    }
    chat.ignored_user_ids = [42];
  };
}

describe('/help visibility', () => {
  test('an ignored non-admin never sees an admin-tier command marked as passthrough', () => {
    const catalog: readonly BotCommandCatalogEntry[] = [
      { name: 'help', description: '查看你可以使用的命令', tier: 'anyone', ignoredPassthrough: true },
      { name: 'pause', description: '暂停本群互动', tier: 'admin', ignoredPassthrough: true },
    ];
    const visible = visibleCommands(catalog, { isAdmin: false, isIgnored: true, identified: true });
    expect(visible.map((entry) => entry.name)).toEqual(['help']);
  });
});

describe('/help service reply', () => {
  test('admin sees the member commands, then a separate admin section', async () => {
    const { store, commands } = await setup();
    try {
      const reply = await commands.run({ name: 'help' }, CHAT, ALICE, FIXED_NOW);
      expect(reply).toBe([...MEMBER_COMMANDS, '', '管理员命令：', ...ADMIN_COMMANDS].join('\n'));
      expect(reply).not.toContain(ADMIN_DESCRIPTION_SUFFIX);
    } finally {
      store.close();
    }
  });

  test('identified non-admin sees only the member commands', async () => {
    const { store, commands } = await setup((config) => {
      config.telegram.admins = [7];
    });
    try {
      const reply = await commands.run({ name: 'help' }, CHAT, ALICE, FIXED_NOW);
      expect(reply).toBe(MEMBER_COMMANDS.join('\n'));
      expect(listedCommands(reply)).not.toContain('allowlist');
      expect(reply).not.toContain(ADMIN_DESCRIPTION_SUFFIX);
    } finally {
      store.close();
    }
  });

  test('an unidentifiable sender sees only the commands that need no identity', async () => {
    const { store, commands } = await setup();
    try {
      expect(await commands.run({ name: 'help' }, CHAT, null, FIXED_NOW)).toBe(
        [
          '/ask — 显式唤起 Bot 回答这条消息',
          '/help — 查看你可以使用的命令',
          '/status — 查看当前模型、thinking effort 与本日 token 用量',
        ].join('\n'),
      );
    } finally {
      store.close();
    }
  });

  test('an ignored member sees only what ingestion still lets through, plus a recovery hint', async () => {
    const { store, commands } = await setup(
      withIgnoredUser((config) => {
        config.telegram.admins = [7];
      }),
    );
    try {
      const reply = await commands.run({ name: 'help' }, CHAT, ALICE, FIXED_NOW);
      expect(reply).toBe(
        [
          '/ask — 显式唤起 Bot 回答这条消息',
          '/help — 查看你可以使用的命令',
          '/ignoreme — 让 Bot 忽略你在本 Chat 的消息',
          '/unignoreme — 恢复 Bot 接收你在本 Chat 的消息',
          '',
          IGNORED_HINT,
        ].join('\n'),
      );
      expect(listedCommands(reply)).toEqual(['ask', 'help', 'ignoreme', 'unignoreme']);
    } finally {
      store.close();
    }
  });

  test('an ignored admin gets the same short list, not the admin commands', async () => {
    const { store, commands } = await setup(
      withIgnoredUser((config) => {
        config.telegram.admins = [42];
      }),
    );
    try {
      const reply = await commands.run({ name: 'help' }, CHAT, ALICE, FIXED_NOW);
      expect(listedCommands(reply)).toEqual(['ask', 'help', 'ignoreme', 'unignoreme']);
      for (const line of ADMIN_COMMANDS) {
        expect(reply).not.toContain(line);
      }
      expect(reply).toContain(IGNORED_HINT);
    } finally {
      store.close();
    }
  });
});

describe('/help catalog and menu', () => {
  test('the Telegram menu is the catalog and every existing entry is unchanged', () => {
    expect(BOT_COMMANDS).toEqual([
      { command: 'ask', description: '显式唤起 Bot 回答这条消息' },
      { command: 'help', description: '查看你可以使用的命令' },
      { command: 'pause', description: '暂停本群互动（仅管理员）' },
      { command: 'resume', description: '恢复本群互动（仅管理员）' },
      { command: 'status', description: '查看当前模型、thinking effort 与本日 token 用量' },
      { command: 'model', description: '查看或切换 agent 模型（仅管理员）' },
      { command: 'effort', description: '查看或设置本群模型的思考强度（仅管理员）' },
      { command: 'cut_topic', description: '切掉此消息及更早的历史，仅对新会话生效（仅管理员）' },
      { command: 'rebuild_context', description: '丢弃并重建此话题的连续 Context，保留聊天记录（仅管理员）' },
      { command: 'whoami', description: '查看你的 Telegram 数字 ID' },
      { command: 'allowlist', description: '将本群加入白名单，立即生效（仅管理员）' },
      { command: 'ignoreme', description: '让 Bot 忽略你在本 Chat 的消息' },
      { command: 'unignoreme', description: '恢复 Bot 接收你在本 Chat 的消息' },
    ]);
    expect(BOT_COMMANDS.map((entry) => entry.command)).toEqual(BOT_COMMAND_CATALOG.map((entry) => entry.name));
  });

  test('/help parses case-insensitively, ignores trailing text and foreign mentions', () => {
    expect(
      parseBotCommand(message(commandUpdate(1, 1, '/Help@surowan_test_bot please').message), BOT_USERNAME),
    ).toEqual({ name: 'help', messageId: 1n });
    expect(parseBotCommand(message(commandUpdate(1, 1, '/help@other_bot').message), BOT_USERNAME)).toBeNull();
  });
});

describe('/help ingestion', () => {
  test('is audited as a command, never stored and never creates a bucket', async () => {
    const { store, ingestion } = await setup();
    try {
      const result = ingestion.ingest(commandUpdate(1, 10, '/help'), FIXED_NOW);
      expect(result.command).toEqual({ name: 'help', messageId: 10n });
      expect(result.messageId).toBeUndefined();
      expect(result.bucketId).toBeUndefined();
      expect(store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM messages').get()?.count).toBe(0n);
      expect(store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM buckets').get()?.count).toBe(0n);
      expect(
        store.db
          .prepare<[], { allowed: bigint; rejection_reason: string | null }>(
            'SELECT allowed, rejection_reason FROM telegram_updates',
          )
          .get(),
      ).toEqual({ allowed: 1n, rejection_reason: null });
    } finally {
      store.close();
    }
  });

  test('passes the ignored-user filter while other commands from that member stay dropped', async () => {
    const { store, ingestion } = await setup((config) => {
      config.telegram.admins = [42];
      const chat = config.telegram.chats[0];
      if (chat === undefined) {
        throw new Error('Expected a chat fixture');
      }
      chat.ignored_user_ids = [42];
    });
    try {
      expect(ingestion.ingest(commandUpdate(1, 10, '/ignoreme'), FIXED_NOW).command).toEqual({
        name: 'ignoreme',
        messageId: 10n,
      });
      expect(ingestion.ingest(commandUpdate(2, 11, '/unignoreme'), FIXED_NOW).command).toEqual({
        name: 'unignoreme',
        messageId: 11n,
      });
      expect(ingestion.ingest(commandUpdate(3, 12, '/help'), FIXED_NOW).command).toEqual({
        name: 'help',
        messageId: 12n,
      });
      expect(ingestion.ingest(commandUpdate(4, 13, '/status'), FIXED_NOW)).toEqual({});
      expect(ingestion.ingest(commandUpdate(5, 14, '/pause'), FIXED_NOW)).toEqual({});
      expect(store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM messages').get()?.count).toBe(0n);
      expect(store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM buckets').get()?.count).toBe(0n);
    } finally {
      store.close();
    }
  });

  test('startup catch-up does not replay /help', async () => {
    const { store, ingestion } = await setup();
    try {
      expect(ingestion.ingestCatchUp(commandUpdate(1, 10, '/help'), FIXED_NOW)).toEqual({});
      expect(store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM messages').get()?.count).toBe(0n);
      expect(store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM buckets').get()?.count).toBe(0n);
    } finally {
      store.close();
    }
  });

  test('stays rejected in a chat that is not on the allowlist', async () => {
    const { store, ingestion } = await setup();
    try {
      expect(ingestion.ingest(commandUpdate(1, 10, '/help', 987654321), FIXED_NOW)).toEqual({});
      expect(
        store.db
          .prepare<[], { allowed: bigint; rejection_reason: string }>(
            'SELECT allowed, rejection_reason FROM telegram_updates',
          )
          .get(),
      ).toEqual({ allowed: 0n, rejection_reason: 'chat_not_allowed' });
    } finally {
      store.close();
    }
  });

  test('a foreign mention is not a command and follows the normal message path', async () => {
    const { store, ingestion } = await setup();
    try {
      expect(parseBotCommand(message(commandUpdate(1, 10, '/help@other_bot').message), BOT_USERNAME)).toBeNull();
      const result = ingestion.ingest(commandUpdate(1, 10, '/help@other_bot'), FIXED_NOW);
      expect(result.command).toBeUndefined();
      expect(result.messageId).toBeDefined();
    } finally {
      store.close();
    }
  });
});

describe('/help consistency with the command gate', () => {
  const tiers: readonly {
    readonly label: string;
    readonly transform: ConfigTransform;
    readonly sender: CommandSender | null;
    readonly storesChat: boolean;
  }[] = [
    {
      label: 'admin',
      transform: (config) => {
        config.telegram.admins = [42];
      },
      sender: ALICE,
      storesChat: true,
    },
    {
      label: 'member',
      transform: (config) => {
        config.telegram.admins = [7];
      },
      sender: ALICE,
      storesChat: false,
    },
    {
      label: 'ignored member',
      transform: withIgnoredUser((config) => {
        config.telegram.admins = [7];
      }),
      sender: ALICE,
      storesChat: false,
    },
    {
      label: 'anonymous sender',
      transform: (config) => {
        config.telegram.admins = [42];
      },
      sender: null,
      storesChat: false,
    },
  ];

  test('everything /help lists can run, and every admin command is denied to a non-admin', async () => {
    for (const tier of tiers) {
      const { store, ingestion, commands } = await setup(tier.transform);
      try {
        if (tier.storesChat) {
          ingestion.ingest(textUpdate(1, 1, 'hello'), FIXED_NOW);
        }
        const reply = await commands.run({ name: 'help' }, CHAT, tier.sender, FIXED_NOW);
        const listed = listedCommands(reply);
        expect(listed.length, `${tier.label} sees a list`).toBeGreaterThan(0);
        for (const name of listed) {
          if (name === 'ask') {
            continue;
          }
          const result = await commands.run(
            { name: name as ParsedCommand['name'], messageId: 1n },
            CHAT,
            tier.sender,
            FIXED_NOW,
          );
          expect(result, `${tier.label}: /${name} is listed but refused`).not.toBe(DENIED);
        }
        for (const entry of BOT_COMMAND_CATALOG) {
          if (entry.tier !== 'admin' || listed.includes(entry.name)) {
            continue;
          }
          const result = await commands.run(
            { name: entry.name as ControlCommandName, messageId: 1n },
            CHAT,
            tier.sender,
            FIXED_NOW,
          );
          expect(result, `${tier.label}: /${entry.name} must stay denied`).toBe(DENIED);
        }
      } finally {
        store.close();
      }
    }
  });

  test('/help advertises exactly the tiers the sender belongs to', async () => {
    const expected: Readonly<Record<string, readonly string[]>> = {
      admin: [
        'ask',
        'help',
        'status',
        'whoami',
        'ignoreme',
        'unignoreme',
        'pause',
        'resume',
        'model',
        'effort',
        'cut_topic',
        'rebuild_context',
        'allowlist',
      ],
      member: ['ask', 'help', 'status', 'whoami', 'ignoreme', 'unignoreme'],
      'ignored member': ['ask', 'help', 'ignoreme', 'unignoreme'],
      'anonymous sender': ['ask', 'help', 'status'],
    };
    for (const tier of tiers) {
      const { store, commands } = await setup(tier.transform);
      try {
        const reply = await commands.run({ name: 'help' }, CHAT, tier.sender, FIXED_NOW);
        expect(listedCommands(reply), tier.label).toEqual(expected[tier.label]);
      } finally {
        store.close();
      }
    }
  });
});
