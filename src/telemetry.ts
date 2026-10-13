import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { count, eq, gte } from 'drizzle-orm';
import type { RawConfig } from './platform/config.ts';
import type { SqliteStore } from './store/database.ts';
import { appState, invocations } from './store/schema.ts';

/**
 * Anonymous, opt-in usage statistics, sent to PostHog.
 *
 * What is sent is deliberately coarse: the version, the platform, and a few
 * size buckets that show roughly how big a deployment is. It never includes
 * Telegram IDs, usernames, message or media content, prompts, model or
 * Provider names, URLs, hostnames or any Secret. The only identifier is a
 * random install ID kept in the local database; it is not derived from the bot
 * token or from any Chat, and is deleted again when consent is not granted.
 */

/** PostHog project API key. It is a public, write-only key; empty keeps reporting off. */
export const POSTHOG_PROJECT_KEY = '';
export const POSTHOG_HOST = 'https://us.i.posthog.com';

export const HEARTBEAT_INTERVAL_MS = 24 * 60 * 60 * 1000;
const SEND_TIMEOUT_MS = 5_000;
const INSTALL_ID_KEY = 'telemetry_install_id';

export type TelemetryOffReason = 'not_configured' | 'denied' | 'env_opt_out' | 'no_project_key';
export type TelemetryProperties = Readonly<Record<string, string | number | boolean>>;

export interface TelemetryOptions {
  readonly store: SqliteStore;
  readonly config: RawConfig;
  readonly log: (event: string, fields?: Record<string, string | number | boolean | null>) => void;
  readonly env?: NodeJS.ProcessEnv;
  readonly fetchImpl?: typeof fetch;
  readonly projectKey?: string;
  readonly host?: string;
  readonly now?: () => Date;
}

export interface TelemetryHandle {
  readonly enabled: boolean;
  stop(): void;
}

/** Why reporting is off, or `undefined` when it is on. Environment opt-outs win over the config. */
export function telemetryOffReason(
  config: Pick<RawConfig, 'telemetry'>,
  env: NodeJS.ProcessEnv,
  projectKey: string,
): TelemetryOffReason | undefined {
  if (config.telemetry === undefined) {
    return 'not_configured';
  }
  if (config.telemetry.consent === 'denied') {
    return 'denied';
  }
  // DO_NOT_TRACK is the cross-tool convention; the project variable is the explicit form.
  if (isTruthy(env.DO_NOT_TRACK) || env.PLASTICWAN_TELEMETRY === '0') {
    return 'env_opt_out';
  }
  return projectKey === '' ? 'no_project_key' : undefined;
}

function isTruthy(value: string | undefined): boolean {
  return value !== undefined && value !== '' && value !== '0' && value.toLowerCase() !== 'false';
}

/** Replaces an exact count with a range, so a deployment is never identifiable by its size. */
export function bucket(value: number): string {
  if (value <= 0) {
    return '0';
  }
  if (value === 1) {
    return '1';
  }
  const edges: ReadonlyArray<readonly [number, string]> = [
    [5, '2-5'],
    [20, '6-20'],
    [100, '21-100'],
    [1_000, '101-1000'],
  ];
  return edges.find(([max]) => value <= max)?.[1] ?? '1000+';
}

function packageVersion(): string {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'));
    if (typeof parsed === 'object' && parsed !== null && 'version' in parsed && typeof parsed.version === 'string') {
      return parsed.version;
    }
  } catch {
    // The version is a nicety; an unreadable package.json must not stop reporting.
  }
  return 'unknown';
}

export function startTelemetry(options: TelemetryOptions): TelemetryHandle {
  const { store, config, log } = options;
  const env = options.env ?? process.env;
  const projectKey = options.projectKey ?? POSTHOG_PROJECT_KEY;
  const reason = telemetryOffReason(config, env, projectKey);
  if (reason !== undefined) {
    // No consent, no identifier: withdrawing consent also forgets the install ID.
    store.orm.delete(appState).where(eq(appState.key, INSTALL_ID_KEY)).run();
    log('telemetry_disabled', { reason });
    return { enabled: false, stop: () => undefined };
  }

  const send = options.fetchImpl ?? fetch;
  const host = options.host ?? POSTHOG_HOST;
  const now = options.now ?? (() => new Date());
  const installId = ensureInstallId(store, now());
  const version = packageVersion();
  let stopped = false;

  const properties = (): TelemetryProperties => {
    const since = new Date(now().getTime() - HEARTBEAT_INTERVAL_MS).toISOString();
    const recent =
      store.orm.select({ value: count() }).from(invocations).where(gte(invocations.startedAt, since)).get()?.value ?? 0;
    return {
      version,
      node_major: Number(process.versions.node.split('.')[0]),
      platform: process.platform,
      arch: process.arch,
      docker: existsSync('/.dockerenv'),
      chats: bucket(config.telegram.chats.length),
      has_group_chats: config.telegram.chats.some((chat) => chat.id < 0),
      mcp_servers: bucket(config.mcp?.servers.length ?? 0),
      admin_enabled: config.admin?.enabled === true,
      image_enabled: config.image !== undefined,
      invocations_24h: bucket(recent),
    };
  };

  const report = async (event: string): Promise<void> => {
    if (stopped) {
      return;
    }
    try {
      const sent = properties();
      const body = {
        api_key: projectKey,
        event,
        distinct_id: installId,
        timestamp: now().toISOString(),
        properties: {
          ...sent,
          // Anonymous events: no person profile, and no location lookup from the sender's IP.
          $process_person_profile: false,
          $geoip_disable: true,
          $lib: 'plasticwan',
        },
      };
      const response = await send(`${host}/capture/`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
      // The payload is logged so an operator can audit exactly what left the machine.
      log('telemetry_sent', { event, status: response.status, properties: JSON.stringify(sent) });
    } catch (error) {
      log('telemetry_send_failed', { event, error: error instanceof Error ? error.message : String(error) });
    }
  };

  void report('instance_started');
  const timer = setInterval(() => void report('instance_heartbeat'), HEARTBEAT_INTERVAL_MS);
  timer.unref();
  return {
    enabled: true,
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}

function ensureInstallId(store: SqliteStore, at: Date): string {
  const existing = store.orm
    .select({ value: appState.value })
    .from(appState)
    .where(eq(appState.key, INSTALL_ID_KEY))
    .get();
  if (existing !== undefined) {
    return existing.value;
  }
  const value = randomUUID();
  store.orm.insert(appState).values({ key: INSTALL_ID_KEY, value, updatedAt: at.toISOString() }).run();
  return value;
}
