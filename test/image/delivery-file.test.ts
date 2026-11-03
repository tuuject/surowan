import type { Update } from 'grammy/types';
import { describe, expect, test } from 'vitest';
import { SqliteStore } from '../../src/adapters/local-monolith/database.ts';
import { grammyTelegramTransport } from '../../src/adapters/local-monolith/telegram/host.ts';
import type { CapabilityRefResolver } from '../../src/platform/invocation-context.ts';
import { imageDeliveryState } from '../../src/store/image-delivery.ts';
import { invocationCapabilities, type TestInvocationContext } from '../helpers.ts';
import {
  ASSET_A,
  ASSET_B,
  CHAT_ID,
  GENERATION_ID,
  START,
  buildTool,
  fakeTelegram,
  type Fixture,
  openConversation,
  openedStores,
  processOne,
  sendRows,
  setup,
  toolCalls,
} from './delivery-fixtures.ts';

/**
 * `send kind:file`: pictures delivered uncompressed as Telegram documents.
 *
 * A generation id sends its original outputs; an img_ ref of a picture the
 * bot generated resolves back to those originals instead of the compressed
 * photo; any other authorized picture is read as stored, never re-encoded. A
 * file send is its own ledger kind, so it neither counts as nor blocks the
 * generation's photo delivery. Refusals happen before any side effect.
 */

/** Resolves the given refs to media rows, and everything else as the context does. */
function withMediaRefs(
  fixture: Fixture,
  context: TestInvocationContext,
  refs: Readonly<Record<string, bigint>>,
): CapabilityRefResolver {
  const base = invocationCapabilities(fixture.store, fixture.config, context.header);
  return {
    resolveMedia: (ref) => refs[ref] ?? base.resolveMedia(ref),
    resolveStickerRef: (ref) => base.resolveStickerRef(ref),
    resolveReplyTarget: (ref) => base.resolveReplyTarget(ref),
    registerStickerRef: (fileId) => base.registerStickerRef(fileId),
  };
}

function mediaUpdate(messageId: number, content: Pick<NonNullable<Update['message']>, 'photo' | 'sticker'>): Update {
  return {
    update_id: messageId,
    message: {
      message_id: messageId,
      date: 1_700_000_000 + messageId,
      chat: { id: CHAT_ID, type: 'private', first_name: 'Owner' },
      from: { id: 42, is_bot: false, first_name: 'Alice' },
      ...content,
    } as NonNullable<Update['message']>,
  };
}

function sendKinds(fixture: Fixture): string[] {
  return fixture.store.db
    .prepare<[], { kind: string }>('SELECT kind FROM host_sends ORDER BY id')
    .all()
    .map((row) => row.kind);
}

const unreadable = {
  read: async (): Promise<never> => {
    throw new Error('the stored copy must not be read');
  },
};

describe('send kind:file', () => {
  test('delivers the original outputs of a generation as documents, apart from its photo delivery', async () => {
    const fixture = await setup();
    const context = openConversation(fixture, 1, START);
    const { tool, api } = buildTool(fixture, context, {
      pictures: () => [ASSET_A, ASSET_B],
      mediaFiles: unreadable,
    });

    const result = await tool.execute('file-1', { kind: 'file', image_generation_id: GENERATION_ID, text: '原图' });

    expect(result.details).toEqual({ telegramMessageId: '700' });
    expect(api.photoDeliveries).toEqual([]);
    expect(api.documentDeliveries).toEqual([
      {
        chatId: String(CHAT_ID),
        fileNames: ['a.png', 'b.png'],
        caption: '原图',
        bytes: [ASSET_A.bytes, ASSET_B.bytes],
      },
    ]);
    const [row] = sendRows(fixture.store);
    expect(row).toMatchObject({ state: 'success', telegram_message_id: 700n, error_code: null });
    expect(JSON.parse(row?.request_json ?? '{}')).toEqual({
      kind: 'file',
      reply_to_message_id: null,
      generation_id: GENERATION_ID,
      asset_ids: ['asset-a', 'asset-b'],
      files: 2,
    });
    expect(sendKinds(fixture)).toEqual(['file']);
    const revision = fixture.store.db
      .prepare<[], { kind: string; caption: string | null }>(
        'SELECT r.kind, r.caption FROM message_revisions r JOIN messages m ON m.id = r.message_id WHERE m.sent_by_bot = 1',
      )
      .get();
    expect(revision).toEqual({ kind: 'file', caption: '原图' });

    // The files are no photo delivery: the generation still counts as unsent,
    // and kind:image delivers it without a resend.
    expect(imageDeliveryState(fixture.store.orm, context.conversationId, GENERATION_ID).delivered.size).toBe(0);
    await tool.execute('img-1', { kind: 'image', image_generation_id: GENERATION_ID });
    expect(api.photoDeliveries).toHaveLength(1);
    expect(sendKinds(fixture)).toEqual(['file', 'image']);
  });

  test('an img_ ref of a picture the bot generated sends that delivery’s originals, never the compressed copy', async () => {
    const fixture = await setup();
    const context = openConversation(fixture, 1, START);
    const pictures = () => [ASSET_A, ASSET_B];
    const { tool } = buildTool(fixture, context, { pictures });
    // The album's first photo message is the one the conversation keeps.
    await tool.execute('img-1', { kind: 'image', image_generation_id: GENERATION_ID });
    const photoMedia = fixture.store.db
      .prepare<[], { id: bigint }>("SELECT id FROM media WHERE file_id = 'photo-500'")
      .get();
    if (photoMedia === undefined) {
      throw new Error('the sent photo has no media row');
    }
    const capabilities = withMediaRefs(fixture, context, { img_bot: photoMedia.id });

    const { tool: fileTool, api } = buildTool(fixture, context, { pictures, capabilities, mediaFiles: unreadable });
    await fileTool.execute('file-1', { kind: 'file', image_ref: 'img_bot' });

    expect(api.documentDeliveries.map((entry) => entry.fileNames)).toEqual([['a.png', 'b.png']]);
    expect(api.documentDeliveries[0]?.bytes).toEqual([ASSET_A.bytes, ASSET_B.bytes]);
    expect(JSON.parse(sendRows(fixture.store)[1]?.request_json ?? '{}')).toEqual({
      kind: 'file',
      reply_to_message_id: null,
      image_ref: 'img_bot',
      generation_id: GENERATION_ID,
      asset_ids: ['asset-a', 'asset-b'],
      files: 2,
    });

    // Once the originals are gone, the compressed copy is not passed off as one.
    const { tool: goneTool, api: goneApi } = buildTool(fixture, context, {
      pictures: () => undefined,
      capabilities,
      mediaFiles: unreadable,
    });
    await expect(goneTool.execute('file-2', { kind: 'file', image_ref: 'img_bot' })).rejects.toThrow(
      'no longer available',
    );
    expect(goneApi.documentDeliveries).toEqual([]);
    expect(toolCalls(fixture.store).at(-1)).toMatchObject({
      tool_call_id: 'file-2',
      state: 'error',
      error_code: 'file_original_unavailable',
    });
    expect(sendRows(fixture.store)).toHaveLength(2);
  });

  test('any other picture is sent as stored, under a name with its extension', async () => {
    const fixture = await setup();
    fixture.ingestion.ingest(
      mediaUpdate(1, {
        photo: [{ file_id: 'user-photo', file_unique_id: 'user-photo-u', width: 1280, height: 960, file_size: 2000 }],
      }),
      START,
    );
    const context = fixture.build(processOne(fixture.scheduler, new Date(START.getTime() + 15_000)));
    const [[ref, mediaId] = []] = [...context.imageCapabilities.entries()];
    if (ref === undefined || mediaId === undefined) {
      throw new Error('the photo has no img_ ref in this context');
    }
    const stored = new Uint8Array([0xff, 0xd8, 0xff, 7]);
    const reads: bigint[] = [];
    const { tool, api } = buildTool(fixture, context, {
      mediaFiles: {
        read: async (id) => {
          reads.push(id);
          return { bytes: stored, fileName: `photo-${id}`, mime: 'image/jpeg' };
        },
      },
    });

    await tool.execute('file-1', { kind: 'file', image_ref: ref, reply_to_message_id: '1' });

    expect(reads).toEqual([mediaId]);
    expect(api.documentDeliveries).toEqual([
      { chatId: String(CHAT_ID), fileNames: [`photo-${mediaId}.jpg`], caption: undefined, bytes: [stored] },
    ]);
    expect(JSON.parse(sendRows(fixture.store)[0]?.request_json ?? '{}')).toEqual({
      kind: 'file',
      reply_to_message_id: '1',
      image_ref: ref,
      files: 1,
    });
  });

  test('refuses stickers, unknown refs and ambiguous sources before any side effect', async () => {
    const fixture = await setup();
    fixture.ingestion.ingest(
      mediaUpdate(1, {
        sticker: {
          file_id: 'sticker-file',
          file_unique_id: 'sticker-u',
          type: 'regular',
          width: 512,
          height: 512,
          is_animated: false,
          is_video: false,
        },
      }),
      START,
    );
    // A sticker alone opens no batch; the text does.
    const context = openConversation(fixture, 2, new Date(START.getTime() + 1_000));
    const sticker = fixture.store.db.prepare<[], { id: bigint }>("SELECT id FROM media WHERE kind = 'sticker'").get();
    if (sticker === undefined) {
      throw new Error('the sticker has no media row');
    }
    const { tool, api } = buildTool(fixture, context, {
      capabilities: withMediaRefs(fixture, context, { img_sticker: sticker.id }),
      mediaFiles: unreadable,
    });

    await expect(tool.execute('file-1', { kind: 'file', image_ref: 'img_sticker' })).rejects.toThrow(
      'sticker cannot be sent as a file',
    );
    await expect(tool.execute('file-2', { kind: 'file', image_ref: 'img_unknown' })).rejects.toThrow(
      'not visible in this conversation',
    );
    await expect(
      tool.execute('file-3', { kind: 'file', image_ref: 'img_sticker', image_generation_id: GENERATION_ID }),
    ).rejects.toThrow('exactly one of image_generation_id or image_ref');
    await expect(tool.execute('file-4', { image_ref: 'img_sticker' })).rejects.toThrow('kind is required');

    expect(toolCalls(fixture.store).map((call) => [call.tool_call_id, call.error_code])).toEqual([
      ['file-1', 'file_source_unsupported'],
      ['file-2', 'image_ref_not_authorized'],
      ['file-3', 'send_input_invalid'],
      ['file-4', 'send_input_invalid'],
    ]);
    expect(sendRows(fixture.store)).toEqual([]);
    expect(api.documentDeliveries).toEqual([]);
  });

  test('a transport that cannot send files fails the send as unsupported, not unknown', async () => {
    const fixture = await setup();
    const context = openConversation(fixture, 1, START);
    const { sendDocuments: _files, ...withoutFiles } = fakeTelegram();
    const { tool } = buildTool(fixture, context, { api: withoutFiles, mediaFiles: unreadable });

    await expect(tool.execute('file-1', { kind: 'file', image_generation_id: GENERATION_ID })).rejects.toThrow(
      'send_unsupported',
    );
    expect(sendRows(fixture.store)).toMatchObject([{ state: 'error', error_code: 'send_unsupported' }]);
  });

  test('the grammY transport sends one file as a document and several as one document group', async () => {
    const calls: unknown[][] = [];
    const message = (id: number) => ({ message_id: id, date: 1_700_000_100, chat: { id: CHAT_ID } });
    const transport = grammyTelegramTransport({
      sendDocument: async (...args: unknown[]) => {
        calls.push(['sendDocument', ...args]);
        return message(1);
      },
      sendMediaGroup: async (...args: unknown[]) => {
        calls.push(['sendMediaGroup', ...args]);
        return [message(2), message(3)];
      },
    } as never);
    const target = { message_thread_id: 7, reply_parameters: { message_id: 9 } };
    const file = (name: string) => ({ bytes: new Uint8Array([1]), fileName: name });

    expect(await transport.sendDocuments?.('1', [file('a.png')], { ...target, caption: 'one' })).toHaveLength(1);
    expect(
      await transport.sendDocuments?.('1', [file('a.png'), file('b.png')], { ...target, caption: 'two' }),
    ).toHaveLength(2);

    const [single, group] = calls;
    expect(single?.[0]).toBe('sendDocument');
    expect(single?.[3]).toEqual({ ...target, caption: 'one' });
    expect(group?.[0]).toBe('sendMediaGroup');
    const media = group?.[2] as readonly { readonly type: string; readonly caption?: string }[];
    expect(media.map((entry) => [entry.type, entry.caption])).toEqual([
      ['document', 'two'],
      ['document', undefined],
    ]);
    expect(group?.[3]).toEqual(target);
  });

  test('migration 049 rebuilds the ledger for the file kind without losing a row or an index', async () => {
    const fixture = await setup();
    const context = openConversation(fixture, 1, START);
    const { tool } = buildTool(fixture, context, { mediaFiles: unreadable });
    await tool.execute('img-1', { kind: 'image', image_generation_id: GENERATION_ID });
    await tool.execute('file-1', { kind: 'file', image_generation_id: GENERATION_ID });
    const ledger = (store: SqliteStore) => store.db.prepare('SELECT * FROM host_sends ORDER BY id').all();
    const indexes = (store: SqliteStore) =>
      store.db
        .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'host_sends' ORDER BY name")
        .all();
    const before = { rows: ledger(fixture.store), indexes: indexes(fixture.store) };
    expect(before.indexes).toHaveLength(3);
    fixture.store.db.exec('DELETE FROM schema_migrations WHERE version = 49');
    fixture.store.close();

    const store = await SqliteStore.open(fixture.config);
    openedStores.push(store);
    expect({ rows: ledger(store), indexes: indexes(store) }).toEqual(before);
    expect(store.db.prepare('SELECT count(*) AS n FROM schema_migrations WHERE version = 49').get()).toEqual({
      n: 1n,
    });
    expect(() => store.db.prepare("UPDATE host_sends SET kind = 'video'").run()).toThrow(/CHECK constraint/);
  });
});
