/**
 * Admin message audit: Telegram sender identity is preserved per revision.
 */
import { expect, test } from 'vitest';
import { TelegramIngestion } from '../../src/ingress/telegram-ingestion/index.ts';
import { fixture, PASSWORD, post, readJson, request, sessionCookie, textUpdate } from './fixtures.ts';

test('message audit preserves Telegram sender IDs as strings and distinguishes user, channel and missing identity', async () => {
  const { store, server, configStore } = await fixture();
  try {
    const ingestion = new TelegramIngestion(store, configStore, { id: 999 });
    const userId = Number.MAX_SAFE_INTEGER;
    const user = textUpdate(1, 10, 'large sender ID');
    user.message!.from!.id = userId;
    const storedUser = ingestion.ingest(user);
    ingestion.ingest({
      update_id: 2,
      edited_message: { ...user.message!, text: 'edited large sender ID', edit_date: 1_700_000_100 },
    });
    const channel = textUpdate(3, 11, 'anonymous channel message');
    channel.message!.sender_chat = { id: -1009876543210, type: 'channel', title: 'Channel' };
    const storedChannel = ingestion.ingest(channel);
    const unknown = textUpdate(4, 12, 'no sender');
    const storedUnknown = ingestion.ingest(unknown);
    store.db
      .prepare('UPDATE message_revisions SET sender_id = NULL WHERE message_id = ?')
      .run(storedUnknown.messageId!);
    const cookie = sessionCookie(
      await server.handle(post('/api/auth/setup', { username: 'owner', password: PASSWORD })),
    );
    const headers = { cookie };
    const listing = await readJson(await server.handle(request('/api/messages', { headers })));
    expect(
      listing.items.find((item: { id: string }) => item.id === storedUser.messageId?.toString())?.sender,
    ).toMatchObject({ telegram_id: userId.toString(), telegram_type: 'user', username: null });
    expect(
      listing.items.find((item: { id: string }) => item.id === storedChannel.messageId?.toString())?.sender,
    ).toMatchObject({ telegram_id: '-1009876543210', telegram_type: 'sender_chat', display_name: 'Channel' });
    expect(
      listing.items.find((item: { id: string }) => item.id === storedUnknown.messageId?.toString())?.sender,
    ).toBeNull();
    const detail = await readJson(await server.handle(request(`/api/messages/${storedUser.messageId}`, { headers })));
    expect(detail.revisions).toHaveLength(2);
    for (const revision of detail.revisions) {
      expect(revision.sender).toMatchObject({ telegram_id: '9007199254740991', telegram_type: 'user' });
    }
    const anonymous = await readJson(
      await server.handle(request(`/api/messages/${storedChannel.messageId}`, { headers })),
    );
    expect(anonymous.revisions[0].sender).toMatchObject({
      telegram_id: '-1009876543210',
      telegram_type: 'sender_chat',
    });
    const missing = await readJson(
      await server.handle(request(`/api/messages/${storedUnknown.messageId}`, { headers })),
    );
    expect(missing.revisions[0].sender).toBeNull();
  } finally {
    store.close();
  }
});
