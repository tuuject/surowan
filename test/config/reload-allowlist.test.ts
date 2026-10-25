import { expect, test } from 'vitest';
import { loadConfig } from '../../src/adapters/local-monolith/config/index.ts';
import { ADMIN, logEvents, groupUpdate, setup } from './reload-fixtures.ts';

test('addChat appends a bare allowlist entry and hot-applies it', async () => {
  const newChatId = -100999;
  const fixture = await setup();
  try {
    const result = await fixture.reloader.addChat(newChatId);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.message);
    }
    expect(result.applied).toEqual([`telegram.chats[${newChatId}]`]);
    expect(result.restartRequired).toEqual([]);
    const written = await loadConfig(fixture.configPath);
    expect(written.fileConfig.telegram?.chats.at(-1)).toEqual({ id: newChatId });
    const active = fixture.configStore.current();
    expect(active.config.telegram.chats.at(-1)?.id).toBe(newChatId);
    expect(active.generation).toBe(2);
    expect(logEvents('config_reloaded').at(-1)?.applied).toContain(`telegram.chats[${newChatId}]`);
    // Hot adoption is observable in the ingestion allowlist without a restart.
    const ingested = fixture.ingestion.ingest(groupUpdate(1, 10, newChatId));
    expect(ingested.messageId).toBeDefined();
  } finally {
    fixture.store.close();
  }
});

test('addChat adopts a file that already names the chat instead of writing again', async () => {
  const newChatId = -100999;
  const fixture = await setup();
  try {
    await fixture.patch((config) => {
      config.telegram.chats.push({ id: newChatId });
    });
    const before = fixture.configStore.current();
    expect(before.config.telegram.chats.some((chat) => chat.id === newChatId)).toBe(false);
    const result = await fixture.reloader.addChat(newChatId);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.message);
    }
    expect(result.applied).toEqual([`telegram.chats[${newChatId}]`]);
    expect(fixture.configStore.current().config.telegram.chats.some((chat) => chat.id === newChatId)).toBe(true);
  } finally {
    fixture.store.close();
  }
});

test('addChat rejects invalid IDs without touching file or active state', async () => {
  const fixture = await setup();
  try {
    const before = fixture.configStore.current();
    const original = await fixture.readText();
    for (const invalid of [0, 1.5]) {
      const result = await fixture.reloader.addChat(invalid);
      expect(result).toMatchObject({ ok: false, code: 'config_invalid', fileWritten: false });
    }
    expect(await fixture.readText()).toBe(original);
    expect(fixture.configStore.current()).toBe(before);
  } finally {
    fixture.store.close();
  }
});

test('/allowlist allowlists the chat it is sent from and the next message ingests', async () => {
  const newChatId = -100999;
  const fixture = await setup();
  try {
    const reply = await fixture.commands.run({ name: 'allowlist' }, BigInt(newChatId), ADMIN);
    expect(reply).toBe('已将本群加入白名单，配置已立即生效。');
    expect(fixture.configStore.current().config.telegram.chats.some((chat) => chat.id === newChatId)).toBe(true);
    expect(await loadConfig(fixture.configPath).then((loaded) => loaded.fileConfig.telegram?.chats.at(-1))).toEqual({
      id: newChatId,
    });
    const ingested = fixture.ingestion.ingest(groupUpdate(1, 10, newChatId));
    expect(ingested.messageId).toBeDefined();
    const again = await fixture.commands.run({ name: 'allowlist' }, BigInt(newChatId), ADMIN);
    expect(again).toBe('本群已在白名单中。');
  } finally {
    fixture.store.close();
  }
});
