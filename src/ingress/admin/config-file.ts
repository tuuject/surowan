import type { ConfigController, ConfigErrorCode } from '../../platform/config/write.ts';
import type { SecretStore } from '../../platform/secrets.ts';
import { redact } from './http.ts';
import { AdminQueryError } from './audit/shared.ts';

/** Write failures the panel can act on, versus the ones that need an operator. */
export const CONFIG_WRITE_STATUS: Partial<Record<ConfigErrorCode, number>> = {
  config_conflict: 409,
  config_invalid: 422,
  config_permissions: 409,
  config_symlink: 409,
  secret_unresolved: 422,
  config_write_failed: 500,
};

/** The on-disk configuration plus the revision that describes exactly that read. */
export async function readConfigFile(reloader: ConfigController, secrets: SecretStore | undefined) {
  try {
    // A revision must describe the very file used to build the view and edit paths,
    // never a newer file read after an intervening write.
    const revision = await reloader.revision();
    const loaded = await reloader.readPersisted();
    if (revision !== (await reloader.revision())) {
      throw new AdminQueryError(
        'config_conflict',
        'The configuration file changed while being read; reload and try again',
        409,
      );
    }
    return { loaded, revision };
  } catch (error) {
    if (error instanceof AdminQueryError) {
      throw error;
    }
    throw new AdminQueryError('config_invalid', redact(secrets, error), 422);
  }
}
