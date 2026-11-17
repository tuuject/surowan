import type { ConfigController } from '../../../platform/config/write.ts';
import { KEYCHAIN_NAME_PATTERN, KeychainError } from '../../../platform/keychain.ts';
import type { SecretStore } from '../../../platform/secrets.ts';
import { json, readJsonObject, redact } from '../http.ts';
import { keychainErrorStatus } from '../keychain-error.ts';

export interface KeychainAdminRoutesDeps {
  readonly configReloader: ConfigController | undefined;
  readonly secrets: SecretStore | undefined;
}

const NAME_SEGMENT = 1;

/**
 * `/api/keychain*` — the panel's keychain manager.
 *
 * Every route here is session-only by construction: none of them is a
 * `@surowan/admin-surface` spec, so a bearer key or a paired client is refused
 * by the shared gate before this handler ever runs, and no CLI command or MCP
 * tool is generated for them. Values never appear in any response.
 */
export function createKeychainAdminRoutes(deps: KeychainAdminRoutesDeps) {
  const { configReloader, secrets } = deps;

  const snapshotResponse = async (reloader: ConfigController): Promise<Response> => {
    try {
      return json(await reloader.keychainSnapshot());
    } catch (error) {
      return keychainFailure(error, secrets);
    }
  };

  return {
    async handle(request: Request, _url: URL, segments: readonly string[]): Promise<Response | undefined> {
      if (segments[0] !== 'keychain') {
        return undefined;
      }
      const reloader = configReloader;
      if (reloader === undefined) {
        return json({ error: 'config_reload_unavailable', message: 'Configuration reloading is not wired' }, 503);
      }
      const route = segments.join('/');
      if (route === 'keychain') {
        if (request.method === 'GET') {
          return await snapshotResponse(reloader);
        }
        if (request.method === 'POST') {
          const body = await readBody(request, 4_096);
          const name = typeof body.name === 'string' ? body.name : '';
          if (!KEYCHAIN_NAME_PATTERN.test(name)) {
            return json({ error: 'invalid_body', message: 'name must use 1-64 letters, digits, "_" or "-"' }, 400);
          }
          if (typeof body.value !== 'string' || body.value.length === 0) {
            return json({ error: 'invalid_body', message: 'value must be a non-empty string' }, 400);
          }
          secrets?.remember(body.value);
          try {
            await reloader.keychainWrite({ add: { [name]: body.value } });
            return json({ status: 'created', name }, 201);
          } catch (error) {
            return keychainFailure(error, secrets);
          }
        }
        return json({ error: 'method_not_allowed', message: 'Unsupported keychain operation' }, 405);
      }
      if (route === 'keychain/purge' && request.method === 'POST') {
        const body = await readBody(request, 64 * 1024);
        if (!Array.isArray(body.names) || body.names.some((name) => typeof name !== 'string')) {
          return json({ error: 'invalid_body', message: 'names must be an array of entry names' }, 400);
        }
        try {
          return json(await reloader.keychainPurge(body.names as string[]));
        } catch (error) {
          return keychainFailure(error, secrets);
        }
      }
      const rest = segments.slice(NAME_SEGMENT);
      if (rest.length === 1 && rest[0] !== undefined) {
        const name = decodeEntryName(rest[0]);
        if (name === null) {
          return json({ error: 'invalid_body', message: 'The entry name must be percent-encoded UTF-8' }, 400);
        }
        if (request.method === 'PUT') {
          const body = await readBody(request, 4_096);
          if (typeof body.value !== 'string' || body.value.length === 0) {
            return json({ error: 'invalid_body', message: 'value must be a non-empty string' }, 400);
          }
          // A rotation is a keychain-only change: the file does not move, but
          // the running connections must adopt the new value, so one apply runs.
          secrets?.remember(body.value);
          try {
            const result = await reloader.keychainRotate(name, body.value);
            if (!result.ok) {
              const message = result.fileWritten
                ? `config.jsonc was updated but not applied: ${result.message}`
                : result.message;
              return json({ error: result.code, message: redact(secrets, message) }, 500);
            }
            return json({
              status: 'rotated',
              name,
              apply: {
                applied: result.applied,
                restart_required: result.restartRequired,
                outside_serve: result.outsideServe,
              },
            });
          } catch (error) {
            return keychainFailure(error, secrets);
          }
        }
        if (request.method === 'DELETE') {
          try {
            await reloader.keychainDelete(name);
            return json({ status: 'deleted', name });
          } catch (error) {
            return keychainFailure(error, secrets);
          }
        }
        return json({ error: 'method_not_allowed', message: 'Unsupported keychain operation' }, 405);
      }
      return json({ error: 'not_found', message: 'Unknown keychain route' }, 404);
    },
  };
}

function decodeEntryName(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

async function readBody(request: Request, maxBytes: number): Promise<Record<string, unknown>> {
  return await readJsonObject(request, maxBytes);
}

/** Maps a keychain failure onto its status; messages never contain values. */
function keychainFailure(error: unknown, secrets: SecretStore | undefined): Response {
  if (error instanceof KeychainError) {
    if (error.code === 'keychain_unparsable') {
      return json({ error: error.code, message: error.message }, 409);
    }
    return json({ error: error.code, message: error.message }, keychainErrorStatus(error));
  }
  return json({ error: 'keychain_write_failed', message: redact(secrets, error) }, 500);
}
