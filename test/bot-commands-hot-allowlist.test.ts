import { afterAll, describe, expect, test } from 'vitest';
import { FIXED_NOW, cleanupDirectories, commandUpdate, setup, textUpdate } from './bot-commands-fixtures.ts';

afterAll(cleanupDirectories);

describe('hot allowlist adoption', () => {
  test('a chat added by a publish ingests without reconstructing the ingestion', async () => {
    const { store, configStore, ingestion } = await setup();
    const before = ingestion.ingest(textUpdate(1, 10, 'first', 987654321), FIXED_NOW);
    expect(before.messageId).toBeUndefined();
    const snapshot = configStore.current();
    const next = structuredClone(snapshot.config);
    next.telegram.chats.push({ id: 987654321, instructions: '' });
    configStore.publish({
      config: next,
      hash: 'published',
      models: snapshot.models,
      visionModel: snapshot.visionModel,
    });
    const after = ingestion.ingest(textUpdate(2, 11, 'second', 987654321), FIXED_NOW);
    expect(after.messageId).toBeDefined();
    store.close();
  });

  test('an allowlisted chat returns to the normal command path after the add', async () => {
    const { store, configStore, ingestion } = await setup();
    expect(ingestion.ingest(commandUpdate(1, 10, '/status', 987654321), FIXED_NOW).command).toBeUndefined();
    const snapshot = configStore.current();
    const next = structuredClone(snapshot.config);
    next.telegram.chats.push({ id: 987654321, instructions: '' });
    configStore.publish({
      config: next,
      hash: 'published',
      models: snapshot.models,
      visionModel: snapshot.visionModel,
    });
    expect(ingestion.ingest(commandUpdate(2, 11, '/status', 987654321), FIXED_NOW).command).toEqual({
      name: 'status',
      messageId: 11n,
    });
    store.close();
  });
});
