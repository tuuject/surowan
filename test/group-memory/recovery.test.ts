import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from 'vitest';
import { loadConfig } from '../../src/adapters/local-monolith/config/index.ts';
import { SqliteStore } from '../../src/adapters/local-monolith/database.ts';
import { GroupMemoryStore } from '../../src/context/group-memory/store.ts';
import { groupMemoryRuns, modelCalls } from '../../src/store/schema/index.ts';

test.each([1, 2])(
  'restart preserves the dispatched call count when the process exits on attempt %i',
  async (attempt) => {
    const markerDirectory = await mkdtemp(join(tmpdir(), 'surowan-run-recovery-'));
    let fixtureDirectory: string | undefined;
    try {
      const marker = join(markerDirectory, 'fixture-path');
      await promisify(execFile)(
        process.execPath,
        [join(import.meta.dirname, '../fixtures/group-memory-crash.ts'), marker, String(attempt)],
        { timeout: 30_000 },
      );
      fixtureDirectory = resolve(await readFile(marker, 'utf8'));
      expect(dirname(fixtureDirectory)).toBe(resolve(tmpdir()));
      expect(basename(fixtureDirectory)).toMatch(/^surowan-group-memory-/);
      const loaded = await loadConfig(join(fixtureDirectory, 'config.jsonc'));
      const store = await SqliteStore.open(loaded.config);
      try {
        expect(new GroupMemoryStore(store.orm).interruptRuns()).toBe(1);
        expect(store.orm.select().from(modelCalls).all()).toHaveLength(attempt);
        expect(store.orm.select().from(groupMemoryRuns).all()).toEqual([
          expect.objectContaining({
            state: 'error',
            errorCode: 'interrupted',
            firstMessageId: 101n,
            throughMessageId: 101n,
            messages: 1n,
            modelCalls: BigInt(attempt),
          }),
        ]);
      } finally {
        store.close();
      }
    } finally {
      if (
        fixtureDirectory !== undefined &&
        dirname(fixtureDirectory) === resolve(tmpdir()) &&
        basename(fixtureDirectory).startsWith('surowan-group-memory-')
      ) {
        await rm(fixtureDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      }
      await rm(markerDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  },
);
