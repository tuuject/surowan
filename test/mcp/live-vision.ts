/**
 * Opt-in paid endpoint verification. No Telegram connection or external messages.
 * Set SUROWAN_MCP_IMAGE_TEST_{API,BASE_URL,MODEL,KEY}, then run with Node >=24.
 * The key stays in the environment. The random answer only exists in pixels and
 * a private assertion file; no tool text or saved model answer can reveal it.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Api, fauxAssistantMessage, fauxToolCall, type Model, normalizeContext } from '@earendil-works/pi-ai';
import Type from 'typebox';
import { loadConfig } from '../../src/adapters/local-monolith/config/index.ts';
import { SqliteStore } from '../../src/adapters/local-monolith/database.ts';
import { McpManager } from '../../src/capabilities/mcp/index.ts';
import { loadToolImages, projectCompletionsToolImages } from '../../src/capabilities/media/tool-images.ts';
import { encodeContextMessage } from '../../src/context/codec.ts';
import { ConversationContextStore } from '../../src/context/store/index.ts';
import { previewContext } from '../../src/platform/invocation-context.ts';
import { keyJarPath } from '../../src/platform/key-jar.ts';
import { scrubModelRequestAuditJson } from '../../src/platform/models/request-audit.ts';
import { buildModelRegistry } from '../../src/platform/providers.ts';
import { SecretStore } from '../../src/platform/secrets.ts';
import { seedAdminFixture } from '../fixtures/admin-seed.ts';
import { testConfigJsonc, writeTestConfig } from '../helpers.ts';

const required = ['API', 'BASE_URL', 'MODEL', 'KEY'] as const;
const values = Object.fromEntries(required.map((key) => [key, process.env[`SUROWAN_MCP_IMAGE_TEST_${key}`]]));
const secrets = new SecretStore();
if (values.KEY) {
  secrets.remember(values.KEY);
}

async function check(configPath: string, stage: 'initial' | 'restored', evidenceDir: string): Promise<void> {
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
    const retained = contexts.retained(header).map((row) => row.message);
    const canonicalJson = JSON.stringify(retained);
    // The restored process is asked a detail absent from both the first question and tool text.
    const requestMessages =
      stage === 'restored'
        ? [
            ...retained,
            {
              role: 'user' as const,
              content:
                'Ignore the printed code. Describe the colored shapes in the image. Return only COLOR SHAPE COUNT, with the singular shape name and a digit count, no punctuation or other text.',
              timestamp: Date.now(),
            },
          ]
        : retained;
    const hydrated = await loadToolImages(requestMessages, {
      orm: store.orm,
      dataDir: loaded.config.data_dir,
      conversationId: 2001n,
      chatId: 1001n,
      model,
      signal: AbortSignal.timeout(120_000),
    });
    const messages = model.api === 'openai-completions' ? projectCompletionsToolImages(hydrated) : hydrated;
    const pixels = messages.flatMap((message) =>
      Array.isArray(message.content) ? message.content.filter((block) => block.type === 'image') : [],
    );
    const image = pixels[0];
    if (pixels.length !== 1 || image?.type !== 'image') {
      throw new Error('Expected exactly one verification image');
    }
    const bytes = Buffer.from(image.data, 'base64');
    await writeFile(join(evidenceDir, `${stage}.png`), bytes, { mode: 0o600 });
    await writeFile(join(evidenceDir, `${stage}.canonical.json`), canonicalJson, { mode: 0o600 });
    let sentImages = 0;
    let requestJson = '';
    const startedAt = new Date().toISOString();
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
            const scrubbed = scrubModelRequestAuditJson(JSON.stringify(payload));
            sentImages = scrubbed.replacements;
            requestJson = scrubbed.json;
          },
        },
      )
      .result();
    await writeFile(join(evidenceDir, `${stage}.request.json`), requestJson, { mode: 0o600 });
    const text = answer.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('');
    await writeFile(
      join(evidenceDir, `${stage}.result.json`),
      JSON.stringify(
        {
          stage,
          pid: process.pid,
          parentPid: process.ppid,
          startedAt,
          finishedAt: new Date().toISOString(),
          baseUrl: values.BASE_URL,
          api: model.api,
          requestedModel: model.id,
          responseModel: answer.model,
          responseProvider: answer.provider,
          stopReason: answer.stopReason,
          error: answer.errorMessage,
          imageCount: sentImages,
          imageSha256: createHash('sha256').update(bytes).digest('hex'),
          imageBytes: bytes.byteLength,
          canonicalSha256: createHash('sha256').update(canonicalJson).digest('hex'),
          answer: text,
          usage: answer.usage,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    if (sentImages !== 1) {
      throw new Error('The provider request did not contain the verification image');
    }
    if (answer.stopReason === 'error') {
      throw new Error(answer.errorMessage ?? 'Live model request failed');
    }
    const expected: { code: string; detail: string } = JSON.parse(
      await readFile(join(loaded.config.data_dir, '..', 'expected.txt'), 'utf8'),
    );
    const target = stage === 'initial' ? expected.code : expected.detail;
    if (canonicalJson.includes(expected.code) || canonicalJson.includes(expected.detail)) {
      throw new Error('An image-only answer leaked into canonical history');
    }
    if (text.trim().toUpperCase() !== target) {
      throw new Error(`Live vision ${stage} answer did not match the image-only detail; evidence retained`);
    }
    console.log(
      `PASS: ${stage} pid=${process.pid} ${model.api}/${model.id}; image sha256=${createHash('sha256').update(bytes).digest('hex')}`,
    );
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
    await check(process.argv[3]!, 'restored', process.argv[4]!);
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), 'surowan-mcp-live-'));
  const configPath = join(directory, 'config.jsonc');
  const evidenceDir =
    process.env.SUROWAN_MCP_IMAGE_TEST_EVIDENCE_DIR ?? (await mkdtemp(join(tmpdir(), 'surowan-mcp-evidence-')));
  await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
  console.log(`Live request evidence: ${evidenceDir}`);
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
              tool_policies: [{ name: 'capture', read_only: true, timeout_seconds: 15 }],
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
    await check(configPath, 'initial', evidenceDir);
    const child = spawn(process.execPath, [import.meta.filename, '--restore', configPath, evidenceDir], {
      stdio: 'inherit',
    });
    const status = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });
    if (status !== 0) {
      throw new Error('Fresh-process visual verification failed');
    }
    const initial = JSON.parse(await readFile(join(evidenceDir, 'initial.result.json'), 'utf8'));
    const restored = JSON.parse(await readFile(join(evidenceDir, 'restored.result.json'), 'utf8'));
    if (
      initial.pid === restored.pid ||
      initial.imageSha256 !== restored.imageSha256 ||
      initial.canonicalSha256 !== restored.canonicalSha256
    ) {
      throw new Error('Cold restoration did not preserve pixels and canonical history in a new process');
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

await main().catch((error: unknown) => {
  console.error(secrets.redactError(error));
  process.exitCode = 1;
});
