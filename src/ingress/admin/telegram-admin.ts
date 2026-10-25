/**
 * `/api/telegram`: the Telegram connection state and the one field the panel
 * owns in the `telegram` section, its Bot Token.
 *
 * The state comes from the live connection registry, while the token answer and
 * the revision come from the file on disk — the panel edits the file, so a
 * hand-edited value must be visible before it is applied. A plaintext token
 * travels only into the key jar; the response never contains it.
 */
import type { FileConfig } from '../../platform/config.ts';
import type { ConfigController, ConfigEdit } from '../../platform/config-write.ts';
import { secretEdit } from '../../platform/config-write.ts';
import type { ImConnectionRegistry } from '../../platform/im-connection.ts';
import type { SecretStore } from '../../platform/secrets.ts';
import { json, readJsonObject, redact, requiredRevision, revisionRequired } from './admin-http.ts';
import { AdminQueryError } from './audit.ts';
import { CONFIG_WRITE_STATUS, readConfigFile } from './config-file-admin.ts';

export interface TelegramAdminDeps {
  readonly connections: Pick<ImConnectionRegistry, 'get'>;
  readonly configReloader: ConfigController | undefined;
  readonly secrets: SecretStore | undefined;
}

interface TelegramViewSource {
  readonly file: FileConfig;
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
  };
}

/** The only body a write accepts: `token` is a new plaintext or `null` to clear it. */
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

export function createTelegramAdminHandler(deps: TelegramAdminDeps) {
  const { connections, configReloader, secrets } = deps;

  const view = async (reloader: ConfigController): Promise<Response> => {
    const { loaded, revision } = await readConfigFile(reloader, secrets);
    return json(telegramView({ file: loaded.fileConfig, revision, connections }));
  };

  const write = async (reloader: ConfigController, request: Request): Promise<Response> => {
    const revision = requiredRevision(request);
    if (revision === null) {
      return revisionRequired();
    }
    const token = parseToken(await readJsonObject(request));
    const { loaded, revision: currentRevision } = await readConfigFile(reloader, secrets);
    if (revision !== currentRevision) {
      return json({ error: 'config_conflict', message: 'The configuration file changed; reload before editing' }, 409);
    }
    let edits: readonly ConfigEdit[];
    if (token === null) {
      if (loaded.fileConfig.telegram?.token === undefined) {
        // Idempotent clear: the token is already absent, and writing an
        // undefined value would fail as a no-op edit.
        return json({
          ...telegramView({ file: loaded.fileConfig, revision: currentRevision, connections }),
          apply: { applied: [], restart_required: reloader.status().restartRequired, outside_serve: [] },
        });
      }
      edits = [{ path: ['telegram', 'token'], value: undefined }];
    } else {
      // Registered before the write so every later error path can redact it.
      secrets?.remember(token);
      // `config-file.ts` creates a missing `telegram` section from
      // `TELEGRAM_DEFAULTS` (chats: []) before applying this edit.
      edits = [secretEdit(['telegram', 'token'], token)];
    }
    const result = await reloader.writeAndApply(edits, revision);
    if (!result.ok) {
      const message = result.fileWritten
        ? `config.jsonc was updated but not applied: ${result.message}`
        : result.message;
      return json({ error: result.code, message: redact(secrets, message) }, CONFIG_WRITE_STATUS[result.code] ?? 409);
    }
    const next = await readConfigFile(reloader, secrets);
    return json({
      ...telegramView({ file: next.loaded.fileConfig, revision: next.revision, connections }),
      apply: { applied: result.applied, restart_required: result.restartRequired, outside_serve: result.outsideServe },
    });
  };

  return {
    async handle(request: Request, segments: readonly string[]): Promise<Response | undefined> {
      if (segments.length !== 1 || segments[0] !== 'telegram') {
        return undefined;
      }
      const reloader = configReloader;
      if (reloader === undefined) {
        return json({ error: 'config_reload_unavailable', message: 'Configuration reloading is not wired' }, 503);
      }
      if (request.method === 'GET') {
        return await view(reloader);
      }
      if (request.method === 'PUT') {
        return await write(reloader, request);
      }
      return json({ error: 'method_not_allowed', message: 'Unsupported Telegram operation' }, 405);
    },
  };
}
