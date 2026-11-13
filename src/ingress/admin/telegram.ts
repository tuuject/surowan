/**
 * `/api/telegram`: the Telegram connection state and the fields the panel owns
 * in the `telegram` section — its Bot Token and the bucket timing.
 *
 * The state comes from the live connection registry, while the token answer,
 * the saved timing and the revision come from the file on disk — the panel
 * edits the file, so a hand-edited value must be visible before it is applied.
 * The running timing comes from the published configuration. A plaintext token
 * travels only into the key jar; the response never contains it.
 */
import Compile from 'typebox/compile';
import type { FileConfig, RawConfig } from '../../platform/config/index.ts';
import { ConfigSchema } from '../../platform/config/schema.ts';
import type { ConfigController, ConfigEdit } from '../../platform/config/write.ts';
import { secretEdit } from '../../platform/config/write.ts';
import type { ImConnectionRegistry } from '../../platform/im-connection.ts';
import type { RuntimeConfigurationStore } from '../../platform/runtime-config.ts';
import type { SecretStore } from '../../platform/secrets.ts';
import { json, readJsonObject, redact, requiredRevision, revisionRequired } from './http.ts';
import { AdminQueryError } from './audit/shared.ts';
import { CONFIG_WRITE_STATUS, readConfigFile } from './config-file.ts';

export interface TelegramAdminDeps {
  readonly connections: Pick<ImConnectionRegistry, 'get'>;
  readonly configStore: Pick<RuntimeConfigurationStore, 'current'>;
  readonly configReloader: ConfigController | undefined;
  readonly secrets: SecretStore | undefined;
}

type BucketTimingSource = Pick<
  RawConfig['telegram'],
  'bucket_window_seconds' | 'bucket_max_seconds' | 'bucket_bump_seconds'
>;

/**
 * The three `telegram.bucket_*` fields as the panel edits them. An absent
 * ceiling is `null` — it follows the window, whatever the window becomes —
 * and an absent bump is the `0` it means.
 */
function bucketTimingValues(telegram: BucketTimingSource) {
  return {
    bucket_window_seconds: telegram.bucket_window_seconds,
    bucket_max_seconds: telegram.bucket_max_seconds ?? null,
    bucket_bump_seconds: telegram.bucket_bump_seconds ?? 0,
  };
}

interface TelegramViewSource {
  readonly file: FileConfig;
  /** The same file, resolved: a missing section reads as its defaults. */
  readonly saved: RawConfig;
  readonly active: RawConfig;
  readonly revision: string;
  readonly connections: Pick<ImConnectionRegistry, 'get'>;
}

/**
 * The panel-facing view. `token_configured` is a boolean by design: the value
 * may come from a jar, an environment variable or a command, and none of those
 * should be distinguishable from the response.
 */
function telegramView(source: TelegramViewSource) {
  const telegram = source.file.telegram;
  return {
    revision: source.revision,
    status: source.connections.get('telegram'),
    telegram_section_present: telegram !== undefined,
    token_configured: telegram?.token !== undefined,
    bucket_timing: {
      saved: bucketTimingValues(source.saved.telegram),
      active: bucketTimingValues(source.active.telegram),
    },
  };
}

type BucketTimingField = keyof ReturnType<typeof bucketTimingValues>;

const telegramFields = ConfigSchema.properties.telegram.properties;

/** Each field reuses its configuration schema; only the window is required in the section. */
const BUCKET_TIMING_FIELDS: Readonly<
  Record<BucketTimingField, { readonly validator: ReturnType<typeof Compile>; readonly absent?: number }>
> = {
  bucket_window_seconds: { validator: Compile(telegramFields.bucket_window_seconds) },
  bucket_max_seconds: { validator: Compile(telegramFields.bucket_max_seconds) },
  bucket_bump_seconds: { validator: Compile(telegramFields.bucket_bump_seconds), absent: 0 },
};

function isBucketTimingField(key: string): key is BucketTimingField {
  return Object.hasOwn(BUCKET_TIMING_FIELDS, key);
}

/** The only body a token write accepts: `token` is a new plaintext or `null` to clear it. */
function parseToken(body: Record<string, unknown>): string | null {
  const keys = Object.keys(body);
  if (keys.length !== 1 || !Object.hasOwn(body, 'token')) {
    throw new AdminQueryError('invalid_body', 'Expected { token: string | null }');
  }
  const token = body.token;
  if (token === null) {
    return null;
  }
  // A Bot Token never carries whitespace or control characters; accepting them
  // would only produce a valid file that Telegram rejects forever.
  if (
    typeof token !== 'string' ||
    token.length === 0 ||
    token.length > 4_096 ||
    /\s/u.test(token) ||
    /\p{Cc}/u.test(token)
  ) {
    throw new AdminQueryError(
      'invalid_body',
      'token must be a non-empty string without whitespace, or null to clear it',
    );
  }
  return token;
}

/**
 * Parses `{ bucket_window_seconds?, bucket_max_seconds?, bucket_bump_seconds? }`.
 * `null` removes an optional field; the window cannot be removed. Ranges come
 * from the configuration schema, and cross-field rules (the ceiling covers the
 * window, the idle grace covers the ceiling) are checked on the whole file.
 */
function parseBucketTiming(body: Record<string, unknown>): ReadonlyMap<BucketTimingField, number | null> {
  const entries = Object.entries(body);
  if (entries.length === 0) {
    throw new AdminQueryError('invalid_body', 'Provide at least one bucket timing field');
  }
  const parsed = new Map<BucketTimingField, number | null>();
  for (const [key, value] of entries) {
    if (!isBucketTimingField(key)) {
      throw new AdminQueryError(
        'invalid_body',
        `Unknown field ${key}; expected bucket_window_seconds, bucket_max_seconds or bucket_bump_seconds`,
      );
    }
    if (value === null && key !== 'bucket_window_seconds') {
      parsed.set(key, null);
      continue;
    }
    if (typeof value !== 'number' || !BUCKET_TIMING_FIELDS[key].validator.Check(value)) {
      throw new AdminQueryError(
        'invalid_bucket_timing',
        key === 'bucket_window_seconds'
          ? 'telegram.bucket_window_seconds must be an integer from 0 to 300'
          : `telegram.${key} must be an integer from 0 to 300, or null to remove it`,
      );
    }
    parsed.set(key, value);
  }
  return parsed;
}

/**
 * The file edits a timing write makes. A value the file already holds, or an
 * optional field set to what its absence already means, is skipped, so a write
 * that changes nothing leaves the file alone.
 */
function bucketTimingEdits(
  file: FileConfig['telegram'],
  values: ReadonlyMap<BucketTimingField, number | null>,
): ConfigEdit[] {
  const edits: ConfigEdit[] = [];
  for (const [key, value] of values) {
    const current = file?.[key];
    const unchanged =
      current === undefined ? value === null || value === BUCKET_TIMING_FIELDS[key].absent : current === value;
    if (!unchanged) {
      edits.push({ path: ['telegram', key], value: value ?? undefined });
    }
  }
  return edits;
}

export function createTelegramAdminHandler(deps: TelegramAdminDeps) {
  const { connections, configStore, configReloader, secrets } = deps;

  const viewOf = (file: Awaited<ReturnType<typeof readConfigFile>>) =>
    telegramView({
      file: file.loaded.fileConfig,
      saved: file.loaded.config,
      active: configStore.current().config,
      revision: file.revision,
      connections,
    });

  /** Applies edits like every other configuration write and answers with the fresh view. */
  const writeAndRespond = async (
    reloader: ConfigController,
    edits: readonly ConfigEdit[],
    revision: string,
  ): Promise<Response> => {
    const result = await reloader.writeAndApply(edits, revision);
    if (!result.ok) {
      const message = result.fileWritten
        ? `config.jsonc was updated but not applied: ${result.message}`
        : result.message;
      return json({ error: result.code, message: redact(secrets, message) }, CONFIG_WRITE_STATUS[result.code] ?? 409);
    }
    return json({
      ...viewOf(await readConfigFile(reloader, secrets)),
      apply: { applied: result.applied, restart_required: result.restartRequired, outside_serve: result.outsideServe },
    });
  };

  const writeToken = async (reloader: ConfigController, request: Request): Promise<Response> => {
    const revision = requiredRevision(request);
    if (revision === null) {
      return revisionRequired();
    }
    const token = parseToken(await readJsonObject(request));
    const current = await readConfigFile(reloader, secrets);
    if (revision !== current.revision) {
      return json({ error: 'config_conflict', message: 'The configuration file changed; reload before editing' }, 409);
    }
    if (token === null) {
      if (current.loaded.fileConfig.telegram?.token === undefined) {
        // Idempotent clear: the token is already absent, and writing an
        // undefined value would fail as a no-op edit.
        return json({
          ...viewOf(current),
          apply: { applied: [], restart_required: reloader.status().restartRequired, outside_serve: [] },
        });
      }
      return await writeAndRespond(reloader, [{ path: ['telegram', 'token'], value: undefined }], revision);
    }
    // Registered before the write so every later error path can redact it.
    secrets?.remember(token);
    // `config-file.ts` creates a missing `telegram` section from
    // `TELEGRAM_DEFAULTS` (chats: []) before applying this edit.
    return await writeAndRespond(reloader, [secretEdit(['telegram', 'token'], token)], revision);
  };

  /**
   * Saves the bucket timing. The fields are hot: the next batch opens with
   * them, while a batch already collecting keeps the timing it opened with.
   */
  const writeBucketTiming = async (reloader: ConfigController, request: Request): Promise<Response> => {
    const revision = requiredRevision(request);
    if (revision === null) {
      return revisionRequired();
    }
    const values = parseBucketTiming(await readJsonObject(request));
    const current = await readConfigFile(reloader, secrets);
    if (revision !== current.revision) {
      return json({ error: 'config_conflict', message: 'The configuration file changed; reload before editing' }, 409);
    }
    const edits = bucketTimingEdits(current.loaded.fileConfig.telegram, values);
    if (edits.length === 0) {
      return json({ ...viewOf(current), apply: { applied: [], restart_required: [], outside_serve: [] } });
    }
    return await writeAndRespond(reloader, edits, revision);
  };

  return {
    async handle(request: Request, segments: readonly string[]): Promise<Response | undefined> {
      const route = segments.join('/');
      if (route !== 'telegram' && route !== 'telegram/bucket-timing') {
        return undefined;
      }
      const reloader = configReloader;
      if (reloader === undefined) {
        return json({ error: 'config_reload_unavailable', message: 'Configuration reloading is not wired' }, 503);
      }
      if (route === 'telegram/bucket-timing') {
        return request.method === 'PUT'
          ? await writeBucketTiming(reloader, request)
          : json({ error: 'method_not_allowed', message: 'Unsupported bucket timing operation' }, 405);
      }
      if (request.method === 'GET') {
        return json(viewOf(await readConfigFile(reloader, secrets)));
      }
      if (request.method === 'PUT') {
        return await writeToken(reloader, request);
      }
      return json({ error: 'method_not_allowed', message: 'Unsupported Telegram operation' }, 405);
    },
  };
}
