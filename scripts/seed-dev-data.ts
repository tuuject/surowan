import { chmod, copyFile, mkdir, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { assertConfigPermissions, loadConfig } from '../src/adapters/local-monolith/config.ts';
import type { FileConfig } from '../src/platform/config.ts';
import { loadEnvFiles } from '../src/platform/load-env.ts';

/**
 * Seeds a local development directory: `config.jsonc` plus a starter
 * `agent-prompt.md`, with one DeepSeek provider serving both agent and vision.
 *
 *   pnpm run dev:seed [-- --dir dev-data] [--force]
 *
 * Values come from the environment (`.env.local` / `.env` are loaded first);
 * a missing required variable prints setup instructions instead of JSON:
 *
 *   PLASTICWAN_DEV_CHAT_IDS   required, comma-separated Telegram chat IDs
 *   PLASTICWAN_DEV_ADMIN_IDS  optional, comma-separated Telegram user IDs
 *   TELEGRAM_BOT_TOKEN        required; referenced as an env SecretRef, never written
 *   DEEPSEEK_API_KEY          required; referenced as an env SecretRef, never written
 *   BRAVE_API_KEY             optional; when set, the Brave Search MCP is added
 *
 * An existing config is only replaced with `--force`; an existing prompt file
 * is always kept. The result is loaded through `loadConfig` before exiting.
 */
const DEEPSEEK_FLASH = {
  id: 'deepseek-flash',
  name: 'DeepSeek V4.1 Flash',
  reasoning: true,
  // Builtin compat is not inherited from Pi's catalog, so it is written here.
  compat: {
    supports_developer_role: false,
    thinking_format: 'deepseek',
    max_tokens_field: 'max_tokens',
    requires_reasoning_content: true,
  },
  input: ['text', 'image'],
  context_window: 1_000_000,
  max_tokens: 384_000,
  cost: { input: 0.3, output: 1.2, cache_read: 0.006, cache_write: 0 },
} satisfies FileConfig['providers'][string]['models'][number];

interface RequiredEnv {
  readonly name: string;
  readonly example: string;
  readonly what: string;
  readonly why: string;
}

const REQUIRED_ENV: readonly RequiredEnv[] = [
  {
    name: 'PLASTICWAN_DEV_CHAT_IDS',
    example: '-1001234567890,123456789',
    what: 'Comma-separated Telegram chat IDs (groups are negative, private chats are your user ID).',
    why: 'Written into telegram.chats; the bot ignores every chat not listed there.',
  },
  {
    name: 'TELEGRAM_BOT_TOKEN',
    example: '123456:ABC-your-bot-token',
    what: 'The bot token from @BotFather.',
    why: 'config.jsonc only stores { "env": "TELEGRAM_BOT_TOKEN" } and serve reads the value at startup, so the token never lands in a file.',
  },
  {
    name: 'DEEPSEEK_API_KEY',
    example: 'sk-your-deepseek-key',
    what: 'An API key from https://platform.deepseek.com/api_keys.',
    why: 'deepseek-flash serves both agent and vision; like the bot token it is referenced by name, never written.',
  },
];

class MissingEnvError extends Error {
  readonly missing: readonly RequiredEnv[];

  constructor(missing: readonly RequiredEnv[]) {
    super(`Missing environment variables: ${missing.map((env) => env.name).join(', ')}`);
    this.missing = missing;
  }
}

function assertRequiredEnv(): void {
  const missing = REQUIRED_ENV.filter((env) => (process.env[env.name]?.trim() ?? '').length === 0);
  if (missing.length > 0) {
    throw new MissingEnvError(missing);
  }
}

function describeMissingEnv(error: MissingEnvError): string {
  const details = error.missing.map((env) => `  ${env.name}\n    ${env.what}\n    Why: ${env.why}\n`);
  const lines = error.missing.map((env) => `  ${env.name}=${env.example}`);
  return [
    'dev:seed needs these environment variables, but they are not set:',
    '',
    ...details,
    'Add them to .env.local in the repository root (gitignored and loaded automatically;',
    'real environment variables win over .env.local, which wins over .env):',
    '',
    ...lines,
    '',
    'or export them in your shell. Optional: PLASTICWAN_DEV_ADMIN_IDS (admin user IDs),',
    'BRAVE_API_KEY (adds the Brave Search MCP).',
  ].join('\n');
}

function idList(name: string): number[] {
  const raw = process.env[name]?.trim() ?? '';
  if (raw.length === 0) {
    return [];
  }
  return raw.split(',').map((part) => {
    const id = Number(part.trim());
    if (!Number.isSafeInteger(id)) {
      throw new Error(`${name} contains an invalid ID: ${part.trim()}`);
    }
    return id;
  });
}

function seedConfig(dir: string): FileConfig {
  const dataDir = join(dir, 'data');
  const admins = idList('PLASTICWAN_DEV_ADMIN_IDS');
  const config: FileConfig = {
    version: 1,
    data_dir: dataDir,
    timezone: 'Asia/Shanghai',
    telegram: {
      token: { env: 'TELEGRAM_BOT_TOKEN' },
      process_bot_messages: true,
      bucket_window_seconds: 15,
      sticker_trigger_enabled: false,
      sticker_sets: [{ alias: 'yukino', name: 'YukinoWan' }],
      chats: idList('PLASTICWAN_DEV_CHAT_IDS').map((id) => ({ id })),
      ...(admins.length > 0 ? { admins } : {}),
    },
    providers: {
      deepseek: {
        kind: 'builtin',
        provider: 'deepseek',
        api_key: { env: 'DEEPSEEK_API_KEY' },
        models: [DEEPSEEK_FLASH],
      },
    },
    agent: {
      provider: 'deepseek',
      model: DEEPSEEK_FLASH.id,
      daily_budget: { max_tokens: 20_000_000 },
      thinking_level: 'off',
      system_prompt_file: 'agent-prompt.md',
      max_concurrency: 4,
      context_stop_ratio: 0.8,
      history_messages: 20,
      send_nudge_enabled: true,
      send_barrier_enabled: true,
      context: {
        retained_sends_target: 20,
        retained_sends_max: 30,
        hard_token_ratio: 0.6,
        ref_ttl_hours: 72,
        idle_grace_seconds: 60,
        max_wall_clock_seconds: 1800,
        agent_cache_size: 32,
      },
      rate_limits: { sends_per_window: 100, window_seconds: 300, turns_per_injection: 24 },
    },
    vision: {
      provider: 'deepseek',
      model: DEEPSEEK_FLASH.id,
      max_output_tokens: 8192,
      max_concurrency: 2,
      background_sticker_concurrency: 1,
      prompt_version: 1,
      daily_budget: { max_tokens: 5_000_000, max_images: 2000 },
    },
    retention: { online_days: 30, backup_copies: 7 },
    admin: { enabled: true, host: '127.0.0.1', port: 8787, session_ttl_hours: 168 },
    paths: {
      database: join(dataDir, 'plasticwan.sqlite'),
      media_cache: join(dataDir, 'media'),
      backups: join(dataDir, 'backups'),
    },
    developer: { record_model_payloads: true },
  };
  if (process.env.BRAVE_API_KEY !== undefined && process.env.BRAVE_API_KEY.length > 0) {
    config.mcp = {
      servers: [
        {
          alias: 'brave',
          transport: 'stdio',
          command: ['npx', '--yes', '@brave/brave-search-mcp-server@2.1.0', '--transport', 'stdio'],
          required: false,
          tools: '*',
          payload_max_bytes: 1_048_576,
          result_max_bytes: 32_768,
          env: { BRAVE_API_KEY: { env: 'BRAVE_API_KEY' } },
          default_tool_policy: { read_only: true, timeout_seconds: 20 },
        },
      ],
    };
  }
  return config;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      dir: { type: 'string', default: 'dev-data' },
      force: { type: 'boolean', default: false },
    },
  });
  loadEnvFiles();
  assertRequiredEnv();
  const dir = values.dir;
  const configPath = resolve(dir, 'config.jsonc');
  const promptPath = resolve(dir, 'agent-prompt.md');
  if ((await exists(configPath)) && !values.force) {
    throw new Error(`${configPath} already exists; pass --force to replace it`);
  }
  const config = seedConfig(dir);

  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  await writeFile(
    configPath,
    `// Generated by scripts/seed-dev-data.ts; secrets are env SecretRefs.\n${JSON.stringify(config, null, 2)}\n`,
    { mode: 0o600 },
  );
  await chmod(configPath, 0o600);
  const promptSeeded = !(await exists(promptPath));
  if (promptSeeded) {
    await copyFile(resolve(import.meta.dirname, '../apps/docs/examples/system-prompt.example.md'), promptPath);
    await chmod(promptPath, 0o600);
  }

  await assertConfigPermissions(configPath);
  const loaded = await loadConfig(configPath);
  console.log(
    JSON.stringify({
      status: 'ok',
      config: configPath,
      hash: loaded.hash,
      prompt: promptSeeded ? 'seeded' : 'kept',
      chats: config.telegram.chats.map((chat) => chat.id),
      mcp: config.mcp?.servers.map((server) => server.alias) ?? [],
      warnings: loaded.warnings,
    }),
  );
}

main().catch((error: unknown) => {
  process.exitCode = 1;
  if (error instanceof MissingEnvError) {
    console.error(describeMissingEnv(error));
    return;
  }
  console.error(JSON.stringify({ status: 'error', error: error instanceof Error ? error.message : String(error) }));
});
