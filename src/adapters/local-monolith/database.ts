import {
  access,
  chmod,
  cp,
  type FileHandle,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { RawConfig } from '../../platform/config.ts';
import * as schema from '../../store/schema.ts';
import { purgeExpiredData, type BusinessStore, type Orm } from '../../store/store.ts';

interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

export class ServeLock {
  readonly #path: string;
  readonly #handle: FileHandle;

  private constructor(path: string, handle: FileHandle) {
    this.#path = path;
    this.#handle = handle;
  }

  static async acquire(dataDir: string): Promise<ServeLock> {
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    const path = join(dataDir, 'serve.lock');
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await open(path, 'wx', 0o600);
        await handle.writeFile(`${process.pid}\n`, { encoding: 'utf8' });
        return new ServeLock(path, handle);
      } catch (error) {
        const code = error instanceof Error && 'code' in error ? error.code : undefined;
        if (code !== 'EEXIST' || attempt > 0) {
          throw new Error(`Another serve process holds ${path}`);
        }
        const pid = Number.parseInt(await readFile(path, 'utf8'), 10);
        if (Number.isInteger(pid) && isProcessAlive(pid)) {
          throw new Error(`Another serve process holds ${path} with PID ${pid}`);
        }
        await unlink(path);
      }
    }
    throw new Error(`Unable to acquire serve lock: ${path}`);
  }

  async release(): Promise<void> {
    await this.#handle.close();
    await unlink(this.#path).catch((error: unknown) => {
      const code = error instanceof Error && 'code' in error ? error.code : undefined;
      if (code !== 'ENOENT') {
        throw error;
      }
    });
  }
}

/** Cooperative stop request written next to `serve.lock`; see `stopRunningInstance`. */
const STOP_REQUEST_FILE = 'serve.stop';

/** Granularity of the stop-request watcher and of the takeover's wait loop. */
const STOP_REQUEST_POLL_MS = 200;

/**
 * Gracefully stops the `serve` process that holds `dataDir`'s lock and returns
 * its PID, or null when no live process holds it — a stale lock is left to
 * `ServeLock.acquire`, which unlinks it.
 *
 * A stop request is a file, not a signal: Windows has no graceful `SIGTERM`,
 * and only the target can run its own shutdown path. The target releases the
 * lock as the last step of that path, so waiting for the lock to disappear also
 * waits for its SQLite handle to be closed. A PID that is not a serve process
 * (recycled PID) simply never reacts: this times out instead of killing it.
 */
export async function stopRunningInstance(dataDir: string, timeoutMs = 60_000): Promise<number | null> {
  const lockPath = join(dataDir, 'serve.lock');
  const pid = Number.parseInt(await readFile(lockPath, 'utf8').catch(() => ''), 10);
  if (!Number.isInteger(pid) || !isProcessAlive(pid)) {
    return null;
  }
  const stopPath = join(dataDir, STOP_REQUEST_FILE);
  await writeFile(stopPath, `${process.pid}\n`, { encoding: 'utf8', mode: 0o600 });
  const deadline = Date.now() + timeoutMs;
  while (await fileExists(lockPath)) {
    if (Date.now() >= deadline) {
      await unlink(stopPath).catch(() => undefined);
      throw new Error(`PID ${pid} still holds ${lockPath} after ${timeoutMs}ms`);
    }
    await delay(STOP_REQUEST_POLL_MS);
  }
  await unlink(stopPath).catch(() => undefined);
  return pid;
}

/**
 * Watches `dataDir` for a takeover's stop request and calls `onRequest` once.
 * Polling rather than `fs.watch` because the file does not exist yet and the
 * request has to be seen on every platform; the timer is unref'd so it never
 * keeps the process alive on its own. A stop file that is already there when
 * watching starts is stale — a takeover removes its own request before
 * returning, so a leftover can only be a crash — and is dropped, not honored.
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
      this.transaction(() => {
        this.db.exec(migration.sql);
        this.db
          .prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)')
          .run(BigInt(migration.version), new Date().toISOString());
      });
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
    const filename = `plasticwan-${timestampForFile()}-${crypto.randomUUID()}.sqlite`;
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

async function loadMigrations(): Promise<Migration[]> {
  const directory = join(import.meta.dirname, '../../store/migrations');
  const names = (await readdir(directory)).filter((name) => /^\d{3}_[a-z0-9_]+\.sql$/.test(name)).sort();
  const migrations: Migration[] = [];
  for (const name of names) {
    const version = Number.parseInt(name.slice(0, 3), 10);
    migrations.push({ version, name, sql: await readFile(join(directory, name), 'utf8') });
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

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined;
    return code === 'EPERM';
  }
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
