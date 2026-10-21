import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { type LoadedConfig, loadConfig } from '../src/adapters/local-monolith/config.ts';
import { writeConfigEdits } from '../src/adapters/local-monolith/config-file.ts';
import { SqliteStore } from '../src/adapters/local-monolith/database.ts';
import type { MediaDownloader } from '../src/capabilities/media/media-download.ts';
import { MediaService } from '../src/capabilities/media/media.ts';
import { StickerService } from '../src/capabilities/stickers.ts';
import { ContextBuilder } from '../src/context/context-builder.ts';
import { ContextRefStore } from '../src/context/context-refs.ts';
import { visionEdits } from '../src/ingress/admin/providers-admin.ts';
import { TelegramIngestion } from '../src/ingress/telegram-ingestion.ts';
import { BucketScheduler } from '../src/orchestration/scheduler.ts';
import { KeyedSemaphore } from '../src/platform/concurrency.ts';
import { VISION_DEFAULTS } from '../src/platform/config.ts';
import { type ConfigChange, diffConfig } from '../src/platform/config-diff.ts';
import { SecretStore } from '../src/platform/secrets.ts';
import {
  invocationCapabilities,
  renderInvocationContext,
  testConfigJsonc,
  testConfigStore,
  writeTestConfig,
} from './helpers.ts';

const directories: string[] = [];

afterAll(async () => {
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
  );
});

async function loadWithVision(
  vision: unknown,
  transform?: (config: Record<string, unknown>) => void,
): Promise<LoadedConfig> {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-optional-vision-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  const jsonc = testConfigJsonc(directory, (config) => {
    const record = config as unknown as Record<string, unknown>;
    if (vision === undefined) {
      delete record.vision;
    } else {
      record.vision = vision;
    }
    transform?.(record);
  });
  await writeTestConfig(directory, configPath, jsonc);
  return loadConfig(configPath);
}

/** Each fixture lives in its own directory, so only the vision paths are compared. */
function visionChanges(changes: readonly ConfigChange[]): readonly ConfigChange[] {
  return changes.filter((change) => change.path.startsWith('vision'));
}

const unusedDownloader: MediaDownloader = {
  download: async () => {
    throw new Error('No media download is expected without a vision model');
  },
};

describe('optional vision section', () => {
  test.each([
    ['{}', {}],
    ['null', null],
    ['a missing key', undefined],
  ])('vision: %s is legal, resolves defaults and registers no vision model', async (_label, vision) => {
    const loaded = await loadWithVision(vision);
    expect(loaded.config.vision).toEqual({
      max_output_tokens: VISION_DEFAULTS.max_output_tokens,
      max_concurrency: VISION_DEFAULTS.max_concurrency,
      background_sticker_concurrency: 1,
      prompt_version: VISION_DEFAULTS.prompt_version,
      daily_budget: VISION_DEFAULTS.daily_budget,
    });
    expect(loaded.warnings.some((warning) => warning.includes('read_image'))).toBe(true);
    const configStore = await testConfigStore(loaded);
    expect(configStore.current().visionModel).toBeUndefined();
  });

  test('a partial pair stays legal, skips model validation and keeps vision off', async () => {
    const loaded = await loadWithVision({ provider: 'missing-provider', daily_budget: { max_images: 5 } });
    expect(loaded.config.vision.provider).toBe('missing-provider');
    expect(loaded.config.vision.daily_budget).toEqual({
      max_tokens: VISION_DEFAULTS.daily_budget.max_tokens,
      max_images: 5,
    });
    expect(loaded.warnings.some((warning) => warning.includes('read_image'))).toBe(true);
    const configStore = await testConfigStore(loaded);
    expect(configStore.current().visionModel).toBeUndefined();
  });

  test('a complete pair is still validated against the providers', async () => {
    await expect(loadWithVision({ provider: 'vision', model: 'no-such-model' })).rejects.toThrow(/vision/);
  });

  test('read_image refuses with vision_unconfigured and records the rejected call', async () => {
    const loaded = await loadWithVision(null);
    const configStore = await testConfigStore(loaded);
    const store = await SqliteStore.open(loaded.config);
    try {
      const ingestion = new TelegramIngestion(store, configStore, { id: 999 });
      ingestion.ingest(
        {
          update_id: 1,
          message: {
            message_id: 10,
            date: 1_700_000_000,
            chat: { id: 123456789, type: 'private', first_name: 'Owner' },
            from: { id: 42, is_bot: false, first_name: 'Alice' },
            photo: [{ file_id: 'file-id', file_unique_id: 'unique-id', width: 32, height: 16, file_size: 100 }],
          },
        },
        new Date('2026-08-15T00:00:00.000Z'),
      );
      const scheduler = new BucketScheduler(store, configStore, async () => ({ state: 'completed', reason: 'done' }));
      const [invocationId] = scheduler.processDue(new Date('2026-08-15T00:00:15.000Z'));
      if (invocationId === undefined) {
        throw new Error('Expected a due invocation');
      }
      const context = renderInvocationContext(store, loaded.config, invocationId);
      const capabilities = invocationCapabilities(store, loaded.config, context.header);
      const [imageRef] = context.imageCapabilities.keys();
      if (imageRef === undefined) {
        throw new Error('Expected an image capability');
      }
      const media = new MediaService({
        store,
        configStore,
        secrets: new SecretStore(),
        mediaClient: unusedDownloader,
        modelGate: new KeyedSemaphore(),
      });
      expect(media.visionAvailable()).toBe(false);
      const tool = media.createReadImageTool(context, capabilities, Date.now() + 60_000);
      await expect(tool.execute('read-1', { image_ref: imageRef })).rejects.toThrow('no vision model is configured');
      expect(
        store.db
          .prepare<[], { tool_name: string; state: string; error_code: string | null }>(
            'SELECT tool_name, state, error_code FROM tool_calls',
          )
          .all(),
      ).toEqual([{ tool_name: 'read_image', state: 'error', error_code: 'vision_unconfigured' }]);
      expect(store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM media_analyses').get()?.count).toBe(
        0n,
      );
    } finally {
      store.close();
    }
  });

  test('background sticker indexing waits without recording failures', async () => {
    const loaded = await loadWithVision({}, (config) => {
      (config.telegram as Record<string, unknown>).sticker_sets = [{ alias: 'cats', name: 'CatSet' }];
    });
    const configStore = await testConfigStore(loaded);
    const store = await SqliteStore.open(loaded.config);
    try {
      const media = new MediaService({
        store,
        configStore,
        secrets: new SecretStore(),
        mediaClient: unusedDownloader,
        modelGate: new KeyedSemaphore(),
      });
      const stickers = new StickerService({
        store,
        config: loaded.config,
        media,
        api: {
          getStickerSet: async () => ({
            name: 'CatSet',
            title: 'Cats',
            stickers: [
              {
                file_id: 'sticker-file',
                file_unique_id: 'sticker-unique',
                width: 64,
                height: 64,
                is_animated: false,
                is_video: false,
                emoji: '😭',
              },
            ],
          }),
        },
      });
      await stickers.sync();
      expect(await stickers.runOne()).toBe(false);
      expect(
        store.db
          .prepare<[], { index_state: string; failure_count: bigint }>(
            'SELECT index_state, failure_count FROM stickers',
          )
          .all(),
      ).toEqual([{ index_state: 'pending', failure_count: 0n }]);
    } finally {
      store.close();
    }
  });

  test('the stable prompt says images cannot be inspected without a vision model', async () => {
    const loaded = await loadWithVision(undefined);
    const configStore = await testConfigStore(loaded);
    const store = await SqliteStore.open(loaded.config);
    try {
      const ingestion = new TelegramIngestion(store, configStore, { id: 999 });
      ingestion.ingest(
        {
          update_id: 1,
          message: {
            message_id: 10,
            date: 1_700_000_000,
            chat: { id: 123456789, type: 'private', first_name: 'Owner' },
            from: { id: 42, is_bot: false, first_name: 'Alice' },
            text: 'hi',
          },
        },
        new Date('2026-08-15T00:00:00.000Z'),
      );
      const scheduler = new BucketScheduler(store, configStore, async () => ({ state: 'completed', reason: 'done' }));
      const [invocationId] = scheduler.processDue(new Date('2026-08-15T00:00:15.000Z'));
      if (invocationId === undefined) {
        throw new Error('Expected a due invocation');
      }
      const builder = new ContextBuilder(store, new ContextRefStore(store, { ttlHours: () => 72 }), [], []);
      const identity = builder.identity(loaded.config, invocationId);
      const agentModel = { provider: 'agent', model: 'agent-model' };
      const textOnly = builder.buildSystemPrompt(loaded.config, identity, false, agentModel);
      expect(textOnly.systemPrompt).toContain('No vision model is configured');
      expect(textOnly.templateValues.vision).toEqual({ provider: '', model: '' });
      const multimodal = builder.buildSystemPrompt(loaded.config, identity, true, agentModel);
      expect(multimodal.systemPrompt).toContain('attached directly to the multimodal Agent input');
      expect(multimodal.systemPrompt).toContain('no vision model is configured');
    } finally {
      store.close();
    }
  });

  test('removing the section drops the hot pair and keeps restart-only fields until restart', async () => {
    const active = await loadWithVision({ provider: 'vision', model: 'vision-model', max_concurrency: 3 });
    const file = await loadWithVision(null);
    const diff = diffConfig(
      { file: active.fileConfig, raw: active.config },
      { file: file.fileConfig, raw: file.config },
    );
    expect(visionChanges(diff.changes)).toEqual([
      { path: 'vision.max_concurrency', kind: 'restart' },
      { path: 'vision.model', kind: 'hot' },
      { path: 'vision.provider', kind: 'hot' },
    ]);
    expect(diff.candidate.file.vision).toEqual({ max_concurrency: 3 });
    expect(diff.candidate.raw.vision.provider).toBeUndefined();
    expect(diff.candidate.raw.vision.max_concurrency).toBe(3);

    const restored = diffConfig(
      { file: file.fileConfig, raw: file.config },
      { file: active.fileConfig, raw: active.config },
    );
    expect(visionChanges(restored.changes)).toEqual([
      { path: 'vision.max_concurrency', kind: 'restart' },
      { path: 'vision.model', kind: 'hot' },
      { path: 'vision.provider', kind: 'hot' },
    ]);
    expect(restored.candidate.file.vision).toEqual({ provider: 'vision', model: 'vision-model' });
  });

  test('switching the vision model writes a new section over a null one', async () => {
    const loaded = await loadWithVision(null);
    const configStore = await testConfigStore(loaded);
    const edits = visionEdits(
      { file: loaded.fileConfig, secrets: new SecretStore(), snapshot: configStore.current() },
      { provider: 'vision', model: 'vision-model' },
    );
    await writeConfigEdits(loaded.configPath, edits);
    const written = await loadConfig(loaded.configPath);
    expect(written.fileConfig.vision).toEqual({ provider: 'vision', model: 'vision-model' });
    expect(written.warnings.some((warning) => warning.includes('read_image'))).toBe(false);
    const switched = await testConfigStore(written);
    expect(switched.current().visionModel?.id).toBe('vision-model');
  });
});
