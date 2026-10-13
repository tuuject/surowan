import { afterAll, expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { type LoadedConfig, loadConfig, type RawConfig } from '../src/platform/config.ts';
import { SqliteStore } from '../src/store/database.ts';
import { appState } from '../src/store/schema.ts';
import { bucket, startTelemetry, telemetryOffReason } from '../src/telemetry.ts';
import { testConfigJsonc, writeTestConfig } from './helpers.ts';

const directories: string[] = [];

afterAll(async () => {
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
  );
});

async function fixture(telemetry?: { consent: 'granted' | 'denied' }) {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-telemetry-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(
    directory,
    configPath,
    testConfigJsonc(directory, (config) => {
      if (telemetry !== undefined) {
        config.telemetry = telemetry;
      }
    }),
  );
  const loaded: LoadedConfig = await loadConfig(configPath);
  const store = await SqliteStore.open(loaded.config);
  return { store, config: loaded.config };
}

function installId(store: SqliteStore): string | undefined {
  return store.orm
    .select({ value: appState.value })
    .from(appState)
    .where(eq(appState.key, 'telemetry_install_id'))
    .get()?.value;
}

const capture = () => {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response('{"status":1}', { status: 200 });
  }) as typeof fetch;
  return { requests, fetchImpl };
};

test('bucket turns exact counts into ranges', () => {
  expect([0, 1, 2, 5, 6, 20, 21, 100, 101, 1000, 1001].map(bucket)).toEqual([
    '0',
    '1',
    '2-5',
    '2-5',
    '6-20',
    '6-20',
    '21-100',
    '21-100',
    '101-1000',
    '101-1000',
    '1000+',
  ]);
});

test('reporting needs explicit consent, a project key and no environment opt-out', () => {
  const granted = { telemetry: { consent: 'granted' as const } };
  expect(telemetryOffReason({}, {}, 'phc_x')).toBe('not_configured');
  expect(telemetryOffReason({ telemetry: { consent: 'denied' } }, {}, 'phc_x')).toBe('denied');
  expect(telemetryOffReason(granted, { DO_NOT_TRACK: '1' }, 'phc_x')).toBe('env_opt_out');
  expect(telemetryOffReason(granted, { PLASTICWAN_TELEMETRY: '0' }, 'phc_x')).toBe('env_opt_out');
  expect(telemetryOffReason(granted, { DO_NOT_TRACK: '0' }, 'phc_x')).toBeUndefined();
  expect(telemetryOffReason(granted, {}, '')).toBe('no_project_key');
});

test('without a decision nothing is sent and no install ID exists', async () => {
  const { store, config } = await fixture();
  const { requests, fetchImpl } = capture();
  const events: string[] = [];
  const handle = startTelemetry({
    store,
    config,
    env: {},
    fetchImpl,
    projectKey: 'phc_test',
    log: (event, fields) => events.push(`${event}:${fields?.reason}`),
  });
  expect(handle.enabled).toBe(false);
  expect(requests).toEqual([]);
  expect(installId(store)).toBeUndefined();
  expect(events).toEqual(['telemetry_disabled:not_configured']);
  store.close();
});

test('granted consent sends one anonymous event with only coarse properties', async () => {
  const { store, config } = await fixture({ consent: 'granted' });
  const { requests, fetchImpl } = capture();
  const handle = startTelemetry({ store, config, env: {}, fetchImpl, projectKey: 'phc_test', log: () => undefined });
  await new Promise((resolve) => setTimeout(resolve, 20));
  handle.stop();
  expect(handle.enabled).toBe(true);
  expect(requests).toHaveLength(1);
  const [request] = requests;
  expect(request?.url).toBe('https://us.i.posthog.com/capture/');
  const body = request?.body as { event: string; distinct_id: string; api_key: string; properties: RawProps };
  expect(body.event).toBe('instance_started');
  expect(body.api_key).toBe('phc_test');
  expect(body.distinct_id).toBe(installId(store));
  expect(body.properties).toMatchObject({ $process_person_profile: false, $geoip_disable: true, chats: '1' });
  expect(Object.keys(body.properties).sort()).toEqual(
    [
      '$geoip_disable',
      '$lib',
      '$process_person_profile',
      'admin_enabled',
      'arch',
      'chats',
      'docker',
      'has_group_chats',
      'image_enabled',
      'invocations_24h',
      'mcp_servers',
      'node_major',
      'platform',
      'version',
    ].sort(),
  );
  // Nothing identifying: not the bot token, a Chat ID or the data directory.
  const payload = JSON.stringify(body);
  for (const chat of config.telegram.chats) {
    expect(payload).not.toContain(String(chat.id));
  }
  expect(payload).not.toContain(config.data_dir);
  store.close();
});

test('the install ID is stable across starts and deleted when consent is withdrawn', async () => {
  const { store, config } = await fixture({ consent: 'granted' });
  const { fetchImpl } = capture();
  const first = startTelemetry({ store, config, env: {}, fetchImpl, projectKey: 'phc_test', log: () => undefined });
  first.stop();
  const id = installId(store);
  expect(id).toMatch(/^[0-9a-f-]{36}$/);
  const second = startTelemetry({ store, config, env: {}, fetchImpl, projectKey: 'phc_test', log: () => undefined });
  second.stop();
  expect(installId(store)).toBe(id);
  const withdrawn: RawConfig = { ...config, telemetry: { consent: 'denied' } };
  startTelemetry({ store, config: withdrawn, env: {}, fetchImpl, projectKey: 'phc_test', log: () => undefined });
  expect(installId(store)).toBeUndefined();
  store.close();
});

test('a failing endpoint is logged and never throws into the runtime', async () => {
  const { store, config } = await fixture({ consent: 'granted' });
  const events: string[] = [];
  const handle = startTelemetry({
    store,
    config,
    env: {},
    fetchImpl: (async () => {
      throw new Error('network down');
    }) as typeof fetch,
    projectKey: 'phc_test',
    log: (event) => events.push(event),
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  handle.stop();
  expect(events).toContain('telemetry_send_failed');
  store.close();
});

type RawProps = Record<string, string | number | boolean>;
