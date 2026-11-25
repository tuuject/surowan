import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { loadConfig } from '../../src/adapters/local-monolith/config/index.ts';
import { type ConfigChangeKind, diffConfig } from '../../src/platform/config/diff.ts';
import type { FixtureConfig } from '../helpers.ts';
import { loadBoth, paths } from '../config/diff-fixtures.ts';

/**
 * `configuration/lifecycle.md` publishes a behaviour matrix. Each row is
 * re-derived here from a real `diffConfig` run against two real loaded
 * configurations, so the page cannot quietly disagree with the hot whitelist in
 * `src/platform/config/diff-merge.ts`.
 */

interface Row {
  readonly name: string;
  readonly kind: ConfigChangeKind;
  readonly path: string;
  readonly base?: (config: FixtureConfig) => void;
  readonly next: (config: FixtureConfig) => void;
}

async function diffOf(
  base?: (config: FixtureConfig) => void,
  next?: (config: FixtureConfig) => void,
): Promise<ReturnType<typeof diffConfig>> {
  const { active, file } = await loadBoth(base, next);
  return diffConfig({ file: active.fileConfig, raw: active.config }, { file: file.fileConfig, raw: file.config });
}

const ROWS: readonly Row[] = [
  {
    name: 'a new Chat',
    kind: 'hot',
    path: 'telegram.chats[-100200300]',
    next: (config) => {
      config.telegram.chats.push({ id: -100200300 });
    },
  },
  {
    name: 'a removed Chat',
    kind: 'hot',
    path: 'telegram.chats[123456789]',
    next: (config) => {
      config.telegram.chats = [];
    },
  },
  {
    name: 'a Chat topic range',
    kind: 'restart',
    path: 'telegram.chats[123456789].topic_ids',
    next: (config) => {
      config.telegram.chats[0]!.topic_ids = [10];
    },
  },
  {
    name: 'a Chat timezone',
    kind: 'restart',
    path: 'telegram.chats[123456789].timezone',
    next: (config) => {
      config.telegram.chats[0]!.timezone = 'Asia/Tokyo';
    },
  },
  {
    name: 'a Chat model override',
    kind: 'hot',
    path: 'telegram.chats[123456789].model',
    next: (config) => {
      config.telegram.chats[0]!.provider = 'agent';
      config.telegram.chats[0]!.model = 'agent-model';
    },
  },
  {
    name: "a Chat's participation",
    kind: 'hot',
    path: 'telegram.chats[-100200300].participation',
    // A private Chat (positive id) may not configure participation at all.
    base: (config) => {
      config.telegram.chats = [{ id: -100200300 }];
    },
    next: (config) => {
      config.telegram.chats[0]!.participation = { ask_only: true };
    },
  },
  {
    name: "a Chat's group memory",
    kind: 'hot',
    path: 'telegram.chats[123456789].group_memory',
    next: (config) => {
      config.telegram.chats[0]!.group_memory = { enabled: true };
    },
  },
  {
    name: "a Chat's MCP binding",
    kind: 'hot',
    path: 'telegram.chats[123456789].mcp',
    base: (config) => {
      config.mcp = { servers: [stdioServer()] };
      config.telegram.chats[0]!.mcp = [{ server: 'tools', tools: ['read'] }];
    },
    next: (config) => {
      config.telegram.chats[0]!.mcp = [{ server: 'tools', tools: '*' }];
    },
  },
  {
    name: 'an Agent model budget',
    kind: 'hot',
    path: 'agent.daily_budget.max_tokens',
    next: (config) => {
      config.agent.daily_budget = { max_tokens: 400_000 };
    },
  },
  {
    name: 'a Provider connection field',
    kind: 'hot',
    path: 'providers.agent.base_url',
    next: (config) => {
      const provider = config.providers.agent;
      if (provider?.kind !== 'custom') {
        throw new Error('the fixture provider must be custom');
      }
      provider.base_url = 'https://other.test/v1';
    },
  },
  {
    name: 'an MCP server field',
    kind: 'hot',
    path: 'mcp.servers',
    base: (config) => {
      config.mcp = { servers: [stdioServer()] };
    },
    next: (config) => {
      config.mcp = { servers: [{ ...stdioServer(), payload_max_bytes: 8192 }] };
    },
  },
  {
    name: 'the entry gate',
    kind: 'hot',
    path: 'telegram.decision_gate.threshold',
    base: (config) => {
      config.telegram.decision_gate = { enabled: true, api_key: { jar: 'agent' } };
    },
    next: (config) => {
      config.telegram.decision_gate = { enabled: true, api_key: { jar: 'agent' }, threshold: 0.7 };
    },
  },
  {
    name: 'the batch window',
    kind: 'hot',
    path: 'telegram.bucket_window_seconds',
    next: (config) => {
      config.telegram.bucket_window_seconds = 30;
    },
  },
  {
    name: 'the Telegram token',
    kind: 'hot',
    path: 'telegram.token',
    next: (config) => {
      config.telegram.token = { env: 'OTHER_TELEGRAM_TOKEN' };
    },
  },
  {
    name: 'telegram.process_bot_messages',
    kind: 'restart',
    path: 'telegram.process_bot_messages',
    next: (config) => {
      config.telegram.process_bot_messages = true;
    },
  },
  {
    name: 'a sticker set',
    kind: 'hot',
    path: 'telegram.sticker_sets',
    base: (config) => {
      config.telegram.sticker_sets = [{ alias: 'cats', name: 'Cats' }];
    },
    next: (config) => {
      config.telegram.sticker_sets = [
        { alias: 'cats', name: 'Cats' },
        { alias: 'dogs', name: 'Dogs' },
      ];
    },
  },
  {
    name: 'the model metadata catalog',
    kind: 'hot',
    path: 'models_dev.api_url',
    base: (config) => {
      config.models_dev = { api_url: 'https://models.example.test/api.json' };
    },
    next: (config) => {
      config.models_dev = { api_url: 'https://mirror.example.test/api.json' };
    },
  },
  {
    name: 'retention.online_days',
    kind: 'hot',
    path: 'retention.online_days',
    next: (config) => {
      config.retention.online_days = 7;
    },
  },
  {
    name: 'retention.warning_read_days',
    kind: 'restart',
    path: 'retention.warning_read_days',
    next: (config) => {
      config.retention.warning_read_days = 14;
    },
  },
  {
    name: 'retention.backup_copies',
    kind: 'outside_serve',
    path: 'retention.backup_copies',
    next: (config) => {
      config.retention.backup_copies = 3;
    },
  },
  {
    name: 'paths.backups',
    kind: 'outside_serve',
    path: 'paths.backups',
    next: (config) => {
      config.paths.backups = `${config.paths.backups}-2`;
    },
  },
  {
    name: 'a Vision output limit',
    kind: 'hot',
    path: 'vision.max_output_tokens',
    next: (config) => {
      config.vision = { ...config.vision!, max_output_tokens: 4096 };
    },
  },
  {
    name: 'the Vision concurrency',
    kind: 'restart',
    path: 'vision.max_concurrency',
    next: (config) => {
      config.vision = { ...config.vision!, max_concurrency: 3 };
    },
  },
  {
    name: 'web_fetch',
    kind: 'restart',
    path: 'web_fetch',
    next: (config) => {
      config.web_fetch = { accept_markdown: false };
    },
  },
  {
    name: 'the admin listener',
    kind: 'restart',
    path: 'admin.port',
    next: (config) => {
      config.admin.port = 9000;
    },
  },
  {
    name: 'the database path',
    kind: 'restart',
    path: 'paths.database',
    next: (config) => {
      config.paths.database = `${config.paths.database}-2`;
    },
  },
  {
    name: 'a deprecated field',
    kind: 'hot',
    path: 'agent.memory_ttl_warning_days',
    base: (config) => {
      config.agent.memory_ttl_warning_days = 7;
    },
    next: (config) => {
      config.agent.memory_ttl_warning_days = 8;
    },
  },
];

/** One stdio server with every required field; `tools: "*"` needs a default policy. */
function stdioServer() {
  return {
    alias: 'tools',
    transport: 'stdio' as const,
    command: ['example-mcp-server'],
    tools: ['read'],
    payload_max_bytes: 4096,
    result_max_bytes: 4096,
    tool_policies: [{ name: 'read', read_only: true, timeout_seconds: 5 }],
  };
}

test.each(ROWS)('$name is $kind', async (row) => {
  const diff = await diffOf(row.base, row.next);
  expect(paths(diff.changes, row.kind)).toContain(row.path);
});

test('prompt file content is a hot change on the prompt fields', async () => {
  const directory = await loadBoth();
  const configPath = join(directory.directory, 'config.jsonc');
  await writeFile(join(directory.directory, 'agent-system-prompt.md'), 'A different persona.');
  await writeFile(join(directory.directory, 'chat-instructions.md'), 'Different chat instructions.');
  const file = await loadConfig(configPath);
  const diff = diffConfig(
    { file: directory.active.fileConfig, raw: directory.active.config },
    { file: file.fileConfig, raw: file.config },
  );
  // The path did not move; the content did, and that is what rebuilds Contexts.
  expect(paths(diff.changes, 'hot')).toEqual([
    'agent.system_prompt_file',
    'telegram.chats[123456789].instructions_file',
  ]);
});

test('a deprecated field warns at load without failing it', async () => {
  const { active } = await loadBoth((config) => {
    config.agent.memory_ttl_warning_days = 7;
  });
  expect(active.warnings.join('\n')).toContain('agent.memory_ttl_warning_days');
});
