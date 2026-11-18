import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';

import { loadConfig } from '../../src/adapters/local-monolith/config/index.ts';
import { SqliteStore } from '../../src/adapters/local-monolith/database.ts';
import { runningInvocationIdsForTelegramChat } from '../../src/ingress/admin/chats.ts';
import { listInvocations } from '../../src/ingress/admin/audit/invocations.ts';
import { listConversationContexts } from '../../src/context/store/queries.ts';
import { writeTestConfig } from '../helpers.ts';

// (host_kind, host_chat_id) may hold the same native id once per host: a
// reader holding a Telegram id must never see the other host's rows. The
// second chat is written as 'playground' on purpose — the schema no longer
// enumerates hosts, so raw SQL stands in for a future host.
test('lookups by a host-native id only match that host', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'surowan-host-scope-'));
  let store: SqliteStore | undefined;
  try {
    const configPath = join(directory, 'config.jsonc');
    await writeTestConfig(directory, configPath);
    const { config } = await loadConfig(configPath);
    store = await SqliteStore.open(config);
    store.db.exec(`
      INSERT INTO chats (id, host_kind, host_chat_id, canonical_chat_id, type, title, updated_at)
        VALUES (1, 'telegram', 500, 500, 'group', 'Telegram chat', '2026-01-01T00:00:00.000Z'),
               (2, 'playground', 500, NULL, 'virtual', 'Other host room', '2026-01-01T00:00:00.000Z');
      INSERT INTO conversations (id, chat_id, message_thread_id, created_at, updated_at)
        VALUES (10, 1, 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
               (20, 2, 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      INSERT INTO conversation_contexts (conversation_id, system_prompt_hash, last_active_at, created_at, updated_at)
        VALUES (10, 'tg', '2026-01-01T00:01:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
               (20, 'pg', '2026-01-01T00:02:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      INSERT INTO buckets (id, conversation_id, state, first_received_at, deadline_at, created_at, updated_at)
        VALUES (10, 10, 'running', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:30.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
               (20, 20, 'running', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:30.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      INSERT INTO invocations (id, bucket_id, conversation_id, state, config_hash, prompt_version, created_at)
        VALUES (10, 10, 10, 'running', 'h', 1, '2026-01-01T00:00:00.000Z'),
               (20, 20, 20, 'running', 'h', 1, '2026-01-01T00:00:00.000Z');
    `);

    // `/status` asks for the Telegram chat's contexts; the room that happens to
    // share the native id must not show up or take one of the limited rows.
    expect(listConversationContexts(store, { hostChatId: 500n }).map((row) => row.conversationId)).toEqual([10n]);

    // The Admin chat-delete guard waits on the Telegram chat's running work —
    // the other host's running invocation is unrelated and must not block it.
    expect(runningInvocationIdsForTelegramChat(store, 500n)).toEqual([10n]);

    // The audit list's `chat` parameter is a Telegram chat id.
    const page = listInvocations(store.orm, { chat: '500' });
    expect(page.items.map((item) => item.id)).toEqual(['10']);
  } finally {
    store?.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
