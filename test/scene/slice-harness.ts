import { expect } from 'vitest';
import type { SqliteStore } from '../../src/adapters/local-monolith/database.ts';
import { SceneSliceError } from '../../src/context/scene/rows.ts';
import { buildSceneContext, type SceneContext, type SceneContextOptions } from '../../src/context/scene/index.ts';
import { INVOCATION, SEND, type Fixture } from './slice-fixtures.ts';

export interface SliceOptions {
  readonly beforeSendId?: bigint;
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
  readonly toolDefinitionCharacters?: number;
  readonly supportsImages?: boolean;
}

export function buildSlice(fixture: Fixture, options: SliceOptions = {}): SceneContext {
  const call: SceneContextOptions = {
    contextWindow: options.contextWindow ?? 200_000,
    maxOutputTokens: options.maxOutputTokens ?? 32_768,
    toolDefinitionCharacters: options.toolDefinitionCharacters ?? 0,
    beforeSendId: options.beforeSendId ?? SEND,
    ...(options.supportsImages === undefined ? {} : { supportsImages: options.supportsImages }),
  };
  return buildSceneContext(fixture.store, fixture.config, INVOCATION, call);
}

export function expectSliceError(action: () => unknown, code: string): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(SceneSliceError);
    expect((error as SceneSliceError).code).toBe(code);
    return;
  }
  throw new Error(`expected a SceneSliceError with code ${code}`);
}

/** Every table and all of its rows, for before/after comparison. */
export function databaseRows(store: SqliteStore): Record<string, unknown[]> {
  const names = store.db
    .prepare<[], { name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all();
  return Object.fromEntries(
    names.map(({ name }) => [name, store.db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all()]),
  );
}
