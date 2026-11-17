import { mkdir, mkdtemp, readFile, readdir, rm, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Update } from 'grammy/types';
import { afterAll, expect, test } from 'vitest';
import { TelegramIngestion } from '../src/ingress/telegram-ingestion/index.ts';
import { BucketScheduler } from '../src/orchestration/scheduler/index.ts';
import { loadConfig } from '../src/adapters/local-monolith/config/index.ts';
import {
  backupDatabase,
  ServeLock,
  SqliteStore,
  stopRunningInstance,
  watchStopRequests,
} from '../src/adapters/local-monolith/database.ts';
import { purgeExpiredData } from '../src/store/store.ts';
import { pathExists, sleep, testConfigJsonc, testConfigStore, writeTestConfig } from './helpers.ts';

const directories: string[] = [];

afterAll(async () => {
  // Cleanup must not fail the suite: on Windows an open SQLite handle can make
  // `rm` lose the race, and a leaked temp directory is acceptable here.
  await Promise.all(
    directories.map((directory) =>
      rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }).catch(() => undefined),
    ),
  );
});

test('retention prunes old audit rows, keeps chat history, and backup keeps seven consistent copies', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'surowan-operations-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(directory, configPath);
  const loaded = await loadConfig(configPath);
  const configStore = await testConfigStore(loaded);
  const store = await SqliteStore.open(loaded.config);
  const ingestion = new TelegramIngestion(store, configStore, { id: 999 });
  const scheduler = new BucketScheduler(store, configStore, async () => ({
    state: 'completed',
    reason: 'done',
  }));
  const oldReceived = new Date('2026-01-01T00:00:00.000Z');
  ingestion.ingest(textUpdate(1, 10, 'old private text'), oldReceived);
  const [oldInvocation] = scheduler.processDue(new Date(oldReceived.getTime() + 15_000));
  if (oldInvocation === undefined) {
    throw new Error('Expected old invocation');
  }
  store.db
    .prepare("UPDATE invocations SET state = 'completed', finished_at = ? WHERE id = ?")
    .run(oldReceived.toISOString(), oldInvocation);
  store.db
    .prepare(
      "UPDATE buckets SET state = 'completed', finished_at = ?, updated_at = ? WHERE id = (SELECT bucket_id FROM invocations WHERE id = ?)",
    )
    .run(oldReceived.toISOString(), oldReceived.toISOString(), oldInvocation);
  store.db
    .prepare(
      "INSERT INTO tool_calls(invocation_id, tool_call_id, tool_name, arguments_json, result_text, state, side_effect, created_at, finished_at) VALUES (?, 'old-tool', 'probe', '{\"secret\":true}', 'old result', 'success', 0, ?, ?)",
    )
    .run(oldInvocation, oldReceived.toISOString(), oldReceived.toISOString());

  const newReceived = new Date('2026-02-15T00:00:00.000Z');
  ingestion.ingest(textUpdate(2, 11, 'new private text'), newReceived);
  const [newInvocation] = scheduler.processDue(new Date(newReceived.getTime() + 15_000));
  if (newInvocation === undefined) {
    throw new Error('Expected new invocation');
  }
  const historyBefore = store.db
    .prepare<[bigint], { snapshot_json: string }>(
      "SELECT snapshot_json FROM invocation_messages WHERE invocation_id = ? AND section = 'history'",
    )
    .get(newInvocation);
  expect(historyBefore?.snapshot_json).toContain('old private text');

  purgeExpiredData(store.orm, loaded.config, newReceived);
  expect(
    store.db
      .prepare<[bigint], { count: bigint }>('SELECT COUNT(*) AS count FROM invocations WHERE id = ?')
      .get(oldInvocation)?.count,
  ).toBe(0n);
  expect(
    store.db
      .prepare<[], { count: bigint }>("SELECT COUNT(*) AS count FROM tool_calls WHERE tool_call_id = 'old-tool'")
      .get()?.count,
  ).toBe(0n);
  expect(
    store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM telegram_updates WHERE update_id = 1').get()
      ?.count,
  ).toBe(1n);
  const kept = store.db
    .prepare<[], { text: string | null; raw: string }>(
      'SELECT r.text, r.raw_fragment_json AS raw FROM message_revisions r JOIN messages m ON m.id = r.message_id WHERE m.telegram_message_id = 10',
    )
    .get();
  expect(kept?.text).toContain('old private text');
  expect(kept?.raw).not.toBe('{}');
  const retainedSnapshot = store.db
    .prepare<[bigint], { snapshot_json: string }>(
      "SELECT snapshot_json FROM invocation_messages WHERE invocation_id = ? AND section = 'history'",
    )
    .get(newInvocation);
  expect(retainedSnapshot?.snapshot_json).toContain('old private text');
  store.close();

  await mkdir(loaded.config.paths.backups, { recursive: true });
  await Promise.all(
    Array.from({ length: 8 }, async (_, index) => {
      const path = join(loaded.config.paths.backups, `old-${index}.sqlite`);
      await writeFile(path, 'old');
      await utimes(path, new Date(0), new Date(index * 1_000));
    }),
  );
  // An image asset directory must ride along beside the SQLite snapshot, so the
  // restore path can rebuild both stores from one backup point.
  const imageDir = join(loaded.config.data_dir, 'images');
  await mkdir(join(imageDir, 'assets'), { recursive: true, mode: 0o700 });
  await writeFile(join(imageDir, 'assets', 'ref-1.png'), 'png-bytes');
  const backupPath = await backupDatabase(loaded.config);
  expect(await pathExists(backupPath)).toBe(true);
  const imageBackupDir = backupPath.replace(/\.sqlite$/, '.images');
  expect(await pathExists(join(imageBackupDir, 'assets', 'ref-1.png'))).toBe(true);
  const backups = (await readdir(loaded.config.paths.backups)).filter((name) => name.endsWith('.sqlite'));
  expect(backups).toHaveLength(7);
  const backup = new DatabaseSync(backupPath, { readOnly: true });
  const integrity = backup.prepare('PRAGMA integrity_check').get() as { integrity_check: string } | undefined;
  expect(integrity?.integrity_check).toBe('ok');
  backup.close();
});

test('backup rotation drops the image snapshot of every rotated-away backup', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'surowan-operations-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(
    directory,
    configPath,
    testConfigJsonc(directory, (config) => {
      config.retention.backup_copies = 2;
    }),
  );
  const { config } = await loadConfig(configPath);
  const store = await SqliteStore.open(config);
  store.close();
  const imageDir = join(config.data_dir, 'images');
  await mkdir(join(imageDir, 'assets'), { recursive: true, mode: 0o700 });
  await writeFile(join(imageDir, 'assets', 'ref-1.png'), 'png-bytes');

  const snapshots: string[] = [];
  for (let index = 0; index < config.retention.backup_copies + 2; index += 1) {
    const path = await backupDatabase(config);
    // Forced mtimes, not the filesystem clock, decide which copies survive.
    await utimes(path, new Date(index * 1_000), new Date(index * 1_000));
    snapshots.push(path);
  }
  // `snapshotImageDirectory` names the sibling `<backup>.images`; assert the
  // real names so a rename in the product breaks this test too.
  const kept = snapshots.slice(-config.retention.backup_copies);
  const rotated = snapshots.slice(0, -config.retention.backup_copies);
  for (const path of kept) {
    expect(await pathExists(path)).toBe(true);
    expect(await pathExists(path.replace(/\.sqlite$/, '.images'))).toBe(true);
  }
  for (const path of rotated) {
    expect(await pathExists(path)).toBe(false);
    expect(await pathExists(path.replace(/\.sqlite$/, '.images'))).toBe(false);
  }
});

test.each([7, 1])(
  'a pre-migration backup rotates only within pre-migration copies (backup_copies=%i)',
  async (backupCopies) => {
    const directory = await mkdtemp(join(tmpdir(), 'surowan-operations-'));
    directories.push(directory);
    const configPath = join(directory, 'config.jsonc');
    await writeTestConfig(
      directory,
      configPath,
      testConfigJsonc(directory, (config) => {
        config.retention.backup_copies = backupCopies;
      }),
    );
    const { config } = await loadConfig(configPath);
    await mkdir(config.paths.backups, { recursive: true });
    // Older than every pre-migration copy: real `surowan-*.sqlite` backups with
    // their `.images` snapshots. An automatic step at upgrade time must never
    // delete a complete backup.
    const surowan: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const path = join(config.paths.backups, `surowan-2020-01-01T00-00-0${index}-old.sqlite`);
      await writeFile(path, 'backup');
      await utimes(path, new Date(index * 1_000), new Date(index * 1_000));
      const images = join(config.paths.backups, `surowan-2020-01-01T00-00-0${index}-old.images`);
      await mkdir(images, { recursive: true });
      await writeFile(join(images, 'marker'), 'x');
      surowan.push(path);
    }
    for (let index = 0; index < backupCopies + 2; index += 1) {
      const path = join(
        config.paths.backups,
        `pre-migration-2020-02-02T00-00-${String(index).padStart(2, '0')}.sqlite`,
      );
      await writeFile(path, 'copy');
      await utimes(path, new Date((10 + index) * 1_000), new Date((10 + index) * 1_000));
    }

    // A database with every migration but the newest applied by hand leaves one
    // pending migration: reopening writes a pre-migration backup for it.
    let store = await SqliteStore.open(config, false);
    const migrationDirectory = join(import.meta.dirname, '../src/store/migrations');
    const names = (await readdir(migrationDirectory)).filter((name) => /^\d{3}_.*\.sql$/.test(name)).sort();
    expect(names.length).toBeGreaterThan(0);
    for (const name of names.slice(0, -1)) {
      const text = await readFile(join(migrationDirectory, name), 'utf8');
      store.db.transaction(() => {
        store.db.exec(text);
        store.db
          .prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)')
          .run(BigInt(Number(name.slice(0, 3))), new Date().toISOString());
      })();
    }
    store.close();
    store = await SqliteStore.open(config);
    store.close();

    // Only pre-migration copies rotate among themselves: the fresh one is the
    // newest and survives; every complete backup and its snapshot is untouched.
    const preMigration = (await readdir(config.paths.backups)).filter((name) =>
      /^pre-migration-.*\.sqlite$/.test(name),
    );
    expect(preMigration).toHaveLength(backupCopies);
    expect(preMigration.some((name) => !name.startsWith('pre-migration-2020-'))).toBe(true);
    for (const path of surowan) {
      expect(await pathExists(path)).toBe(true);
      expect(await pathExists(path.replace(/\.sqlite$/, '.images'))).toBe(true);
    }
  },
);

test('takeover stops the instance holding the lock and leaves no stop request behind', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'surowan-takeover-'));
  directories.push(directory);
  const dataDir = join(directory, 'data');
  const lockPath = join(dataDir, 'serve.lock');
  const stopPath = join(dataDir, 'serve.stop');

  // Nothing to stop.
  expect(await stopRunningInstance(dataDir, 1_000)).toBeNull();

  // A live holder: the lock disappears only because the watcher saw the request.
  const lock = await ServeLock.acquire(dataDir);
  let requested = false;
  const stopWatching = watchStopRequests(dataDir, () => {
    requested = true;
    void lock.release();
  });
  expect(await stopRunningInstance(dataDir, 5_000)).toEqual({ pid: process.pid });
  expect(requested).toBe(true);
  expect(await pathExists(lockPath)).toBe(false);
  expect(await pathExists(stopPath)).toBe(false);
  stopWatching();
});

test('takeover stops a holder that has no PID file and is still starting its watcher', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'surowan-takeover-'));
  directories.push(directory);
  const dataDir = join(directory, 'data');
  const stopPath = join(dataDir, 'serve.stop');

  // A holder caught between taking the mutex and publishing its PID: the
  // takeover waits on the mutex instead of refusing.
  const lock = await ServeLock.acquire(dataDir);
  await unlink(join(dataDir, 'serve.lock'));
  const stopping = stopRunningInstance(dataDir, 5_000);
  await sleep(500);
  expect(await pathExists(stopPath)).toBe(true);

  // The holder's watcher starts late and sweeps the request away as stale; the
  // takeover publishes it again and the holder still stops.
  let requested = false;
  const stopWatching = watchStopRequests(dataDir, () => {
    requested = true;
    void lock.release();
  });
  expect(await stopping).toEqual({ pid: null });
  expect(requested).toBe(true);
  expect(await pathExists(stopPath)).toBe(false);
  stopWatching();
});

test('a PID file left behind by a dead instance does not block the next one', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'surowan-takeover-'));
  directories.push(directory);
  const dataDir = join(directory, 'data');
  const lockPath = join(dataDir, 'serve.lock');
  const stopPath = join(dataDir, 'serve.stop');
  await mkdir(dataDir, { recursive: true });

  // PID 1 is alive in every fresh container, which is why liveness is decided by
  // the mutex and not by the recorded PID: a restarted container always finds
  // its own PID 1 in the file of the instance it just replaced.
  await writeFile(lockPath, '1\n');
  expect(await stopRunningInstance(dataDir, 1_000)).toBeNull();
  expect(await pathExists(stopPath)).toBe(false);
  // Left alone outside the mutex: the next acquisition overwrites it.
  expect(await readFile(lockPath, 'utf8')).toBe('1\n');

  const lock = await ServeLock.acquire(dataDir);
  expect(await readFile(lockPath, 'utf8')).toBe(`${process.pid}\n`);
  await lock.release();
  expect(await pathExists(lockPath)).toBe(false);
});

test('a failed PID file write does not keep the mutex held', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'surowan-takeover-'));
  directories.push(directory);
  const dataDir = join(directory, 'data');
  const lockPath = join(dataDir, 'serve.lock');
  // A directory where the PID file belongs makes the write fail after the
  // mutex is taken.
  await mkdir(lockPath, { recursive: true });
  await expect(ServeLock.acquire(dataDir)).rejects.toMatchObject({ code: 'EISDIR' });
  expect(await stopRunningInstance(dataDir, 1_000)).toBeNull();

  await rm(lockPath, { recursive: true });
  const lock = await ServeLock.acquire(dataDir);
  await lock.release();
});

test('the lock refuses a second instance until it is released', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'surowan-takeover-'));
  directories.push(directory);
  const dataDir = join(directory, 'data');
  const lock = await ServeLock.acquire(dataDir);
  await expect(ServeLock.acquire(dataDir)).rejects.toThrow(
    new RegExp(`Another serve process holds .*serve\\.lock with PID ${process.pid}`),
  );
  await lock.release();
  const second = await ServeLock.acquire(dataDir);
  await second.release();
});

test('takeover gives up on an instance that ignores the request', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'surowan-takeover-'));
  directories.push(directory);
  const dataDir = join(directory, 'data');
  const lock = await ServeLock.acquire(dataDir);
  await expect(stopRunningInstance(dataDir, 500)).rejects.toThrow(/still holds/);
  expect(await pathExists(join(dataDir, 'serve.stop'))).toBe(false);
  await lock.release();
});

test('a stale stop request does not stop the instance that starts next', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'surowan-takeover-'));
  directories.push(directory);
  const dataDir = join(directory, 'data');
  await mkdir(dataDir, { recursive: true });
  await writeFile(join(dataDir, 'serve.stop'), '4242\n');
  let requested = false;
  const stopWatching = watchStopRequests(dataDir, () => {
    requested = true;
  });
  await sleep(600);
  expect(requested).toBe(false);
  expect(await pathExists(join(dataDir, 'serve.stop'))).toBe(false);
  stopWatching();
});

function textUpdate(updateId: number, messageId: number, text: string): Update {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      date: 1_700_000_000 + messageId,
      chat: { id: 123456789, type: 'private', first_name: 'Owner' },
      from: { id: 42, is_bot: false, first_name: 'Alice' },
      text,
    },
  };
}
