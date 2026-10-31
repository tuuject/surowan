import { access, chmod, cp, mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { RawConfig } from '../../platform/config/index.ts';
import { MemoBlobStore } from '../../context/memo-pad/blobs.ts';
import * as schema from '../../store/schema/index.ts';
import { purgeExpiredData, type BusinessStore, type Orm } from '../../store/store.ts';

interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
  /**
   * Set by the `-- @rebuild-tables` directive. Such a migration rewrites
   * existing tables (create/copy/drop/rename) and therefore needs foreign key
   * enforcement suspended for the DDL window; see applyRebuildMigration.
   */
  readonly rebuildsTables: boolean;
}

/** PID file: names the holder for humans and `--takeover`; carries no authority. */
const PID_FILE = 'serve.lock';

/**
 * Mutex file: the single-instance guard itself. The lock is an EXCLUSIVE SQLite
 * transaction held for the lifetime of the process, so the kernel releases it
 * when the process dies — a crash, a `SIGKILL` or a replaced container can
 * never leave a lock behind. A PID in a file cannot do that: inside a container
 * the recorded PID is 1, and PID 1 exists again in every new container, which
 * made every restart look like a running instance.
 *
 * The table only makes the file self-describing; no row is ever written.
 */
const MUTEX_FILE = 'serve.lock.sqlite';
const MUTEX_TABLE = 'serve_lock';

export class ServeLock {
  readonly #pidPath: string;
  readonly #mutex: Database.Database;

  private constructor(pidPath: string, mutex: Database.Database) {
    this.#pidPath = pidPath;
    this.#mutex = mutex;
  }

  static async acquire(dataDir: string): Promise<ServeLock> {
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    const pidPath = join(dataDir, PID_FILE);
    const mutexPath = join(dataDir, MUTEX_FILE);
    const mutex = new Database(mutexPath);
    try {
      mutex.pragma('busy_timeout = 0');
      mutex.exec(`CREATE TABLE IF NOT EXISTS ${MUTEX_TABLE} (id INTEGER PRIMARY KEY)`);
      mutex.exec('BEGIN EXCLUSIVE');
      // `BEGIN EXCLUSIVE` alone can leave the OS lock unclaimed until the
      // connection touches the database; this read claims it before returning.
      mutex.prepare(`SELECT count(*) AS held FROM ${MUTEX_TABLE}`).get();
    } catch (error) {
      mutex.close();
      if (!(error instanceof Database.SqliteError && error.code === 'SQLITE_BUSY')) {
        throw new Error(`Unable to acquire serve lock ${mutexPath}`, { cause: error });
      }
      const pid = await readPidFile(pidPath);
      throw new Error(
        pid === null
          ? `Another serve process holds ${pidPath}`
          : `Another serve process holds ${pidPath} with PID ${pid}`,
      );
    }
    try {
      await writeFile(pidPath, `${process.pid}\n`, { encoding: 'utf8', mode: 0o600 });
    } catch (error) {
      // No ServeLock reaches the caller, so nothing else could ever release it.
      mutex.close();
      throw error;
    }
    return new ServeLock(pidPath, mutex);
  }

  async release(): Promise<void> {
    // The PID file is only ever written or removed under the mutex. Removing it
    // after closing would race a successor that acquires in between — and in
    // containers both PIDs are 1, so no content check can tell the files apart.
    try {
      await unlink(this.#pidPath).catch((error: unknown) => {
        const code = error instanceof Error && 'code' in error ? error.code : undefined;
        if (code !== 'ENOENT') {
          throw error;
        }
      });
    } finally {
      // Closing rolls back the transaction and drops the kernel lock, which is
      // what a waiting takeover polls for.
      this.#mutex.close();
    }
  }
}

async function readPidFile(pidPath: string): Promise<number | null> {
  const pid = Number.parseInt(await readFile(pidPath, 'utf8').catch(() => ''), 10);
  return Number.isInteger(pid) ? pid : null;
}

/**
 * True while another connection holds `mutex`'s EXCLUSIVE transaction. The
 * probe only reads: SQLite answers SQLITE_BUSY for any access while the lock is
 * held, and it leaves no trace when the mutex is free. `schema_version` rather
 * than the lock table so that a mutex file which never finished initializing
 * still answers instead of failing on a missing table.
 */
function mutexHeld(mutex: Database.Database): boolean {
  try {
    mutex.prepare('PRAGMA schema_version').get();
    return false;
  } catch (error) {
    if (error instanceof Database.SqliteError && error.code === 'SQLITE_BUSY') {
      return true;
    }
    throw error;
  }
}

/** Cooperative stop request written next to `serve.lock`; see `stopRunningInstance`. */
const STOP_REQUEST_FILE = 'serve.stop';

/** Granularity of the stop-request watcher and of the takeover's wait loop. */
const STOP_REQUEST_POLL_MS = 200;

/**
 * Gracefully stops the `serve` process that holds `dataDir`'s mutex, or returns
 * null when no live process holds it. The stopped holder's `pid` is null when
 * it never published one: it was between taking the mutex and writing the PID
 * file, or already past removing it on the way out.
 *
 * Liveness is decided by the mutex, not by the PID: the kernel drops the lock
 * when its holder dies, so a restart in a fresh container (where the recorded
 * PID 1 is alive again) cannot be mistaken for a running instance. A leftover
 * PID file is neither trusted nor removed here: deleting it outside the mutex
 * could delete the file of an instance that acquires in the meantime, and the
 * next acquisition overwrites it anyway.
 *
 * A stop request is a file, not a signal: Windows has no graceful `SIGTERM`,
 * and only the target can run its own shutdown path. The target releases the
 * mutex as the last step of that path, so waiting for the mutex to free also
 * waits for its SQLite handle to be closed. A process that cannot react — a
 * wedged or suspended serve — times out instead of being killed.
 */
export async function stopRunningInstance(
  dataDir: string,
  timeoutMs = 60_000,
): Promise<{ readonly pid: number | null } | null> {
  const pidPath = join(dataDir, PID_FILE);
  const mutexPath = join(dataDir, MUTEX_FILE);
  if (!(await fileExists(mutexPath))) {
    return null;
  }
  const mutex = new Database(mutexPath);
  try {
    mutex.pragma('busy_timeout = 0');
    if (!mutexHeld(mutex)) {
      return null;
    }
    const stopPath = join(dataDir, STOP_REQUEST_FILE);
    let pid: number | null = null;
    try {
      const deadline = Date.now() + timeoutMs;
      while (mutexHeld(mutex)) {
        if (Date.now() >= deadline) {
          const holder = pid === null ? 'A serve process' : `PID ${pid}`;
          throw new Error(`${holder} still holds ${mutexPath} after ${timeoutMs}ms`);
        }
        pid ??= await readPidFile(pidPath);
        // A holder that is still starting drops leftover requests when its
        // watcher begins, which can sweep this one away too: publish it again.
        if (!(await fileExists(stopPath))) {
          await writeFile(stopPath, `${process.pid}\n`, { encoding: 'utf8', mode: 0o600 });
        }
        await delay(STOP_REQUEST_POLL_MS);
      }
    } finally {
      await unlink(stopPath).catch(() => undefined);
    }
    return { pid };
  } finally {
    mutex.close();
  }
}

/**
 * Watches `dataDir` for a takeover's stop request and calls `onRequest` once.
 * Polling rather than `fs.watch` because the file does not exist yet and the
 * request has to be seen on every platform; the timer is unref'd so it never
 * keeps the process alive on its own. A stop file that is already there when
 * watching starts is stale — a takeover removes its own request before
 * returning, so a leftover can only be a crash — and is dropped, not honored;
 * a takeover still waiting on this process publishes its request again.
 */
export function watchStopRequests(dataDir: string, onRequest: () => void): () => void {
  const stopPath = join(dataDir, STOP_REQUEST_FILE);
  let watching = true;
  void unlink(stopPath).catch(() => undefined);
  const timer = setInterval(() => {
    void fileExists(stopPath).then((found) => {
      if (found && watching) {
        onRequest();
      }
    });
  }, STOP_REQUEST_POLL_MS);
  timer.unref();
  return () => {
    watching = false;
    clearInterval(timer);
  };
}

export class SqliteStore implements BusinessStore {
  readonly db: Database.Database;
  /** Drizzle query layer. Use sync methods (`.all()`, `.get()`, `.run()`, `.values()`) so statements execute inside `transaction()`. */
  readonly orm: Orm;
  readonly path: string;

  private constructor(path: string, database: Database.Database, orm: Orm) {
    this.path = path;
    this.db = database;
    this.orm = orm;
  }

  static async open(config: RawConfig, migrate = true): Promise<SqliteStore> {
    const path = config.paths.database;
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const existed = await access(path).then(
      () => true,
      () => false,
    );
    const database = new Database(path);
    database.defaultSafeIntegers(true);
    database.exec('PRAGMA journal_mode = WAL;');
    database.exec('PRAGMA synchronous = FULL;');
    database.exec('PRAGMA foreign_keys = ON;');
    database.exec('PRAGMA busy_timeout = 5000;');
    const store = new SqliteStore(path, database, drizzle(database, { schema }));
    try {
      if (migrate) {
        await store.migrate(config, existed);
      }
      if (process.platform !== 'win32') {
        await chmod(path, 0o600);
      }
      return store;
    } catch (error) {
      database.close();
      throw error;
    }
  }

  close(): void {
    // Drizzle statements must not retain file handles until GC.
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    this.db.close();
  }

  transaction<T>(work: () => T): T {
    return this.db.transaction(work).immediate();
  }

  private async migrate(config: RawConfig, databaseExisted: boolean): Promise<void> {
    const migrations = await loadMigrations();
    const applied = this.hasTable('schema_migrations')
      ? new Set(
          this.db
            .prepare<[], { version: bigint }>('SELECT version FROM schema_migrations ORDER BY version')
            .all()
            .map((row) => Number(row.version)),
        )
      : new Set<number>();
    const pending = migrations.filter((migration) => !applied.has(migration.version));
    if (pending.length === 0) {
      return;
    }
    if (databaseExisted) {
      await createBackupFile(
        this.db,
        config.paths.backups,
        `pre-migration-${timestampForFile()}-${crypto.randomUUID()}.sqlite`,
      );
    }
    for (const migration of pending) {
      if (migration.rebuildsTables) {
        this.applyRebuildMigration(migration);
        continue;
      }
      this.transaction(() => {
        this.db.exec(migration.sql);
        this.recordMigration(migration);
      });
    }
  }

  private recordMigration(migration: Migration): void {
    this.db
      .prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)')
      .run(BigInt(migration.version), new Date().toISOString());
  }

  /**
   * Applies a table-rebuild migration.
   *
   * SQLite cannot relax a NOT NULL constraint with ALTER TABLE, so a rebuild is
   * unavoidable when an unconditional Telegram column becomes conditional.
   * Rebuilding with foreign keys enforced is not an option: `chats` is a
   * cascade parent of the whole message tree, so dropping it would delete every
   * conversation, while `messages` is referenced by NO ACTION tables, so the
   * same drop would fail outright. SQLite's documented procedure therefore
   * turns enforcement off for the DDL window; we do the same but keep it
   * bounded and verified: the whole migration stays in one transaction, and it
   * is rolled back unless `PRAGMA foreign_key_check` reports the rebuilt schema
   * is intact. Enforcement is restored unconditionally before returning.
   */
  private applyRebuildMigration(migration: Migration): void {
    if (Number(this.db.pragma('foreign_keys', { simple: true })) !== 1) {
      throw new Error(`Migration ${migration.name} expects foreign keys to be enabled before the rebuild`);
    }
    this.db.exec('PRAGMA foreign_keys = OFF');
    try {
      this.transaction(() => {
        this.db.exec(migration.sql);
        this.recordMigration(migration);
        const violations = this.db.pragma('foreign_key_check') as unknown[];
        if (violations.length > 0) {
          throw new Error(
            `Migration ${migration.name} left ${violations.length} foreign key violation(s): ${JSON.stringify(violations.slice(0, 5))}`,
          );
        }
      });
    } finally {
      this.db.exec('PRAGMA foreign_keys = ON');
    }
  }

  private hasTable(name: string): boolean {
    return (
      this.db
        .prepare<[string], { present: number }>(
          "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?",
        )
        .get(name) !== undefined
    );
  }
}

export async function backupDatabase(config: RawConfig): Promise<string> {
  await mkdir(config.paths.backups, { recursive: true, mode: 0o700 });
  const source = new Database(config.paths.database, { fileMustExist: true });
  source.defaultSafeIntegers(true);
  try {
    source.exec('PRAGMA journal_mode = WAL;');
    source.exec('PRAGMA synchronous = FULL;');
    source.exec('PRAGMA foreign_keys = ON;');
    source.exec('PRAGMA busy_timeout = 5000;');
    const sourceOrm = drizzle(source, { schema });
    purgeExpiredData(sourceOrm, config);
    // Expired Memo entries are gone; drop the blob rows and files no remaining
    // detail references before the SQLite copy is taken.
    await new MemoBlobStore({
      orm: sourceOrm,
      root: join(config.data_dir, 'images', 'memo-blobs'),
    }).sweep();
    const filename = `surowan-${timestampForFile()}-${crypto.randomUUID()}.sqlite`;
    const path = await createBackupFile(source, config.paths.backups, filename);
    // Original image files live outside SQLite; snapshot them next to the copy
    // so a backup restores both. Best-effort: a missing directory simply means
    // no image assets exist yet, and a copy failure is logged, not fatal — the
    // SQLite snapshot stays valid. There is no cross-store atomicity: rows
    // committed after the VACUUM snapshot may reference images copied earlier
    // or later than the exact backup point.
    await snapshotImageDirectory(config, path);
    await rotateBackups(config.paths.backups, config.retention.backup_copies);
    return path;
  } finally {
    source.close();
  }
}

/**
 * Copies the image asset directory to `<backup-basename>.images/` beside the
 * SQLite backup file. Skipped entirely when the directory does not exist.
 */
async function snapshotImageDirectory(config: RawConfig, sqliteBackupPath: string): Promise<void> {
  const imageDir = join(config.data_dir, 'images');
  if (!(await fileExists(imageDir))) {
    return;
  }
  const target = sqliteBackupPath.replace(/\.sqlite$/, '.images');
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await cp(imageDir, target, { recursive: true, verbatimSymlinks: false });
  await chmod(target, 0o700).catch(() => undefined);
}

async function createBackupFile(database: Database.Database, backupDir: string, filename: string): Promise<string> {
  await mkdir(backupDir, { recursive: true, mode: 0o700 });
  const finalPath = join(backupDir, filename);
  const temporaryPath = `${finalPath}.tmp-${crypto.randomUUID()}`;
  database.prepare('VACUUM INTO ?').run(temporaryPath);
  if (process.platform !== 'win32') {
    await chmod(temporaryPath, 0o600);
  }
  await rename(temporaryPath, finalPath);
  return finalPath;
}
async function rotateBackups(backupDir: string, keep: number): Promise<void> {
  const entries = await readdir(backupDir, { withFileTypes: true });
  const files = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.sqlite'))
      .map(async (entry) => ({
        path: join(backupDir, entry.name),
        modified: (await stat(join(backupDir, entry.name))).mtimeMs,
      })),
  );
  files.sort((left, right) => right.modified - left.modified);
  await Promise.all(files.slice(keep).map((file) => unlink(file.path)));
  // Drop the image snapshots that belong to rotated-away SQLite copies.
  const rotated = new Set(files.slice(keep).map((file) => basename(file.path, '.sqlite')));
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && rotated.has(basename(entry.name, '.images')))
      .map((entry) => rm(join(backupDir, entry.name), { recursive: true })),
  );
}

/**
 * Opt-in marker for migrations that rebuild existing tables. It must appear on
 * its own line; see applyRebuildMigration for why such a migration cannot run
 * with foreign key enforcement on.
 */
const REBUILD_DIRECTIVE = /^--[ \t]*@rebuild-tables[ \t]*$/m;

async function loadMigrations(): Promise<Migration[]> {
  const directory = join(import.meta.dirname, '../../store/migrations');
  const names = (await readdir(directory)).filter((name) => /^\d{3}_[a-z0-9_]+\.sql$/.test(name)).sort();
  const migrations: Migration[] = [];
  for (const name of names) {
    const version = Number.parseInt(name.slice(0, 3), 10);
    const sql = await readFile(join(directory, name), 'utf8');
    migrations.push({ version, name, sql, rebuildsTables: REBUILD_DIRECTIVE.test(sql) });
  }
  for (let index = 1; index < migrations.length; index += 1) {
    const previous = migrations[index - 1];
    const current = migrations[index];
    if (previous === undefined || current === undefined) {
      continue;
    }
    if (previous.version >= current.version) {
      throw new Error(`Migration versions are not strictly increasing near ${current.name}`);
    }
  }
  return migrations;
}

function timestampForFile(): string {
  return new Date().toISOString().replaceAll(':', '-');
}

async function fileExists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
