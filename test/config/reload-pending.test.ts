import { expect, test } from 'vitest';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CHAT_ID, setup } from './reload-fixtures.ts';

test('removing a chat and its instructions file together still reloads', async () => {
  const fixture = await setup({
    transform: (config) => {
      config.telegram.chats = [
        { id: CHAT_ID, instructions_file: 'chat-instructions.md' },
        { id: 111, instructions_file: 'second-chat.md' },
      ];
    },
    files: { 'second-chat.md': 'second chat instructions' },
  });
  try {
    await fixture.patch((config) => {
      config.telegram.chats = [{ id: CHAT_ID, instructions_file: 'chat-instructions.md' }];
      config.agent!.thinking_level = 'high';
    });
    await rm(join(fixture.directory, 'second-chat.md'), { force: true });
    const result = await fixture.reloader.reloadFromFile();
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.message);
    }
    expect(result.applied).toEqual(['agent.thinking_level', 'telegram.chats[111]']);
    expect(result.restartRequired).toEqual([]);
    // The removal is hot and leaves the running configuration immediately; its
    // stored data stays until an Admin deletes the Chat.
    expect(fixture.configStore.current().config.telegram.chats.map((chat) => chat.id)).toEqual([CHAT_ID]);
  } finally {
    fixture.store.close();
  }
});

test('applies hot fields while restart-only fields wait, and keeps waiting afterwards', async () => {
  const fixture = await setup();
  try {
    await fixture.patch((config) => {
      config.agent!.thinking_level = 'high';
      config.telegram.bucket_window_seconds = 30;
    });
    const first = await fixture.reloader.reloadFromFile();
    expect(first.ok).toBe(true);
    if (!first.ok) {
      throw new Error(first.message);
    }
    expect(first.applied).toEqual(['agent.thinking_level']);
    expect(first.restartRequired).toEqual(['telegram.bucket_window_seconds']);
    expect(first.status.generation).toBe(2);
    expect(fixture.configStore.current().config.telegram.bucket_window_seconds).toBe(15);
    expect(fixture.configStore.current().hash).not.toBe(first.status.fileHash);

    await fixture.patch((config) => {
      config.agent!.thinking_level = 'medium';
    });
    const second = await fixture.reloader.reloadFromFile();
    expect(second.ok).toBe(true);
    if (!second.ok) {
      throw new Error(second.message);
    }
    expect(second.applied).toEqual(['agent.thinking_level']);
    expect(second.restartRequired).toEqual(['telegram.bucket_window_seconds']);
    expect(second.status.generation).toBe(3);
    expect(fixture.configStore.current().config.agent!.thinking_level).toBe('medium');
  } finally {
    fixture.store.close();
  }
});

test('reverting a pending restart field brings the active hash back to the file hash', async () => {
  const fixture = await setup();
  try {
    await fixture.patch((config) => {
      config.agent!.thinking_level = 'high';
      config.telegram.bucket_window_seconds = 30;
    });
    const pending = await fixture.reloader.reloadFromFile();
    expect(pending.ok).toBe(true);
    if (!pending.ok) {
      throw new Error(pending.message);
    }
    expect(pending.status.activeHash).not.toBe(pending.status.fileHash);

    // The active configuration already equals this file: only its identity moves.
    await fixture.patch((config) => {
      config.telegram.bucket_window_seconds = 15;
    });
    const reverted = await fixture.reloader.reloadFromFile();
    expect(reverted.ok).toBe(true);
    if (!reverted.ok) {
      throw new Error(reverted.message);
    }
    expect(reverted.applied).toEqual([]);
    expect(reverted.restartRequired).toEqual([]);
    expect(reverted.status.activeHash).toBe(reverted.status.fileHash);
    expect(reverted.status.generation).toBe(3);
    expect(fixture.configStore.current().config.agent!.thinking_level).toBe('high');
  } finally {
    fixture.store.close();
  }
});

test('treats a new chat as hot, a timezone edit as restart-only and an instructions edit as hot', async () => {
  const fixture = await setup({
    files: { 'other-instructions.md': 'other chat' },
  });
  try {
    await fixture.patch((config) => {
      config.telegram.chats = [
        { id: CHAT_ID, instructions_file: 'chat-instructions.md' },
        { id: 111, instructions_file: 'other-instructions.md' },
      ];
    });
    const added = await fixture.reloader.reloadFromFile();
    expect(added.ok).toBe(true);
    if (!added.ok) {
      throw new Error(added.message);
    }
    // Adding a chat is hot: the running process adopts it immediately.
    expect(added.applied).toEqual(['telegram.chats[111]']);
    expect(added.restartRequired).toEqual([]);
    expect(fixture.configStore.current().config.telegram.chats.map((chat) => chat.id)).toEqual([CHAT_ID, 111]);
    expect(fixture.reloader.status().generation).toBe(2);

    await fixture.patch((config) => {
      config.telegram.chats[0]!.timezone = 'Asia/Tokyo';
    });
    const chatField = await fixture.reloader.reloadFromFile();
    expect(chatField.ok).toBe(true);
    if (!chatField.ok) {
      throw new Error(chatField.message);
    }
    expect(chatField.restartRequired).toEqual(['telegram.chats[123456789].timezone']);
    expect(fixture.configStore.current().config.telegram.chats[0]?.timezone).toBeUndefined();

    // Only the instructions file changes; the configuration file is untouched.
    await writeFile(join(fixture.directory, 'chat-instructions.md'), 'updated instructions');
    const instructions = await fixture.reloader.reloadFromFile();
    expect(instructions.ok).toBe(true);
    if (!instructions.ok) {
      throw new Error(instructions.message);
    }
    expect(instructions.applied).toEqual(['telegram.chats[123456789].instructions_file']);
    expect(fixture.configStore.current().config.telegram.chats[0]?.instructions).toBe('updated instructions');
  } finally {
    fixture.store.close();
  }
});
