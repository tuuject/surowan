import { mkdir, readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, expect, test } from 'vitest';
import { imageSchema } from '@surowan/image-service';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { loadConfig } from '../../src/adapters/local-monolith/config/index.ts';
import { SqliteStore } from '../../src/adapters/local-monolith/database.ts';
import { writeTestConfig } from '../helpers.ts';
import { cleanupSchemaDirectories, makeSchemaDirectory } from './fixtures.ts';

afterAll(cleanupSchemaDirectories);

const MIGRATIONS = join(import.meta.dirname, '..', '..', 'src', 'store', 'migrations');

/**
 * 065 adds the image-asset search metadata (`keywords`) and the agent-visibility
 * flag. Every existing row keeps working untouched and reads back private with
 * no keywords — promotion is an admin action, never a migration default — and
 * rows created after the upgrade default the same way.
 */
test('migration 065 leaves existing image assets private and defaults new rows private', async () => {
  const directory = await makeSchemaDirectory();
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(directory, configPath);
  const loaded = await loadConfig(configPath);
  await mkdir(dirname(loaded.config.paths.database), { recursive: true });

  const legacy = new Database(loaded.config.paths.database);
  legacy.defaultSafeIntegers(true);
  legacy.pragma('foreign_keys = ON');
  for (const name of (await readdir(MIGRATIONS))
    .filter((file) => /^\d{3}_[a-z0-9_]+\.sql$/.test(file) && Number(file.slice(0, 3)) < 65)
    .sort()) {
    legacy.exec(await readFile(join(MIGRATIONS, name), 'utf8'));
    legacy
      .prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)')
      .run(Number(name.slice(0, 3)), '2026-01-01T00:00:00.000Z');
  }
  legacy.exec(`
    INSERT INTO image_assets (id, name, mime, width, height, bytes, sha256, file_name, description, category,
        source, created_at, updated_at)
      VALUES ('aaaaaaaa-1111-4111-8111-111111111111', '存量参考图', 'image/png', 4, 4, 12, 'x', 'a.png', '', '',
        'upload', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  `);
  legacy.close();

  const store = await SqliteStore.open(loaded.config);
  try {
    // The upgrade added the columns and kept the stored row private and untagged.
    expect(
      store.db
        .prepare<[], { name: string; keywords: string; agent_visible: bigint }>(
          'SELECT name, keywords, agent_visible FROM image_assets',
        )
        .all(),
    ).toEqual([{ name: '存量参考图', keywords: '', agent_visible: 0n }]);

    // The image core reads and writes the new columns over the borrowed handle.
    const db = drizzle(store.db, { schema: imageSchema });
    expect(db.select().from(imageSchema.images).all()[0]?.agentVisible).toBe(false);
    db.update(imageSchema.images)
      .set({ keywords: '自设, 三视图', agentVisible: true })
      .where(eq(imageSchema.images.id, 'aaaaaaaa-1111-4111-8111-111111111111'))
      .run();
    expect(db.select().from(imageSchema.images).all()[0]?.agentVisible).toBe(true);
    expect(store.db.prepare<[], { keywords: string }>('SELECT keywords FROM image_assets').get()?.keywords).toBe(
      '自设, 三视图',
    );

    // A row created after the upgrade defaults private with no keywords.
    const inserted = db
      .insert(imageSchema.images)
      .values({
        id: 'bbbbbbbb-2222-4222-8222-222222222222',
        name: '新图',
        mime: 'image/png',
        width: 4,
        height: 4,
        bytes: 12,
        sha256: 'y',
        fileName: 'b.png',
        description: '',
        category: '',
        keywords: '',
        agentVisible: false,
        source: 'upload',
        generationId: null,
        outputIndex: null,
        createdAt: '2026-01-02T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
        deletedAt: null,
      })
      .run();
    expect(inserted.changes).toBe(1);
    expect(
      store.db
        .prepare<[], { agent_visible: bigint }>(
          "SELECT agent_visible FROM image_assets WHERE id = 'bbbbbbbb-2222-4222-8222-222222222222'",
        )
        .get()?.agent_visible,
    ).toBe(0n);
  } finally {
    store.close();
  }
});
