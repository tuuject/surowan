import { access } from 'node:fs/promises';
import type { AdminCredentialCommand } from '../../../cli-options.ts';
import { assertConfigPermissions, loadConfig } from '../../../adapters/local-monolith/config/index.ts';
import { SqliteStore } from '../../../adapters/local-monolith/database.ts';
import { schemaMigrations } from '../../../store/schema/index.ts';
import { eq } from 'drizzle-orm';
import { parseId } from '../audit/shared.ts';
import {
  cancelPairing,
  createPairing,
  ensureInstanceId,
  listClients,
  listPendingPairings,
  revokeClient,
} from './index.ts';

/**
 * `surowan pairing …` / `surowan clients …`. These run against a data directory
 * a live `serve` may be using, so they open the store without migrating and
 * never take the serve lock: the operator reaches them over SSH while the bot
 * keeps running. The schema therefore has to already be there — a fresh data
 * directory is created by `serve` on this version.
 */
const REQUIRED_MIGRATION_VERSION = 58;
const SERVE_FIRST_HINT =
  'start (or restart) `serve` on this version once so migration 058 creates the paired-client tables';

export interface AdminCredentialCliOptions {
  readonly configPath: string;
  readonly command: AdminCredentialCommand;
}

export async function runAdminCredentialCommand(options: AdminCredentialCliOptions): Promise<void> {
  const loaded = await loadConfig(options.configPath);
  await assertConfigPermissions(loaded.configPath);
  // `SqliteStore.open` creates a missing file. An empty database left behind
  // here would make the first `serve` treat it as an existing one, so refuse
  // before opening anything.
  const databaseExists = await access(loaded.config.paths.database).then(
    () => true,
    () => false,
  );
  if (!databaseExists) {
    throw new Error(`The database does not exist yet; ${SERVE_FIRST_HINT}`);
  }
  const store = await SqliteStore.open(loaded.config, false);
  try {
    assertPairedClientSchema(store);
    const orm = store.orm;
    const instanceId = ensureInstanceId(orm);
    const command = options.command;
    switch (command.kind) {
      case 'pairing-create': {
        const created = await createPairing(orm, {
          name: command.name,
          mode: command.mode,
          ttlSeconds: command.ttlSeconds,
          publicKey: command.publicKey,
        });
        const admin = loaded.config.admin;
        // Without a public URL the client reaches the panel through an SSH
        // tunnel, so the hint names the local end of `ssh -L <port>:<host>:<port>`.
        // The bind address itself (often 0.0.0.0 or a LAN IP) is not a URL the
        // client accepts for plaintext HTTP.
        const endpoint = admin.public_url ?? `http://127.0.0.1:${admin.port}/`;
        console.log(
          JSON.stringify({
            status: 'ok',
            code: created.code,
            instance_id: instanceId,
            pairing: created.item,
            admin: { host: admin.host, port: admin.port, public_url: admin.public_url ?? null },
            next: `surowan-utils auth pair --endpoint ${endpoint} --code ${created.code}`,
          }),
        );
        return;
      }
      case 'pairing-list':
        console.log(JSON.stringify({ status: 'ok', instance_id: instanceId, items: await listPendingPairings(orm) }));
        return;
      case 'pairing-cancel': {
        const id = parseId(command.pairingId, 'pairing id');
        cancelPairing(orm, id);
        console.log(JSON.stringify({ status: 'ok', canceled: command.pairingId }));
        return;
      }
      case 'clients-list':
        console.log(JSON.stringify({ status: 'ok', instance_id: instanceId, items: listClients(orm) }));
        return;
      case 'clients-revoke': {
        const id = parseId(command.clientId, 'client id');
        const client = revokeClient(orm, id);
        console.log(JSON.stringify({ status: 'ok', client }));
        return;
      }
    }
  } finally {
    store.close();
  }
}

/**
 * A store opened without migrating must fail with instructions, not with
 * `SQLITE_ERROR: no such table`, because the common case is a deployment that
 * has not restarted `serve` since upgrading.
 */
function assertPairedClientSchema(store: SqliteStore): void {
  const hint = SERVE_FIRST_HINT;
  let applied: { readonly version: bigint } | undefined;
  try {
    applied = store.orm
      .select({ version: schemaMigrations.version })
      .from(schemaMigrations)
      .where(eq(schemaMigrations.version, BigInt(REQUIRED_MIGRATION_VERSION)))
      .get();
  } catch {
    throw new Error(`The paired-client tables are missing; ${hint}`);
  }
  if (applied === undefined) {
    throw new Error(`Migration ${REQUIRED_MIGRATION_VERSION} has not been applied; ${hint}`);
  }
}
