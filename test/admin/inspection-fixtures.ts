/**
 * Fixtures shared by the `test/admin-inspection*.test.ts` suites: the isolated
 * Admin listener backed by a seeded SQLite store, the media downloader and the
 * request/auth helpers every inspection test builds on.
 *
 * Importing this module also registers the per-test teardown that closes every
 * fixture opened during the test.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fauxProvider } from '@earendil-works/pi-ai';
import { and, eq } from 'drizzle-orm';
import { afterEach } from 'vitest';
import { createApiKey } from '../../src/ingress/admin/api-keys.ts';
import { AdminServer } from '../../src/ingress/admin/index.ts';
import { loadConfig } from '../../src/adapters/local-monolith/config/index.ts';
import { ConfigReloader } from '../../src/adapters/local-monolith/config/reload.ts';
import { AgentModelSwitcher } from '../../src/platform/models/switch.ts';
import { SecretStore } from '../../src/platform/secrets.ts';
import { SqliteStore } from '../../src/adapters/local-monolith/database.ts';
import { invocationMessages, media } from '../../src/store/schema/index.ts';
import { seedAdminFixture } from '../fixtures/admin-seed.ts';
import { fauxRegistry, testConfigJsonc, testConfigStore, writeTestConfig } from '../helpers.ts';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) {
    await close();
  }
});

export async function fixture(allowReplyMessageMultipleTimes?: boolean) {
  const directory = await mkdtemp(join(tmpdir(), 'surowan-admin-inspection-'));
  const configPath = join(directory, 'config.jsonc');
  const secret = 'inspection-secret-must-not-be-output';
  await writeTestConfig(
    directory,
    configPath,
    testConfigJsonc(directory, (config) => {
      config.admin = { enabled: true, host: '127.0.0.1', port: 8899, session_ttl_hours: 12 };
      config.telegram.chats[0]!.id = -100123456789;
      if (allowReplyMessageMultipleTimes !== undefined) {
        config.agent!.allow_reply_message_multiple_times = allowReplyMessageMultipleTimes;
      }
      const agent = config.providers.agent;
      if (agent?.kind === 'custom') {
        agent.headers = { 'x-private': { env: 'SUROWAN_TEST_HEADER_SECRET' } };
      }
      config.mcp = {
        servers: [
          {
            alias: 'remote',
            transport: 'streamable_http',
            url: `https://example.test/mcp?token=${secret}`,
            follow_redirects: false,
            required: false,
            tools: [],
            payload_max_bytes: 1024,
            result_max_bytes: 1024,
            headers: { 'x-private': { command: ['fixed-command', secret] } },
          },
        ],
      };
      config.image = {
        credentials: { openrouter: { jar: 'openrouter' } },
        models: [
          {
            id: 'gpt-image-1',
            name: 'GPT Image 1',
            description: 'inspection-note',
            provider: 'openrouter',
            upstreamModel: 'openai/gpt-image-1',
            credentialRef: 'openrouter',
            providerTag: 'openai',
            capabilities: {
              imageInput: true,
              maxInputImages: 2,
              maxOutputs: 4,
              aspectRatios: ['auto', '1:1'],
              resolutionClasses: ['auto', 'high'],
            },
          },
        ],
      };
    }),
    'You are a concise test agent.',
    'Be brief.',
  );
  const loaded = await loadConfig(configPath);
  const store = await SqliteStore.open(loaded.config);
  cleanup.push(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const configStore = await testConfigStore(loaded, fauxRegistry(fauxProvider({ provider: 'agent' })));
  const secrets = new SecretStore();
  secrets.remember(secret);
  const reloader = new ConfigReloader({
    loaded,
    store: configStore,
    modelSwitcher: new AgentModelSwitcher(configStore),
    secrets,
    validateAgentModel: () => undefined,
    onPublished: () => undefined,
  });
  const seeded = seedAdminFixture(store);
  const snapshot = store.orm
    .select()
    .from(invocationMessages)
    .where(and(eq(invocationMessages.invocationId, seeded.invocationA), eq(invocationMessages.sequenceNo, 1n)))
    .get();
  const photo = store.orm.select().from(media).get();
  if (snapshot === undefined || photo === undefined) {
    throw new Error('Inspection fixture is missing its photo snapshot');
  }
  store.orm
    .update(invocationMessages)
    .set({
      revisionId: photo.revisionId,
      snapshotJson: JSON.stringify({ media: [{ id: photo.id.toString(), kind: 'photo' }] }),
    })
    .where(and(eq(invocationMessages.invocationId, seeded.invocationA), eq(invocationMessages.sequenceNo, 1n)))
    .run();
  const key = createApiKey(store.orm, 'inspection').key;
  let modelCalls = 0;
  const server = new AdminServer({
    store,
    configStore,
    configReloader: reloader,
    secrets,
    replayPreflight: () => ({
      available: false,
      reason: 'replay_scene_unavailable',
      message: secret,
      prompt_overrides_available: false,
      omitted_images: null,
      fidelity: {
        input: 'historical_public_chat',
        model_selection: 'current_chat_config',
        prompt_selection: 'current_chat_config',
        tool_selection: 'current_registry',
        hot_injections: 'not_replayed',
        external_tools: 'blocked',
        system_resources: 'current_read_only',
        side_effects: 'synthetic',
      },
    }),
    invocationPrompts: (id) => ({
      source: 'active',
      source_invocation_id: id.toString(),
      global_prompt: secret,
      group_prompt: 'active group',
      template_values: null,
      core_read_only: true,
    }),
    replayInvocation: async () => {
      modelCalls += 1;
      return {};
    },
    mediaDownloader: {
      download: async (_fileId, path, signal) => {
        signal.throwIfAborted();
        await writeFile(path, Buffer.from('fixture-original-bytes'));
      },
    },
  });
  const setup = await server.handle(
    request('/api/auth/setup', {
      method: 'POST',
      body: JSON.stringify({ username: 'owner', password: 'inspection-panel-password' }),
      headers: { 'content-type': 'application/json' },
    }),
  );
  const cookie = setup.headers.get('set-cookie')!.split(';')[0]!;
  return {
    directory,
    configPath,
    store,
    configStore,
    server,
    key,
    cookie,
    seeded,
    secret,
    modelCalls: () => modelCalls,
  };
}

export function request(path: string, init: RequestInit = {}): Request {
  return new Request(`http://127.0.0.1:8899${path}`, init);
}

export function auth(key: string) {
  return { authorization: `Bearer ${key}` };
}
