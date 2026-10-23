import { afterAll, expect, test } from 'vitest';
import { drizzle } from 'drizzle-orm/better-sqlite3';

import { SqliteStore } from '../src/adapters/local-monolith/database.ts';
import { imageDeliveryState } from '../src/store/image-delivery.ts';
import { buckets, chats, conversations, hostSends, imageAssets, invocations, toolCalls } from '../src/store/schema.ts';
import * as schema from '../src/store/schema.ts';
import { cleanupSchemaDirectories, openStore, rollbackHostSendsRename } from './schema-fixtures.ts';

afterAll(cleanupSchemaDirectories);

// --- Migration 027: image delivery ledger upgrade ---

type ImageSendState = 'success' | 'pending' | 'outcome_unknown' | 'error';

interface ImageDeliveryUpgradeCase {
  readonly name: string;
  readonly state: ImageSendState;
  readonly pictures: number;
  readonly assets: readonly { readonly id: string; readonly offsetMinutes: number }[];
  readonly presetAssetIds?: readonly string[];
  readonly telegramMessageId: bigint | null;
  /** null keeps the pre-027 request_json untouched (it already carried asset_ids). */
  readonly expectedAssetIds: readonly string[] | null;
  readonly delivered: Readonly<Record<string, string>>;
  readonly uncertain: readonly string[];
  readonly unknownAssets: boolean;
}

test('migration 027 infers image delivery asset ids only when the count proves them', async () => {
  // One row per upgrade hazard: a fully proven album, every attempt state, an
  // output that only appeared on a later retry, a missing / mismatched count
  // that must stay unknown, and a record that already carries asset_ids.
  const cases: readonly ImageDeliveryUpgradeCase[] = [
    {
      name: 'success-album',
      state: 'success',
      pictures: 2,
      assets: [
        { id: 'asset-album-a', offsetMinutes: -2 },
        { id: 'asset-album-b', offsetMinutes: -1 },
      ],
      telegramMessageId: 901n,
      expectedAssetIds: ['asset-album-a', 'asset-album-b'],
      delivered: { 'asset-album-a': '901', 'asset-album-b': '901' },
      uncertain: [],
      unknownAssets: false,
    },
    {
      name: 'pending',
      state: 'pending',
      pictures: 1,
      assets: [{ id: 'asset-pending', offsetMinutes: -1 }],
      telegramMessageId: null,
      expectedAssetIds: ['asset-pending'],
      delivered: {},
      uncertain: ['asset-pending'],
      unknownAssets: false,
    },
    {
      name: 'outcome-unknown',
      state: 'outcome_unknown',
      pictures: 1,
      assets: [{ id: 'asset-unknown', offsetMinutes: -1 }],
      telegramMessageId: null,
      expectedAssetIds: ['asset-unknown'],
      delivered: {},
      uncertain: ['asset-unknown'],
      unknownAssets: false,
    },
    {
      name: 'error',
      state: 'error',
      pictures: 1,
      assets: [{ id: 'asset-error', offsetMinutes: -1 }],
      telegramMessageId: null,
      expectedAssetIds: ['asset-error'],
      delivered: {},
      uncertain: [],
      unknownAssets: false,
    },
    {
      name: 'later-retry-asset',
      state: 'success',
      pictures: 1,
      assets: [
        { id: 'asset-early', offsetMinutes: -1 },
        { id: 'asset-late', offsetMinutes: 5 },
      ],
      telegramMessageId: 905n,
      expectedAssetIds: ['asset-early'],
      delivered: { 'asset-early': '905' },
      uncertain: [],
      unknownAssets: false,
    },
    {
      name: 'missing-assets',
      state: 'success',
      pictures: 1,
      assets: [],
      telegramMessageId: 906n,
      expectedAssetIds: [],
      delivered: {},
      uncertain: [],
      unknownAssets: true,
    },
    {
      name: 'count-mismatch',
      state: 'success',
      pictures: 2,
      assets: [{ id: 'asset-half', offsetMinutes: -1 }],
      telegramMessageId: 907n,
      expectedAssetIds: ['asset-half'],
      delivered: {},
      uncertain: [],
      unknownAssets: true,
    },
    {
      name: 'already-recorded',
      state: 'success',
      pictures: 1,
      assets: [],
      presetAssetIds: ['asset-kept'],
      telegramMessageId: 908n,
      expectedAssetIds: null,
      delivered: { 'asset-kept': '908' },
      uncertain: [],
      unknownAssets: false,
    },
  ];

  const base = Date.parse('2026-09-10T10:00:00.000Z');
  const sends = cases.map((scenario, index) => {
    const generationId = `gen-${scenario.name}`;
    const payload: Record<string, unknown> = {
      kind: 'image',
      reply_to_message_id: null,
      generation_id: generationId,
      pictures: scenario.pictures,
      resend: false,
    };
    if (scenario.presetAssetIds !== undefined) {
      payload.asset_ids = [...scenario.presetAssetIds];
    }
    return {
      scenario,
      index,
      generationId,
      payload,
      requestJson: JSON.stringify(payload),
      sendAtMs: base + index * 3_600_000,
    };
  });
  const textRequestJson = JSON.stringify({ kind: 'text', chat_id: 123456789, text: 'plain text send' });
  const createdAt = new Date(base).toISOString();

  const fixture = await openStore();
  let store = fixture.store;
  try {
    store.orm
      .insert(chats)
      .values({
        id: 1n,
        telegramChatId: 123456789n,
        canonicalChatId: 123456789n,
        type: 'private',
        updatedAt: createdAt,
      })
      .run();
    store.orm.insert(conversations).values({ id: 1n, chatId: 1n, createdAt, updatedAt: createdAt }).run();
    store.orm
      .insert(buckets)
      .values({
        id: 1n,
        conversationId: 1n,
        state: 'completed',
        firstReceivedAt: createdAt,
        deadlineAt: createdAt,
        createdAt,
        updatedAt: createdAt,
      })
      .run();
    store.orm
      .insert(invocations)
      .values({
        id: 1n,
        bucketId: 1n,
        conversationId: 1n,
        state: 'completed',
        configHash: 'test',
        promptVersion: 1n,
        createdAt,
      })
      .run();

    for (const item of sends) {
      const toolCallId = 101n + BigInt(item.index);
      const sendAt = new Date(item.sendAtMs).toISOString();
      store.orm
        .insert(toolCalls)
        .values({
          id: toolCallId,
          invocationId: 1n,
          toolCallId: `call-img-${item.index}`,
          toolName: 'send',
          argumentsJson: '{}',
          state: 'success',
          sideEffect: true,
          createdAt: sendAt,
          finishedAt: sendAt,
        })
        .run();
      store.orm
        .insert(hostSends)
        .values({
          id: 201n + BigInt(item.index),
          toolCallId,
          conversationId: 1n,
          kind: 'image',
          requestJson: item.requestJson,
          state: item.scenario.state,
          telegramMessageId: item.scenario.telegramMessageId,
          createdAt: sendAt,
          finishedAt: item.scenario.state === 'pending' ? null : sendAt,
        })
        .run();
      for (const asset of item.scenario.assets) {
        const assetAt = new Date(item.sendAtMs + asset.offsetMinutes * 60_000).toISOString();
        store.orm
          .insert(imageAssets)
          .values({
            id: asset.id,
            name: asset.id,
            mime: 'image/png',
            width: 64,
            height: 64,
            bytes: 128,
            sha256: `sha256-${asset.id}`,
            fileName: `${asset.id}.png`,
            source: 'generation',
            generationId: item.generationId,
            createdAt: assetAt,
            updatedAt: assetAt,
          })
          .run();
      }
    }
    const textIndex = sends.length;
    const textSendAt = new Date(base + textIndex * 3_600_000).toISOString();
    store.orm
      .insert(toolCalls)
      .values({
        id: 101n + BigInt(textIndex),
        invocationId: 1n,
        toolCallId: `call-text-${textIndex}`,
        toolName: 'send',
        argumentsJson: '{}',
        state: 'success',
        sideEffect: true,
        createdAt: textSendAt,
        finishedAt: textSendAt,
      })
      .run();
    store.orm
      .insert(hostSends)
      .values({
        id: 201n + BigInt(textIndex),
        toolCallId: 101n + BigInt(textIndex),
        conversationId: 1n,
        kind: 'text',
        requestJson: textRequestJson,
        state: 'success',
        telegramMessageId: 999n,
        createdAt: textSendAt,
        finishedAt: textSendAt,
      })
      .run();

    // Roll the database back to its pre-027 shape before reopening it: first
    // the ledger goes back to its Telegram name (so 027 still has a table to
    // index) and then its image index goes away.
    rollbackHostSendsRename(store.db);
    store.db.exec(`
      DROP INDEX telegram_sends_image_delivery_idx;
      DELETE FROM schema_migrations WHERE version = 27;
    `);
    expect(
      store.db
        .prepare(
          "SELECT count(*) AS n FROM sqlite_master WHERE type = 'index' AND name = 'host_sends_image_delivery_idx'",
        )
        .get(),
    ).toEqual({ n: 0n });
    store.close();

    // Reopen once applies 027; reopening again proves the upgrade is a no-op.
    store = await SqliteStore.open(fixture.loaded.config);
    const afterFirstOpen = store.db
      .prepare<[], { id: bigint; request_json: string }>('SELECT id, request_json FROM host_sends ORDER BY id')
      .all();
    store.close();
    store = await SqliteStore.open(fixture.loaded.config);
    const rows = store.db
      .prepare<[], { id: bigint; request_json: string }>('SELECT id, request_json FROM host_sends ORDER BY id')
      .all();
    expect(rows).toEqual(afterFirstOpen);

    expect(store.db.prepare('SELECT count(*) AS n FROM schema_migrations WHERE version = 27').get()).toEqual({ n: 1n });
    const indexRow = store.db
      .prepare<[], { sql: string }>(
        "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'host_sends_image_delivery_idx'",
      )
      .get();
    expect(indexRow?.sql).toContain("json_extract(request_json, '$.generation_id')");
    expect(indexRow?.sql).toContain("WHERE kind = 'image'");

    const byId = new Map(rows.map((row) => [row.id, row.request_json]));
    for (const item of sends) {
      const requestJson = byId.get(201n + BigInt(item.index));
      expect(requestJson).toBeDefined();
      if (item.scenario.expectedAssetIds === null) {
        expect(requestJson).toBe(item.requestJson);
        continue;
      }
      const payload = JSON.parse(requestJson ?? '{}') as Record<string, unknown>;
      expect([...(payload.asset_ids as string[])].sort()).toEqual([...item.scenario.expectedAssetIds].sort());
      expect(payload.asset_ids_inferred).toBe(true);
      expect(payload.asset_ids_unknown).toBe(item.scenario.unknownAssets);
      const preserved = { ...payload };
      delete preserved.asset_ids;
      delete preserved.asset_ids_inferred;
      delete preserved.asset_ids_unknown;
      expect(preserved).toEqual(item.payload);
    }
    expect(byId.get(201n + BigInt(sends.length))).toBe(textRequestJson);

    // The upgraded ledger still drives imageDeliveryState, and the partial
    // expression index serves it instead of scanning the sends table.
    const plans: string[] = [];
    const orm = drizzle(store.db, {
      schema,
      logger: {
        logQuery(query, params) {
          const plan = store.db.prepare<unknown[], { detail: string }>(`EXPLAIN QUERY PLAN ${query}`).all(...params);
          plans.push(...plan.map((row) => row.detail));
        },
      },
    });
    for (const item of sends) {
      const delivery = imageDeliveryState(orm, 1n, item.generationId);
      expect(Object.fromEntries(delivery.delivered)).toEqual(item.scenario.delivered);
      expect([...delivery.uncertain].sort()).toEqual([...item.scenario.uncertain].sort());
      expect(delivery.unknownAssets).toBe(item.scenario.unknownAssets);
    }
    expect(
      plans.some((detail) => detail.includes('SEARCH s USING') && detail.includes('host_sends_image_delivery_idx')),
    ).toBe(true);
    expect(plans.some((detail) => /^SCAN s\b/.test(detail))).toBe(false);
    expect(store.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  } finally {
    store.close();
  }
});
