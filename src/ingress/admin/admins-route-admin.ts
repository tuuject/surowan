import type { SecretStore } from '../../platform/secrets.ts';
import type { ConfigController } from '../../platform/config-write.ts';
import { json, readJsonObject, requiredRevision, revisionRequired } from './admin-http.ts';
import { AdminQueryError } from './audit.ts';
import { CONFIG_WRITE_STATUS, readConfigFile } from './config-file-admin.ts';

export interface AdminsAdminDeps {
  readonly configReloader: ConfigController | undefined;
  readonly secrets: SecretStore | undefined;
}

/**
 * The bot admin whitelist is the `telegram.admins` config field. GET shows
 * the on-disk list with its revision; POST/DELETE write that field through
 * the reloader, so a successful write is hot-applied like every other
 * configuration write.
 */
export function createAdminsAdminHandler(deps: AdminsAdminDeps) {
  const { configReloader, secrets } = deps;

  const adminItems = (admins: readonly number[] | undefined): { telegram_user_id: string }[] =>
    (admins ?? []).map((id) => ({ telegram_user_id: id.toString() }));

  const parseTelegramUserId = (value: unknown, field = 'telegram_user_id'): number => {
    const parsed =
      typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : Number.NaN;
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      throw new AdminQueryError('invalid_telegram_user_id', `${field} must be a positive safe integer`, 400);
    }
    return parsed;
  };

  const adminsView = async (): Promise<Response> => {
    const reloader = configReloader;
    if (reloader === undefined) {
      return json({ error: 'admins_unavailable', message: 'Configuration reloading is not wired' }, 503);
    }
    const { loaded, revision } = await readConfigFile(reloader, secrets);
    return json({ items: adminItems(loaded.fileConfig.telegram.admins), revision });
  };

  const writeAdmins = async (request: Request, removeId?: string): Promise<Response> => {
    const reloader = configReloader;
    if (reloader === undefined) {
      return json({ error: 'admins_unavailable', message: 'Configuration reloading is not wired' }, 503);
    }
    const revision = requiredRevision(request);
    if (revision === null) {
      return revisionRequired();
    }
    const { loaded, revision: currentRevision } = await readConfigFile(reloader, secrets);
    if (revision !== currentRevision) {
      return json({ error: 'config_conflict', message: 'The configuration file changed; reload before editing' }, 409);
    }
    const current = loaded.fileConfig.telegram.admins ?? [];
    let merged: number[];
    if (removeId === undefined) {
      const added = parseTelegramUserId((await readJsonObject(request)).telegram_user_id);
      // Adding an existing ID is a no-op; a no-change edit would fail the write.
      if (current.includes(added)) {
        return json({
          items: adminItems(current),
          revision: currentRevision,
          apply: { applied: [], restart_required: [], outside_serve: [] },
        });
      }
      merged = [...current, added];
    } else {
      const removed = parseTelegramUserId(removeId, 'admin_id');
      if (!current.includes(removed)) {
        return json({ error: 'not_found', message: 'The Telegram user ID is not in the bot admin whitelist' }, 404);
      }
      merged = current.filter((entry) => entry !== removed);
    }
    const result = await reloader.writeAndApply([{ path: ['telegram', 'admins'], value: merged }], revision);
    if (!result.ok) {
      const message = result.fileWritten
        ? `config.jsonc was updated but not applied: ${result.message}`
        : result.message;
      return json({ error: result.code, message }, CONFIG_WRITE_STATUS[result.code] ?? 409);
    }
    const view = await readConfigFile(reloader, secrets);
    return json({
      items: adminItems(view.loaded.fileConfig.telegram.admins),
      revision: view.revision,
      apply: { applied: result.applied, restart_required: result.restartRequired, outside_serve: result.outsideServe },
    });
  };

  return {
    async handle(request: Request, segments: readonly string[]): Promise<Response | undefined> {
      const route = segments.join('/');
      if (route === 'admins' && request.method === 'GET') {
        return await adminsView();
      }
      if (route === 'admins' && request.method === 'POST') {
        return await writeAdmins(request);
      }
      if (segments[0] === 'admins' && segments.length === 2 && request.method === 'DELETE') {
        return await writeAdmins(request, segments[1] ?? '');
      }
      return undefined;
    },
  };
}
