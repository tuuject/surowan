import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { expect, test } from 'vitest';

// Upgrade must retain attention and its expiry index while extending the CHECK.
test('063 preserves existing attention rows and permits ask triggers', async () => {
  const db = new Database(':memory:');
  const root = join(import.meta.dirname, '../../src/store/migrations');
  try {
    for (const file of (await readdir(root))
      .filter((name) => /^\d{3}_.*\.sql$/.test(name) && Number(name.slice(0, 3)) < 63)
      .sort()) {
      db.exec(await readFile(join(root, file), 'utf8'));
    }
    db.exec(
      "INSERT INTO chats (id, telegram_chat_id, canonical_chat_id, type, updated_at) VALUES (1, -1, -1, 'group', '2026-01-01'); INSERT INTO conversations (id, chat_id, message_thread_id, created_at, updated_at) VALUES (1, 1, 0, '2026-01-01', '2026-01-01'); INSERT INTO conversation_attention VALUES (1, '2026-01-02', '2026-01-01', 'mention', 10, '2026-01-01');",
    );
    await expect(
      readFile(join(root, '063_ask_participation.sql'), 'utf8').then((sql) => db.exec(sql)),
    ).resolves.toBeDefined();
    expect(db.prepare('SELECT trigger_kind, trigger_telegram_message_id FROM conversation_attention').get()).toEqual({
      trigger_kind: 'mention',
      trigger_telegram_message_id: 10,
    });
    db.exec("UPDATE conversation_attention SET trigger_kind = 'ask'");
    expect(db.prepare('SELECT trigger_kind FROM conversation_attention').get()).toEqual({ trigger_kind: 'ask' });
    expect(() => db.exec("UPDATE conversation_attention SET trigger_kind = 'invalid'")).toThrow(/CHECK/);
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name = 'conversation_attention_expiry_idx'").get(),
    ).toBeDefined();
  } finally {
    db.close();
  }
});
