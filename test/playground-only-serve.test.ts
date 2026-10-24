/**
 * Acceptance: the real `serve` process with Telegram disabled.
 *
 * These run as a child process, not as an in-process assembly: the process
 * starts with no `telegram` section, prints its lifecycle events, serves the
 * panel (or refuses to start when the panel is off too) and shuts down cleanly
 * through the same stop-request file a takeover uses. The companion in-process
 * suite (`playground-only.test.ts`) covers the room round and untouched
 * Telegram work.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { startFixtureServer, stopFixtureServer } from './helpers.ts';

const directories: string[] = [];
const children: ReturnType<typeof spawn>[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    child.kill('SIGKILL');
  }
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

/** A port the OS just had free; the configuration requires a real one. */
async function freePort(): Promise<number> {
  const probe = await startFixtureServer(() => new Response('ok'));
  const address = probe.server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  await stopFixtureServer(probe.server);
  return port;
}

interface FixtureOptions {
  /** `false` leaves the panel off, which only an IM can make useful. */
  readonly panel: boolean;
  /** A token reference the key jar cannot satisfy, or no Telegram section. */
  readonly telegram?: { readonly token: { readonly jar: string } };
}

async function writeConfig(options: FixtureOptions): Promise<{ configPath: string; dataDir: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'surowan-tg-disabled-serve-'));
  directories.push(directory);
  const dataDir = join(directory, 'data');
  const port = await freePort();
  const provider = (modelId: string) => ({
    kind: 'custom',
    base_url: 'http://127.0.0.1:9/v1',
    api: 'openai-responses',
    api_key: { env: 'TG_DISABLED_AGENT_KEY' },
    models: [
      {
        id: modelId,
        name: modelId,
        reasoning: true,
        compat: { supports_developer_role: false },
        input: modelId === 'agent-model' ? ['text'] : ['text', 'image'],
        context_window: 200_000,
        max_tokens: 32_768,
        cost: { input: 1, output: 2, cache_read: 0.1, cache_write: 1 },
      },
    ],
  });
  const config = {
    version: 1,
    data_dir: dataDir.replaceAll('\\', '/'),
    timezone: 'UTC',
    ...(options.telegram === undefined
      ? {}
      : {
          telegram: {
            token: options.telegram.token,
            process_bot_messages: false,
            bucket_window_seconds: 15,
            chats: [],
          },
        }),
    providers: { agent: provider('agent-model'), vision: provider('vision-model') },
    agent: {
      provider: 'agent',
      model: 'agent-model',
      daily_budget: { max_tokens: 300_000 },
      thinking_level: 'off',
      system_prompt_file: 'agent-system-prompt.md',
      max_concurrency: 4,
      context_stop_ratio: 0.8,
      history_messages: 20,
      context: {
        retained_sends_target: 2,
        retained_sends_max: 3,
        hard_token_ratio: 0.6,
        ref_ttl_hours: 72,
        idle_grace_seconds: 0,
        max_wall_clock_seconds: 900,
        agent_cache_size: 8,
      },
      rate_limits: { sends_per_window: 6, window_seconds: 300, turns_per_injection: 8 },
    },
    vision: {
      provider: 'vision',
      model: 'vision-model',
      max_output_tokens: 2048,
      max_concurrency: 2,
      background_sticker_concurrency: 1,
      prompt_version: 1,
      daily_budget: { max_tokens: 200_000, max_images: 200 },
    },
    retention: { online_days: 30, backup_copies: 7 },
    paths: {
      database: join(dataDir, 'surowan.sqlite').replaceAll('\\', '/'),
      media_cache: join(dataDir, 'media').replaceAll('\\', '/'),
      backups: join(dataDir, 'backups').replaceAll('\\', '/'),
    },
    admin: { enabled: options.panel, host: '127.0.0.1', port, session_ttl_hours: 12 },
  };
  const configPath = join(directory, 'config.jsonc');
  await writeFile(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
  await writeFile(join(directory, 'agent-system-prompt.md'), 'You are a test agent.\n', { mode: 0o600 });
  return { configPath, dataDir };
}

function startServe(configPath: string) {
  const child = spawn(
    process.execPath,
    [join(import.meta.dirname, '..', 'src', 'cli.ts'), 'serve', '--config', configPath],
    {
      env: { ...process.env, TG_DISABLED_AGENT_KEY: 'fixture-agent-key' },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  children.push(child);
  const events: Record<string, unknown>[] = [];
  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    stdout += chunk;
    for (const line of chunk.split('\n')) {
      if (!line.startsWith('{')) {
        continue;
      }
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        if (typeof parsed.event === 'string') {
          events.push(parsed);
        }
      } catch {
        // Not a structured event line.
      }
    }
  });
  child.stderr?.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const exited = new Promise<number>((resolve) => {
    child.on('close', (code) => resolve(code ?? -1));
  });
  return {
    child,
    events,
    exited,
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

/** Asks the process to drain through the production stop-request path. */
async function requestStop(dataDir: string): Promise<void> {
  await writeFile(join(dataDir, 'serve.stop'), `${process.pid}\n`, { mode: 0o600 });
}

test('serve with Telegram disabled starts the panel and stops cleanly on a stop request', async () => {
  const { configPath, dataDir } = await writeConfig({ panel: true });
  const serving = startServe(configPath);

  await expect
    .poll(() => serving.events.some((entry) => entry.event === 'admin_started'), { timeout: 30_000 })
    .toBe(true);
  await expect
    .poll(() => serving.events.some((entry) => entry.event === 'serve_started'), { timeout: 30_000 })
    .toBe(true);
  const names = serving.events.map((entry) => entry.event);
  expect(names).toContain('image_service_started');
  expect(names).toContain('system_skills_loaded');
  expect(names).toContain('serve_started');
  expect(names).not.toContain('commands_registered');
  expect(names).not.toContain('startup_catch_up_completed');
  expect(serving.events.find((entry) => entry.event === 'serve_started')).toMatchObject({
    mode: 'disabled',
    bot_id: null,
  });

  await requestStop(dataDir);
  expect(await serving.exited).toBe(0);
  expect(serving.events.find((entry) => entry.event === 'shutdown_requested')).toBeDefined();
  expect(serving.stderr()).toBe('');
});

test('serve refuses a process with neither the panel nor Telegram', async () => {
  const { configPath } = await writeConfig({ panel: false });
  const serving = startServe(configPath);
  expect(await serving.exited).toBe(1);
  expect(serving.stderr()).toContain('Surowan is useless if neither admin panel is enabled nor telegram is configured');
});

test('an unreadable token is a connection state, not a reason to refuse starting', async () => {
  // Panel off and Telegram configured but unreadable: the configuration error
  // is shown by the connection state, and the useless rule must not fire.
  const { configPath, dataDir } = await writeConfig({
    panel: false,
    telegram: { token: { jar: 'missing-telegram-entry' } },
  });
  const serving = startServe(configPath);
  await expect
    .poll(() => serving.events.some((entry) => entry.event === 'serve_started'), { timeout: 30_000 })
    .toBe(true);
  const names = serving.events.map((entry) => entry.event);
  expect(names).not.toContain('admin_started');
  expect(names).not.toContain('commands_registered');
  expect(serving.events.find((entry) => entry.event === 'serve_started')).toMatchObject({
    mode: 'config_error',
    reason: 'token_unreadable',
    bot_id: null,
  });

  await requestStop(dataDir);
  expect(await serving.exited).toBe(0);
  expect(serving.stderr()).toBe('');
});
