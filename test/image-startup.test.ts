import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { serve } from '../src/adapters/local-monolith/runtime-host.ts';
import * as imageService from '../src/image/service.ts';
import { startFixtureServer, stopFixtureServer, testConfigJsonc, writeTestConfig, writeTestKeyJar } from './helpers.ts';

const { getMe } = vi.hoisted(() => ({ getMe: vi.fn() }));
vi.mock('grammy', () => ({
  GrammyError: class extends Error {},
  HttpError: class extends Error {},
  Bot: class {
    api = { getMe };
  },
}));

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'surowan-image-startup-'));
  // Telegram is unreachable in this fixture. Startup must proceed to the panel
  // and settle at the network-error state instead of failing; each test ends
  // the process through the stop-request path once `serve_started` is logged.
  getMe.mockReset().mockRejectedValue(new Error('telegram-startup-boundary'));
});

/** Runs one serve process until it has started, then asks it to drain. */
async function serveUntilStarted(configPath: string, events: Record<string, unknown>[]): Promise<void> {
  // Each round must wait for its own start: the stop request is deleted by the
  // watcher a process installs, so writing it before that process started would
  // lose it.
  const alreadyStarted = events.filter((entry) => entry.event === 'serve_started').length;
  let failure: unknown;
  const serving = serve(configPath).catch((error: unknown) => {
    failure = error;
    throw error;
  });
  const started = (): boolean =>
    events.filter((entry) => entry.event === 'serve_started').length > alreadyStarted || failure !== undefined;
  await expect.poll(started, { timeout: 30_000 }).toBe(true);
  if (failure !== undefined) {
    throw failure;
  }
  await writeFile(join(directory, 'data', 'serve.stop'), `${process.pid}\n`, { mode: 0o600 });
  await serving;
}

function recordEvents(): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    const line = String(args[0] ?? '');
    if (!line.startsWith('{')) {
      return;
    }
    try {
      events.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      // Not an event line.
    }
  });
  return events;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

const imageConfig = {
  credentials: { openrouter: { jar: 'image-startup' } },
  models: [
    {
      id: 'startup-image',
      name: 'Startup Image',
      provider: 'openrouter',
      upstreamModel: 'openai/gpt-image-1',
      credentialRef: 'openrouter',
      providerTag: 'openai',
      capabilities: {
        imageInput: true,
        maxInputImages: 2,
        maxOutputs: 1,
        aspectRatios: ['auto', '1:1'],
        resolutionClasses: ['auto'],
      },
    },
  ],
};

/** A port the OS just had free; several workers run these tests at once. */
async function freePort(): Promise<number> {
  const probe = await startFixtureServer(() => new Response('ok'));
  const address = probe.server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  await stopFixtureServer(probe.server);
  return port;
}

async function writeConfig(image: unknown): Promise<string> {
  const configPath = join(directory, 'config.jsonc');
  const port = await freePort();
  await writeTestConfig(
    directory,
    configPath,
    testConfigJsonc(directory, (config) => {
      (config as Record<string, unknown>).image = image;
      (config as unknown as Record<string, unknown>).admin = {
        enabled: true,
        host: '127.0.0.1',
        port,
        session_ttl_hours: 12,
      };
    }),
  );
  return configPath;
}

test('serve loads persisted image configuration before the Telegram attempt and restores it on the next start', {
  timeout: 30_000,
}, async () => {
  const configPath = await writeConfig(imageConfig);
  await writeTestKeyJar(directory, { 'image-startup': 'fixture-image-secret' });
  const create = vi.spyOn(imageService, 'createImageService');
  const events = recordEvents();

  for (let start = 0; start < 2; start += 1) {
    await serveUntilStarted(configPath, events);
    const created = create.mock.results[start];
    if (created?.type !== 'return') {
      throw new Error('Image service was not created');
    }
    expect(created.value.core.config.hasValidConfig()).toBe(true);
    expect(created.value.core.config.current().models.map((model) => model.id)).toEqual(['startup-image']);
    expect(created.value.core.config.current().credentials.openrouter).toBe('fixture-image-secret');
  }
  expect(events.filter((entry) => entry.event === 'image_service_started').map((entry) => entry.enabled)).toEqual([
    true,
    true,
  ]);
  // The network failure is a connection state: the process still reached its
  // serve loop instead of exiting at the first Telegram call.
  expect(events.filter((entry) => entry.event === 'serve_started').map((entry) => entry.mode)).toEqual([
    'network_error',
    'network_error',
  ]);
  expect(JSON.stringify(events)).not.toContain('fixture-image-secret');
  expect(getMe.mock.calls.length).toBeGreaterThanOrEqual(2);
});

test.each([
  { name: 'absent', image: undefined },
  { name: 'invalid', image: { credentials: {}, models: 'invalid' } },
  { name: 'unresolved credential', image: imageConfig },
])(
  '$name image configuration leaves the optional capability disabled without blocking bot startup',
  async ({ image }) => {
    const configPath = await writeConfig(image);
    const create = vi.spyOn(imageService, 'createImageService');
    const events = recordEvents();
    await serveUntilStarted(configPath, events);
    const created = create.mock.results[0];
    if (created?.type !== 'return') {
      throw new Error('Image service was not created');
    }
    expect(created.value.core.config.hasValidConfig()).toBe(false);
    expect(events.find((entry) => entry.event === 'image_service_started')).toMatchObject({ enabled: false });
    if (image !== undefined) {
      expect(events.some((entry) => entry.event === 'config_warnings' || entry.event === 'image_service_warning')).toBe(
        true,
      );
    }
    expect(getMe).toHaveBeenCalled();
  },
  30_000,
);
