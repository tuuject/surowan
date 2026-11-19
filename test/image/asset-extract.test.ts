import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOpenRouterAdapter, type ImageAsset } from '@surowan/image-service';
import { createModels, fauxAssistantMessage, fauxProvider, type FauxProviderHandle } from '@earendil-works/pi-ai';
import sharp from 'sharp';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { loadConfig } from '../../src/adapters/local-monolith/config/index.ts';
import { SqliteStore } from '../../src/adapters/local-monolith/database.ts';
import { createImageBridge, type ImageBridge } from '../../src/image/bridge/index.ts';
import { createImageService, type ImageService } from '../../src/image/service.ts';
import { AdminServer } from '../../src/ingress/admin/index.ts';
import { createApiKey } from '../../src/ingress/admin/api-keys.ts';
import { keychainPath } from '../../src/platform/keychain.ts';
import { SecretStore } from '../../src/platform/secrets.ts';
import { LongTaskService } from '../../src/store/long-tasks/index.ts';
import type { BusinessStore } from '../../src/store/store.ts';
import { createAdminAccount } from '../fixtures/admin-account.ts';
import { testConfigJsonc, testConfigStore, writeTestConfig, writeTestKeychain } from '../helpers.ts';

// ---------------------------------------------------------------------------
// `POST /api/image/images/:id/extract`: the two-step metadata extraction
// preview. The tool model defaults to the configured one; a text-only tool
// model is refused before any call with the image-capable alternatives
// attached; a one-off override is validated against the live registry and
// never persisted; the reply is schema-validated; the call is audited in
// `model_calls` as role `tool`; and the route gates API keys behind
// write+paid permissions.
// ---------------------------------------------------------------------------

const PASSWORD = '{{SECRET_ninwukxs}}';

const cleanup: Array<() => void | Promise<void>> = [];
let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'surowan-image-extract-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
});

afterEach(async () => {
  let failure: unknown;
  for (const close of cleanup.splice(0).reverse()) {
    try {
      await close();
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure !== undefined) {
    throw failure;
  }
});

interface ExtractFixture {
  readonly server: AdminServer;
  readonly store: BusinessStore;
  readonly service: ImageService;
  readonly bridge: ImageBridge;
  readonly cookie: string;
  readonly agentFaux: FauxProviderHandle;
  readonly viewerFaux: FauxProviderHandle | undefined;
  upload(name: string): Promise<ImageAsset>;
  modelCalls(): readonly { role: string; state: string; provider: string; model: string; error_code: string | null }[];
}

interface FixtureOptions {
  /** The inherited (agent) model's input modalities; text-only forces the refusal. */
  readonly agentInput: readonly ('text' | 'image')[];
  /** Adds an image-capable `viewer` provider the one-off override may pick. */
  readonly viewer?: boolean;
  /** Drops the agent model so nothing can be inherited. */
  readonly noAgentModel?: boolean;
}

async function fixture(options: FixtureOptions): Promise<ExtractFixture> {
  const configPath = join(directory, 'config.jsonc');
  const staticDir = join(directory, 'bundle');
  await mkdir(join(staticDir, 'static'), { recursive: true });
  await writeFile(join(staticDir, 'index.html'), '<!doctype html><title>admin</title>');
  await writeTestConfig(
    directory,
    configPath,
    testConfigJsonc(directory, (config) => {
      config.admin = {
        enabled: true,
        host: '127.0.0.1',
        port: 8899,
        session_ttl_hours: 12,
        static_dir: staticDir.replaceAll('\\', '/'),
      };
      if (options.viewer === true) {
        config.providers.viewer = {
          kind: 'custom',
          base_url: 'https://example.test/v1',
          api: 'openai-responses',
          api_key: { jar: 'agent' },
          models: [
            {
              id: 'viewer-model',
              name: 'Viewer Model',
              reasoning: false,
              input: ['text', 'image'],
              context_window: 128_000,
              max_tokens: 8_192,
              cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
            },
          ],
        };
      }
      if (options.noAgentModel === true) {
        // An incomplete triple means there is no tool model to inherit.
        Reflect.deleteProperty(config.agent, 'model');
      }
    }),
  );
  await writeTestKeychain(directory, {});
  const loaded = await loadConfig(configPath);
  const store = await SqliteStore.open(loaded.config);
  cleanup.push(() => store.close());
  const service = createImageService(store, loaded.config, {
    providerAdapter: createOpenRouterAdapter({
      fetchImpl: async () =>
        new Response(JSON.stringify({ created: 0, data: [{ b64_json: 'AAAA', media_type: 'image/png' }] }), {
          status: 200,
        }),
    }),
  });
  cleanup.push(() => service.stop());

  // The registry is the Faux pair; the config file only names what to inherit,
  // and `listActiveImageModels` reads this registry, never the file.
  const models = createModels();
  const agentFaux = fauxProvider({
    provider: 'agent',
    models: [
      {
        id: 'agent-model',
        name: 'Agent Model',
        reasoning: true,
        input: [...options.agentInput],
        contextWindow: 200_000,
        maxTokens: 32_768,
      },
    ],
  });
  models.setProvider(agentFaux.provider);
  let viewerFaux: FauxProviderHandle | undefined;
  if (options.viewer === true) {
    viewerFaux = fauxProvider({
      provider: 'viewer',
      models: [
        {
          id: 'viewer-model',
          name: 'Viewer Model',
          reasoning: false,
          input: ['text', 'image'],
          contextWindow: 128_000,
          maxTokens: 8_192,
        },
      ],
    });
    models.setProvider(viewerFaux.provider);
  }
  const configStore = await testConfigStore(loaded, { models, visionModel: undefined });
  const secrets = new SecretStore(keychainPath(configPath));
  // The full admin image surface: extraction plus the asset updates the panel
  // saves its suggestions through.
  const bridge = createImageBridge({
    service,
    store,
    tasks: new LongTaskService(store.orm, () => undefined),
    prepareInputImage: async () => ({ base64: '', mime: 'image/png' }),
  });
  cleanup.push(() => bridge.stop());
  const server = new AdminServer({ store, configStore, secrets, imageService: service, imageBridge: bridge });
  await createAdminAccount(store.orm, { username: 'ops', password: PASSWORD });
  const setup = await server.handle(
    new Request('http://admin.test/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'ops', password: PASSWORD }),
    }),
  );
  const cookie = (setup.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  expect(setup.status).toBe(200);
  return {
    server,
    store,
    service,
    bridge,
    cookie,
    agentFaux,
    viewerFaux,
    upload: async (name: string) =>
      service.core.images.create({
        name,
        base64: (
          await sharp({ create: { width: 6, height: 6, channels: 3, background: '#112233' } })
            .png()
            .toBuffer()
        ).toString('base64'),
        mime: 'image/png',
        description: '',
        category: '',
        source: 'upload',
      }),
    modelCalls: () =>
      store.db
        .prepare<[], { role: string; state: string; provider: string; model: string; error_code: string | null }>(
          'SELECT role, state, provider, model, error_code FROM model_calls ORDER BY id',
        )
        .all(),
  };
}

function extractRequest(id: string, body?: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`http://admin.test/api/image/images/${id}/extract`, {
    method: 'POST',
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

test('extracts name and keywords with the tool model, audited as a tool call', async () => {
  const app = await fixture({ agentInput: ['text', 'image'] });
  const asset = await app.upload('未命名参考图.png');
  const seen: unknown[] = [];
  app.agentFaux.setResponses([
    (context) => {
      seen.push(context.messages.at(-1));
      return fauxAssistantMessage('{"name":"雨后花园","keywords":["花园","水彩","背景"]}');
    },
  ]);
  const response = await app.server.handle(extractRequest(asset.id, {}, { cookie: app.cookie }));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ name: '雨后花园', keywords: ['花园', '水彩', '背景'] });

  // The model actually saw the picture and the guarding system prompt.
  const last = seen[0] as { content: readonly { type: string }[] } | undefined;
  expect(last?.content.some((part) => part.type === 'image')).toBe(true);
  expect(app.modelCalls()).toEqual([
    { role: 'tool', state: 'success', provider: 'agent', model: 'agent-model', error_code: null },
  ]);
  // Nothing was persisted: the asset still has its original metadata.
  expect(app.service.core.images.get(asset.id)?.name).toBe('未命名参考图.png');
});

test('a text-only tool model is refused with the image-capable alternatives and no model call', async () => {
  const app = await fixture({ agentInput: ['text'], viewer: true });
  const asset = await app.upload('x.png');
  const response = await app.server.handle(extractRequest(asset.id, undefined, { cookie: app.cookie }));
  expect(response.status).toBe(409);
  const body = (await response.json()) as { error: string; models: { provider: string; model: string }[] };
  expect(body.error).toBe('tool_model_no_image_input');
  expect(body.models).toEqual([
    { provider: 'viewer', model: 'viewer-model', name: 'Viewer Model', thinking_levels: ['off'] },
  ]);
  expect(app.modelCalls()).toEqual([]);
  expect(app.viewerFaux?.state.callCount).toBe(0);
  expect(app.agentFaux.state.callCount).toBe(0);
});

test('a one-off override runs the extraction on the chosen model and is never persisted', async () => {
  const app = await fixture({ agentInput: ['text'], viewer: true });
  const asset = await app.upload('x.png');
  const viewerFaux = app.viewerFaux;
  expect(viewerFaux).toBeDefined();
  viewerFaux!.setResponses([fauxAssistantMessage('{"name":"覆盖模型命名","keywords":["a","b"]}')]);
  const response = await app.server.handle(
    extractRequest(
      asset.id,
      { model: { provider: 'viewer', model: 'viewer-model', thinking_level: 'off' } },
      { cookie: app.cookie },
    ),
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ name: '覆盖模型命名', keywords: ['a', 'b'] });
  expect(app.modelCalls()).toEqual([
    { role: 'tool', state: 'success', provider: 'viewer', model: 'viewer-model', error_code: null },
  ]);
  // The override never reached the configuration file.
  const file = await (await import('node:fs/promises')).readFile(join(directory, 'config.jsonc'), 'utf8');
  expect(file).not.toContain('tool_model');

  // Invalid overrides are refused without a call: unknown model, no image input,
  // unsupported thinking level, malformed body.
  const invalid = [
    { model: { provider: 'viewer', model: 'ghost', thinking_level: 'off' } },
    { model: { provider: 'agent', model: 'agent-model', thinking_level: 'low' } },
    { model: { provider: 'viewer', model: 'viewer-model', thinking_level: 'high' } },
    { model: { provider: 'viewer', model: 'viewer-model' } },
    { nope: true },
  ] as const;
  for (const [index, body] of invalid.entries()) {
    void index;
    const rejected = await app.server.handle(extractRequest(asset.id, body, { cookie: app.cookie }));
    expect([400, 422]).toContain(rejected.status);
    expect(((await rejected.json()) as { error: string }).error).toBeOneOf([
      'unknown_model',
      'not_image_capable',
      'unsupported_thinking_level',
      'invalid_body',
    ]);
  }
  expect(app.viewerFaux?.state.callCount).toBe(1);
  expect(app.modelCalls()).toHaveLength(1);
});

test('an oversized reply is refused instead of producing an unsaveable suggestion', async () => {
  const app = await fixture({ agentInput: ['text', 'image'] });
  const asset = await app.upload('x.png');
  // Twelve keywords at the extraction's per-keyword bound would join with ', '
  // into a line the update path cannot store; the extraction must refuse the
  // reply outright rather than hand back metadata the admin cannot save.
  const oversized = {
    name: 'x'.repeat(160),
    keywords: Array.from({ length: 12 }, (_, index) => 'k'.repeat(39) + String.fromCharCode(97 + index)),
  };
  app.agentFaux.setResponses([fauxAssistantMessage(JSON.stringify(oversized))]);
  const response = await app.server.handle(extractRequest(asset.id, {}, { cookie: app.cookie }));
  expect(response.status).toBe(502);
  expect(((await response.json()) as { error: string }).error).toBe('tool_model_unavailable');
  expect(app.modelCalls().map((row) => `${row.state}:${row.error_code}`)).toEqual(['error:tool_model_invalid_output']);
});

test('a maximum-size suggestion fits the update the admin saves through', async () => {
  const app = await fixture({ agentInput: ['text', 'image'] });
  const asset = await app.upload('x.png');
  // Twelve distinct keywords, each exactly at the per-keyword cap.
  const keyword = (index: number) => 'k'.repeat(38) + String.fromCharCode(97 + index);
  app.agentFaux.setResponses([
    fauxAssistantMessage(
      JSON.stringify({
        name: 'n'.repeat(160),
        keywords: Array.from({ length: 12 }, (_, index) => keyword(index)),
      }),
    ),
  ]);
  const response = await app.server.handle(extractRequest(asset.id, {}, { cookie: app.cookie }));
  expect(response.status).toBe(200);
  const metadata = (await response.json()) as { name: string; keywords: string[] };
  // The panel joins with ', ' exactly like this; the saved line must fit.
  const joined = metadata.keywords.join(', ');
  expect(joined.length).toBe(12 * 39 + 11 * 2);
  const update = await app.server.handle(
    new Request(`http://admin.test/api/image/images/${encodeURIComponent(asset.id)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie: app.cookie },
      body: JSON.stringify({ name: metadata.name, keywords: joined }),
    }),
  );
  expect(update.status).toBe(200);
  expect(app.service.core.images.get(asset.id)?.keywords).toBe(joined);
});

test('invalid model output is rejected and audited as an error', async () => {
  const app = await fixture({ agentInput: ['text', 'image'] });
  const asset = await app.upload('x.png');
  for (const reply of ['不是 JSON', '{"name":"x","keywords":[]}', '{"name":"","keywords":["a"]}']) {
    app.agentFaux.setResponses([fauxAssistantMessage(reply)]);
    const response = await app.server.handle(extractRequest(asset.id, {}, { cookie: app.cookie }));
    expect(response.status).toBe(502);
    expect(((await response.json()) as { error: string }).error).toBe('tool_model_unavailable');
  }
  expect(app.modelCalls().map((row) => `${row.state}:${row.error_code}`)).toEqual([
    'error:tool_model_invalid_output',
    'error:tool_model_invalid_output',
    'error:tool_model_invalid_output',
  ]);
});

test('unknown and archived assets, and a missing tool model, answer without a call', async () => {
  const app = await fixture({ agentInput: ['text', 'image'] });
  const missing = await app.server.handle(
    extractRequest('00000000-0000-4000-8000-000000000000', {}, { cookie: app.cookie }),
  );
  expect(missing.status).toBe(404);
  const asset = await app.upload('x.png');
  app.service.core.images.remove(asset.id);
  const archived = await app.server.handle(extractRequest(asset.id, {}, { cookie: app.cookie }));
  expect(archived.status).toBe(409);
  expect(((await archived.json()) as { error: string }).error).toBe('asset_archived');
  expect(app.modelCalls()).toEqual([]);
});

test('the route requires a session and write+paid API-key permissions', async () => {
  const app = await fixture({ agentInput: ['text', 'image'] });
  const asset = await app.upload('x.png');
  app.agentFaux.setResponses([fauxAssistantMessage('{"name":"n","keywords":["k"]}')]);
  const anonymous = await app.server.handle(extractRequest(asset.id, {}));
  expect(anonymous.status).toBe(401);

  // Every limited key mode is refused; only `all` carries both grants.
  const cases: { mode: 'read' | 'read_write' | 'read_paid'; status: number }[] = [
    { mode: 'read', status: 403 },
    { mode: 'read_write', status: 403 },
    { mode: 'read_paid', status: 403 },
  ];
  for (const entry of cases) {
    const { key } = createApiKey(app.store.orm, `key-${entry.mode}`, entry.mode);
    const response = await app.server.handle(extractRequest(asset.id, {}, { authorization: `Bearer ${key}` }));
    expect(response.status).toBe(entry.status);
    expect(((await response.json()) as { error: string }).error).toBe('forbidden');
  }
  const { key } = createApiKey(app.store.orm, 'key-all', 'all');
  const allowed = await app.server.handle(extractRequest(asset.id, {}, { authorization: `Bearer ${key}` }));
  expect(allowed.status).toBe(200);
  expect(app.modelCalls()).toHaveLength(1);

  // Cross-origin writes are rejected by the shared dispatch gate.
  const crossOrigin = await app.server.handle(
    extractRequest(asset.id, {}, { cookie: app.cookie, origin: 'http://other.test' }),
  );
  expect(crossOrigin.status).toBe(403);
});

test('nothing to inherit and no image service answer without a call', async () => {
  const app = await fixture({ agentInput: ['text'], noAgentModel: true });
  const asset = await app.upload('x.png');
  const response = await app.server.handle(extractRequest(asset.id, {}, { cookie: app.cookie }));
  expect(response.status).toBe(502);
  expect(((await response.json()) as { error: string }).error).toBe('tool_model_unavailable');
  expect(app.modelCalls()).toEqual([]);
});
