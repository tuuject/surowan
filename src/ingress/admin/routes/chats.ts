import type { RuntimeConfigurationStore } from '../../../platform/runtime-config.ts';
import type { MemoBlobStore } from '../../../context/memo-pad/blobs.ts';
import type { BucketScheduler } from '../../../orchestration/scheduler/index.ts';
import type { ConfigController, ConfigEdit } from '../../../platform/config/write.ts';
import type { SecretStore } from '../../../platform/secrets.ts';
import type { BusinessStore } from '../../../store/store.ts';
import { telegramChatIdentity } from '../../../store/chat-identity.ts';
import { json, readJsonObject, requiredRevision, revisionRequired } from '../http.ts';
import { CONFIG_WRITE_STATUS, readConfigFile } from '../config-file.ts';
import {
  createChat,
  deleteChat,
  deleteTelegramChatData,
  listChats,
  parseChatId,
  parseChatSettings,
  parseCreateChat,
  parseParticipation,
  parseProactiveReply,
  runningInvocationIdsForTelegramChat,
  updateChat,
  updateChatParticipation,
  updateChatProactiveReply,
} from '../chats.ts';

export interface ChatsAdminDeps {
  readonly store: BusinessStore;
  readonly configStore: RuntimeConfigurationStore;
  readonly configReloader: ConfigController | undefined;
  readonly secrets: SecretStore | undefined;
  readonly memoBlobs: MemoBlobStore;
  readonly scheduler?: BucketScheduler;
}

/** `/api/chats*` — the Chat list and the per-Chat settings writes. */
export function createChatsAdminHandler(deps: ChatsAdminDeps) {
  const { store, configStore, configReloader, secrets, memoBlobs, scheduler } = deps;

  const chatsView = async (reloader: ConfigController) => {
    const { loaded, revision } = await readConfigFile(reloader, secrets);
    return listChats(
      loaded.fileConfig,
      configStore.current().config,
      store,
      revision,
      reloader.status().restartRequired,
    );
  };

  const chats = async (request: Request, segments: readonly string[]): Promise<Response> => {
    const reloader = configReloader;
    if (reloader === undefined) {
      return json({ error: 'chats_unavailable', message: 'Chat management is not wired' }, 503);
    }
    if (request.method === 'GET' && segments.length === 1) {
      return json(await chatsView(reloader));
    }
    if (
      !(
        (request.method === 'POST' && segments.length === 1) ||
        ((request.method === 'PUT' || request.method === 'DELETE') && segments.length === 2) ||
        (request.method === 'PUT' && segments.length === 3 && segments[2] === 'participation') ||
        (request.method === 'PUT' && segments.length === 3 && segments[2] === 'proactive-reply')
      )
    ) {
      return json({ error: 'method_not_allowed', message: 'Unsupported Chat operation' }, 405);
    }
    const revision = requiredRevision(request);
    if (revision === null) {
      return revisionRequired();
    }
    const { loaded, revision: currentRevision } = await readConfigFile(reloader, secrets);
    if (revision !== currentRevision) {
      return json({ error: 'config_conflict', message: 'The configuration file changed; reload before editing' }, 409);
    }
    const deletingChatId = request.method === 'DELETE' ? BigInt(parseChatId(segments[1] ?? '')) : undefined;
    let edits: readonly ConfigEdit[];
    if (request.method === 'POST') {
      edits = createChat(loaded.fileConfig, parseCreateChat(await readJsonObject(request)));
    } else {
      const id = parseChatId(segments[1] ?? '');
      edits =
        request.method === 'DELETE'
          ? deleteChat(loaded.fileConfig, id)
          : segments[2] === 'participation'
            ? updateChatParticipation(loaded.fileConfig, id, parseParticipation(await readJsonObject(request)))
            : segments[2] === 'proactive-reply'
              ? updateChatProactiveReply(loaded.fileConfig, id, parseProactiveReply(await readJsonObject(request)))
              : updateChat(loaded.fileConfig, id, parseChatSettings(await readJsonObject(request)));
    }
    // The revision pins the ID-to-array-index mapping even if another writer reorders the file.
    const result = await reloader.writeAndApply(edits, revision);
    if (!result.ok) {
      const message = result.fileWritten
        ? `config.jsonc was updated but not applied: ${result.message}`
        : result.message;
      return json({ error: result.code, message }, CONFIG_WRITE_STATUS[result.code] ?? 409);
    }
    if (deletingChatId !== undefined) {
      const stillAuthorized = () => {
        const identity = new Set(telegramChatIdentity(store, [deletingChatId]));
        return configStore.current().config.telegram.chats.some((chat) => identity.has(BigInt(chat.id)));
      };
      if (stillAuthorized()) {
        return json(
          {
            error: 'chat_still_authorized',
            message: 'A migration alias is still configured; stored data was retained',
          },
          409,
        );
      }
      // Publication closes admission first. Include runs that started while
      // writeAndApply was preparing the next configuration, not a pre-write snapshot.
      const running = runningInvocationIdsForTelegramChat(store, deletingChatId);
      scheduler?.abortInvocations(running, 'chat_removed');
      const settled = scheduler === undefined ? running.length === 0 : await scheduler.waitForInvocations(running);
      // Another writer may have restored this Chat while handlers unwound.
      // This check and the row deletion below have no asynchronous gap.
      if (stillAuthorized()) {
        return json(
          {
            error: 'chat_still_authorized',
            message: 'A migration alias is still configured; stored data was retained',
          },
          409,
        );
      }
      if (!settled || runningInvocationIdsForTelegramChat(store, deletingChatId).length > 0) {
        return json(
          {
            error: 'chat_delete_pending',
            message:
              'Chat removed from configuration; active work is still stopping. Data was retained. Reload and retry DELETE.',
          },
          409,
        );
      }
      await deleteTelegramChatData(store, memoBlobs, deletingChatId);
    }
    return json({
      ...(await chatsView(reloader)),
      apply: { applied: result.applied, restart_required: result.restartRequired, outside_serve: result.outsideServe },
    });
  };

  return {
    async handle(request: Request, segments: readonly string[]): Promise<Response | undefined> {
      if (segments[0] === 'chats') {
        return await chats(request, segments);
      }
      return undefined;
    },
  };
}
