/**
 * Opt-in paid endpoint verification. No Telegram connection or external messages.
 * Set SUROWAN_MCP_IMAGE_TEST_{API,BASE_URL,MODEL,KEY}, then run with Node >=24.
 * The key stays in the environment. The random answer only exists in pixels and
 * a private assertion file; no tool text or saved model answer can reveal it.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fauxAssistantMessage, fauxToolCall, normalizeContext, type Model, type Api } from '@earendil-works/pi-ai';
import { loadConfig } from '../../src/adapters/local-monolith/config/index.ts';
import { SqliteStore } from '../../src/adapters/local-monolith/database.ts';
import { McpManager } from '../../src/capabilities/mcp/index.ts';
import { loadToolImages, projectCompletionsToolImages } from '../../src/capabilities/media/tool-images.ts';
import { ConversationContextStore } from '../../src/context/store.ts';
import { encodeContextMessage } from '../../src/context/codec.ts';
import { previewContext } from '../../src/platform/invocation-context.ts';
import { scrubModelRequestAuditJson } from '../../src/platform/models/request-audit.ts';
import Type from 'typebox';
import { buildModelRegistry } from '../../src/platform/providers.ts';
import { keyJarPath } from '../../src/platform/key-jar.ts';
import { SecretStore } from '../../src/platform/secrets.ts';
import { seedAdminFixture } from '../fixtures/admin-seed.ts';
import { testConfigJsonc, writeTestConfig } from '../helpers.ts';

const required = ['API', 'BASE_URL', 'MODEL', 'KEY'] as const;
const values = Object.fromEntries(required.map((key) => [key, process.env[`SUROWAN_MCP_IMAGE_TEST_${key}`]]));
const secrets = new SecretStore();
if (values.KEY) {
  secrets.remember(values.KEY);
}

async function check(configPath: string): Promise<void> {
  const loaded = await loadConfig(configPath);
  const registry = await buildModelRegistry(loaded.config, null, new SecretStore(keyJarPath(configPath)));
  const model = registry.models.getModel('agent', values.MODEL!) as Model<Api>;
  const store = await SqliteStore.open(loaded.config);
  try {
    const contexts = new ConversationContextStore(store);
    const header = contexts.header(2001n);
    if (!header) {
      throw new Error('Missing persisted verification history');
    }
    const hydrated = await loadToolImages(
      contexts.retained(header).map((row) => row.message),
      {
        orm: store.orm,
        dataDir: loaded.config.data_dir,
        conversationId: 2001n,
        chatId: 1001n,
        model,
        signal: AbortSignal.timeout(120_000),
      },
    );
    const messages = model.api === 'openai-completions' ? projectCompletionsToolImages(hydrated) : hydrated;
    if (
      !messages.some(
        (message) => Array.isArray(message.content) && message.content.some((block) => block.type === 'image'),
      )
    ) {
      throw new Error('No pixels loaded for live request');
    }
    let sentImages = 0;
    const answer = await registry.models
      .streamSimple(
        model,
        normalizeContext({
          messages,
          tools: [
            { name: 'verify__capture', description: 'Capture a verification image', parameters: Type.Object({}) },
          ],
        }),
        {
          signal: AbortSignal.timeout(120_000),
          maxRetries: 0,
          onPayload: (payload) => {
            sentImages = scrubModelRequestAuditJson(JSON.stringify(payload)).replacements;
          },
        },
      )
      .result();
    if (sentImages !== 1) {
      throw new Error('The provider request did not contain the verification image');
    }
    if (answer.stopReason === 'error') {
      throw new Error(answer.errorMessage ?? 'Live model request failed');
    }
    const text = answer.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('');
    const expected = await readFile(join(loaded.config.data_dir, '..', 'expected.txt'), 'utf8');
    if (text.trim().toUpperCase() !== expected.trim()) {
      throw new Error('Live vision answer did not match the image-only code');
    }
  } finally {
    store.close();
  }
}

async function main(): Promise<void> {
  const missing = required.filter((key) => !values[key]);
  if (missing.length) {
    throw new Error(
      `Missing dedicated test settings: ${missing.map((key) => `SUROWAN_MCP_IMAGE_TEST_${key}`).join(', ')}`,
    );
  }
  const api = values.API;
  if (
    api !== 'openai-completions' &&
    api !== 'openai-responses' &&
    api !== 'anthropic-messages' &&
    api !== 'google-generative-ai'
  ) {
    throw new Error('Unsupported test API');
  }
  if (process.argv[2] === '--restore') {
    await check(process.argv[3]!);
    console.log('PASS: fresh-process history restored pixels and answered the image-only code');
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), 'surowan-mcp-live-'));
  const configPath = join(directory, 'config.jsonc');
  try {
    await writeTestConfig(
      directory,
      configPath,
      testConfigJsonc(directory, (config) => {
        const agent = config.providers.agent;
        if (agent?.kind !== 'custom') {
          throw new Error('Missing fixture provider');
        }
        agent.api = api;
        agent.base_url = values.BASE_URL!;
        agent.api_key = { env: 'SUROWAN_MCP_IMAGE_TEST_KEY' };
        agent.models = agent.models.map((model) => ({
          ...model,
          id: values.MODEL!,
          reasoning: false,
          input: ['text', 'image'],
        }));
        config.agent.model = values.MODEL!;
        config.agent.thinking_level = 'off';
        config.mcp = {
          servers: [
            {
              alias: 'verify',
              transport: 'stdio',
              command: [
                process.execPath,
                join(import.meta.dirname, '..', 'fixtures', 'mcp-vision-server.ts'),
                join(directory, 'expected.txt'),
              ],
              required: true,
              tools: ['capture'],
              payload_max_bytes: 1_048_576,
              result_max_bytes: 32_768,
              default_tool_policy: { read_only: true, timeout_seconds: 15 },
            },
          ],
        };
      }),
    );
    const loaded = await loadConfig(configPath);
    const store = await SqliteStore.open(loaded.config);
    const manager = new McpManager(store, loaded.config, new SecretStore(keyJarPath(configPath)));
    try {
      const seed = seedAdminFixture(store);
      const contexts = new ConversationContextStore(store);
      const { header } = contexts.open(seed.conversationId, 'live-image-verification');
      await manager.start();
      const context = {
        ...previewContext(),
        invocationId: seed.invocationA,
        conversationId: seed.conversationId,
        internalChatId: seed.chatId,
      };
      const result = await manager.createTools(context, Date.now() + 30_000)[0]!.execute('live_capture', {});
      const messages = [
        {
          role: 'user' as const,
          content: 'Read the six-character hexadecimal code in the tool image. Return only that code, no other text.',
          timestamp: Date.now(),
        },
        fauxAssistantMessage(fauxToolCall('verify__capture', {}, { id: 'live_capture' }), { stopReason: 'toolUse' }),
        {
          role: 'toolResult' as const,
          toolName: 'verify__capture',
          toolCallId: 'live_capture',
          content: result.content,
          details: result.details,
          isError: result.isError === true,
          timestamp: Date.now(),
        },
      ];
      for (const message of messages) {
        const encoded = encodeContextMessage(message)!;
        contexts.append(header, {
          invocationId: seed.invocationA,
          isCheckpoint: message.role === 'user',
          estTokens: 100,
          role: encoded.role,
          json: encoded.json,
        });
      }
      // The server is stopped before either model request. Restoration cannot rerun it.
    } finally {
      await manager.stop();
      store.close();
    }
    await check(configPath);
    console.log(`PASS: ${api}/${values.MODEL} read the native MCP image; no answer was stored in history`);
    const child = spawn(process.execPath, [import.meta.filename, '--restore', configPath], { stdio: 'inherit' });
    const status = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });
    if (status !== 0) {
      throw new Error('Fresh-process visual verification failed');
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

await main().catch((error: unknown) => {
  console.error(secrets.redactError(error));
  process.exitCode = 1;
});
