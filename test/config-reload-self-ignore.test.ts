import { expect, test } from 'vitest';
import type { CommandSender } from '../src/orchestration/bot-commands.ts';
import { loadConfig } from '../src/adapters/local-monolith/config.ts';
import { CHAT_ID, ADMIN, logEvents, textUpdate, groupUpdate, setup } from './config-reload-fixtures.ts';

test('non-admin members can persist self-ignore, stay audited, and opt back in without a restart', async () => {
  const fixture = await setup({
    transform: (config) => {
      config.telegram.admins = [];
    },
  });
  let updateId = 1;
  const ingest = (text: string, command = false) => {
    const id = updateId++;
    const update = textUpdate(id, id + 10, text);
    if (command) {
      update.message!.entities = [{ type: 'bot_command', offset: 0, length: text.split(' ')[0]!.length }];
    }
    return fixture.ingestion.ingest(update);
  };
  try {
    const original = ingest('before opting out');
    expect(original.messageId).toBeDefined();
    const ignored = ingest('/ignoreme 99', true);
    expect(ignored.command).toMatchObject({ name: 'ignoreme' });
    expect(ignored.messageId).toBeUndefined();
    const reply = await fixture.commands.run(ignored.command!, BigInt(CHAT_ID), ADMIN);
    expect(reply).toContain('/unignoreme');
    expect(fixture.configStore.current().config.telegram.chats[0]?.ignored_user_ids).toEqual([42]);
    expect((await loadConfig(fixture.configPath)).config.telegram.chats[0]?.ignored_user_ids).toEqual([42]);
    expect(logEvents('config_reloaded').at(-1)).toMatchObject({
      applied: `telegram.chats[${CHAT_ID}].ignored_user_ids`,
      restart_required: '',
    });
    const generation = fixture.configStore.current().generation;
    const written = await fixture.readText();
    const repeated = ingest('/ignoreme', true);
    await fixture.commands.run(repeated.command!, BigInt(CHAT_ID), ADMIN);
    expect(await fixture.readText()).toBe(written);
    expect(fixture.configStore.current().generation).toBe(generation);

    expect(ingest('ignored message')).toEqual({});
    expect(ingest('/status', true)).toEqual({});
    expect(ingest('/unignoreme@other_bot', true)).toEqual({});
    const edited = textUpdate(updateId++, 100, '/unignoreme');
    edited.message!.entities = [{ type: 'bot_command', offset: 0, length: 11 }];
    expect(
      fixture.ingestion.ingest({
        update_id: edited.update_id,
        edited_message: { ...edited.message!, edit_date: 1_700_000_100 },
      }),
    ).toEqual({});
    const catchUp = textUpdate(updateId++, 101, '/unignoreme');
    catchUp.message!.entities = [{ type: 'bot_command', offset: 0, length: 11 }];
    expect(fixture.ingestion.ingestCatchUp(catchUp)).toEqual({});

    const restored = ingest('/unignoreme', true);
    expect(restored.command).toMatchObject({ name: 'unignoreme' });
    expect(await fixture.commands.run(restored.command!, BigInt(CHAT_ID), ADMIN)).toContain('已恢复接收');
    expect(fixture.configStore.current().config.telegram.chats[0]?.ignored_user_ids).toEqual([]);
    expect((await loadConfig(fixture.configPath)).config.telegram.chats[0]?.ignored_user_ids).toEqual([]);
    const restoredGeneration = fixture.configStore.current().generation;
    const restoredText = await fixture.readText();
    await fixture.commands.run(ingest('/unignoreme', true).command!, BigInt(CHAT_ID), ADMIN);
    expect(await fixture.readText()).toBe(restoredText);
    expect(fixture.configStore.current().generation).toBe(restoredGeneration);
    expect(ingest('after opting back in').bucketId).toBeDefined();

    expect(fixture.store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM messages').get()?.count).toBe(
      2n,
    );
    expect(
      fixture.store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM message_revisions').get()?.count,
    ).toBe(2n);
    expect(
      fixture.store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM bucket_messages').get()?.count,
    ).toBe(2n);
    expect(
      fixture.store.db
        .prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM telegram_updates WHERE allowed = 1')
        .get()?.count,
    ).toBe(BigInt(updateId - 1));
    expect(
      fixture.store.db
        .prepare<[bigint], { id: bigint }>('SELECT id FROM messages WHERE id = ?')
        .get(original.messageId!),
    ).toBeDefined();
  } finally {
    fixture.store.close();
  }
});

test('self-ignore updates merge concurrent members by file Chat ID and preserve other Chats', async () => {
  const otherChat = -100999;
  const bob: CommandSender = { id: 99n, name: 'Bob', username: null };
  const fixture = await setup({
    transform: (config) => {
      config.telegram.chats[0]!.ignored_user_ids = [7];
      config.telegram.chats.push({ id: otherChat, ignored_user_ids: [8] });
    },
  });
  try {
    await fixture.patch((config) => {
      config.telegram.chats.reverse();
    });
    await Promise.all([
      fixture.commands.run({ name: 'ignoreme' }, BigInt(CHAT_ID), ADMIN),
      fixture.commands.run({ name: 'ignoreme' }, BigInt(CHAT_ID), bob),
    ]);
    const active = fixture.configStore.current().config;
    const disk = (await loadConfig(fixture.configPath)).config;
    expect(disk.telegram.chats.map((chat) => chat.id)).toEqual([otherChat, CHAT_ID]);
    expect(disk.telegram.chats.find((chat) => chat.id === CHAT_ID)?.ignored_user_ids).toEqual([7, 42, 99]);
    expect(active.telegram.chats.find((chat) => chat.id === CHAT_ID)?.ignored_user_ids).toEqual([7, 42, 99]);
    expect(disk.telegram.chats.find((chat) => chat.id === otherChat)?.ignored_user_ids).toEqual([8]);
    expect(fixture.ingestion.ingest(groupUpdate(1, 10, otherChat, 42)).bucketId).toBeDefined();
    expect(fixture.ingestion.ingest(groupUpdate(2, 11, CHAT_ID, 42))).toEqual({});
    await Promise.all([
      fixture.commands.run({ name: 'unignoreme' }, BigInt(CHAT_ID), ADMIN),
      fixture.commands.run({ name: 'unignoreme' }, BigInt(CHAT_ID), bob),
    ]);
    expect(
      (await loadConfig(fixture.configPath)).config.telegram.chats.find((chat) => chat.id === CHAT_ID)
        ?.ignored_user_ids,
    ).toEqual([7]);
    expect(
      fixture.configStore.current().config.telegram.chats.find((chat) => chat.id === CHAT_ID)?.ignored_user_ids,
    ).toEqual([7]);
  } finally {
    fixture.store.close();
  }
});

test('self-ignore in a migrated Forum Chat uses the configured ID and affects all topics', async () => {
  const oldChat = -999;
  const newChat = -100999;
  const fixture = await setup({
    transform: (config) => {
      config.telegram.chats = [{ id: oldChat }];
    },
  });
  try {
    const migration = groupUpdate(1, 10, newChat);
    migration.message = { ...migration.message!, migrate_from_chat_id: oldChat };
    fixture.ingestion.ingest(migration);
    expect(await fixture.commands.run({ name: 'ignoreme', threadId: 8n }, BigInt(newChat), ADMIN)).toContain('已忽略');
    expect((await loadConfig(fixture.configPath)).fileConfig.telegram?.chats).toEqual([
      { id: oldChat, ignored_user_ids: [42] },
    ]);
    const topic = groupUpdate(2, 11, newChat);
    topic.message = {
      ...topic.message!,
      chat: { id: newChat, type: 'supergroup', title: 'Forum', is_forum: true },
      is_topic_message: true,
      message_thread_id: 9,
    };
    expect(fixture.ingestion.ingest(topic)).toEqual({});
    topic.update_id = 3;
    topic.message.text = '/unignoreme';
    topic.message.entities = [{ type: 'bot_command', offset: 0, length: 11 }];
    const command = fixture.ingestion.ingest(topic).command;
    expect(command).toMatchObject({ name: 'unignoreme', threadId: 9n });
    await fixture.commands.run(command!, BigInt(newChat), ADMIN);
    expect(fixture.ingestion.ingest(groupUpdate(4, 12, newChat)).bucketId).toBeDefined();
  } finally {
    fixture.store.close();
  }
});

test('file reloads immediately update ignored users for realtime and catch-up ingestion', async () => {
  const fixture = await setup();
  try {
    await fixture.patch((config) => {
      config.telegram.chats[0]!.ignored_user_ids = [42];
    });
    expect(await fixture.reloader.reloadFromFile()).toMatchObject({
      ok: true,
      applied: [`telegram.chats[${CHAT_ID}].ignored_user_ids`],
      restartRequired: [],
    });
    expect(fixture.ingestion.ingest(textUpdate(1, 10, 'ignored realtime'))).toEqual({});
    expect(fixture.ingestion.ingestCatchUp(textUpdate(2, 11, 'ignored catch-up'))).toEqual({});
    await fixture.patch((config) => {
      delete config.telegram.chats[0]!.ignored_user_ids;
    });
    expect(await fixture.reloader.reloadFromFile()).toMatchObject({
      ok: true,
      applied: [`telegram.chats[${CHAT_ID}].ignored_user_ids`],
      restartRequired: [],
    });
    expect(fixture.ingestion.ingest(textUpdate(3, 12, 'visible realtime')).bucketId).toBeDefined();
    expect(fixture.ingestion.ingestCatchUp(textUpdate(4, 13, 'visible catch-up')).messageId).toBeDefined();
    expect(logEvents('config_reloaded')).toHaveLength(2);
  } finally {
    fixture.store.close();
  }
});

test('self-ignore rejects unknown senders, unsafe IDs and missing Chats without changing configuration', async () => {
  const fixture = await setup();
  try {
    const before = fixture.configStore.current();
    const text = await fixture.readText();
    expect(await fixture.commands.run({ name: 'ignoreme' }, BigInt(CHAT_ID), null)).toContain('无法识别发送者');
    for (const id of [0n, -1n, BigInt(Number.MAX_SAFE_INTEGER) + 1n]) {
      expect(await fixture.reloader.setChatUserIgnored(CHAT_ID, id, true)).toMatchObject({
        ok: false,
        code: 'config_invalid',
        fileWritten: false,
      });
    }
    expect(await fixture.commands.run({ name: 'ignoreme' }, -999n, ADMIN)).toBe('本 Chat 未在配置中找到。');
    expect(await fixture.readText()).toBe(text);
    expect(fixture.configStore.current()).toBe(before);
    await fixture.patch((config) => {
      config.telegram.chats = [{ id: -999 }];
    });
    const removedText = await fixture.readText();
    expect(await fixture.commands.run({ name: 'ignoreme' }, BigInt(CHAT_ID), ADMIN)).toContain('更新忽略名单失败');
    expect(await fixture.readText()).toBe(removedText);
    expect(fixture.configStore.current()).toBe(before);
  } finally {
    fixture.store.close();
  }
});

test('self-ignore reports apply failures after persisting and repeated commands recover the saved change', async () => {
  const fixture = await setup({
    transform: (config) => {
      config.telegram.bucket_window_seconds = 30;
      config.agent!.context!.idle_grace_seconds = 30;
    },
  });
  try {
    const before = fixture.configStore.current();
    await fixture.patch((config) => {
      config.telegram.bucket_window_seconds = 5;
      config.agent!.context!.idle_grace_seconds = 10;
    });
    const reply = await fixture.commands.run({ name: 'ignoreme' }, BigInt(CHAT_ID), ADMIN);
    expect(reply).toContain('已写入 config.jsonc，但应用失败');
    expect((await loadConfig(fixture.configPath)).config.telegram.chats[0]?.ignored_user_ids).toEqual([42]);
    expect(fixture.configStore.current()).toBe(before);
    expect(logEvents('config_reload_failed').at(-1)?.code).toBe('candidate_invalid');
    const corrected = (await loadConfig(fixture.configPath)).fileConfig;
    corrected.agent!.context!.idle_grace_seconds = 30;
    await fixture.writeText(`${JSON.stringify(corrected, null, 2)}\n`);
    const saved = await fixture.readText();
    const retried = await fixture.commands.run({ name: 'ignoreme' }, BigInt(CHAT_ID), ADMIN);
    expect(retried).toContain('已忽略');
    expect(retried).toContain('需要重启');
    expect(await fixture.readText()).toBe(saved);
    expect(fixture.configStore.current().config.telegram.chats[0]?.ignored_user_ids).toEqual([42]);
  } finally {
    fixture.store.close();
  }
});
