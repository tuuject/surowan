import type { RuntimeConfigurationStore } from '../../../platform/runtime-config.ts';
import type { SecretStore } from '../../../platform/secrets.ts';
import type { ConfigController, ConfigEdit } from '../../../platform/config/write.ts';
import type { AgentModelSwitcher } from '../../../platform/models/switch.ts';
import { resolveToolModel } from '../../../platform/tool-model.ts';
import type { BusinessStore } from '../../../store/store.ts';
import { DictionaryStore } from '../../../plugins/dictionary/store.ts';
import {
  createDictionaryEntry,
  deleteDictionaryEntry,
  dictionaryExport,
  dictionarySettingsView,
  dictionaryView,
  importDictionaryEntries,
  listDictionaryChatOptions,
  mergeDictionaryEntries,
  mergePreview,
  parseDictionaryDraft,
  parseDictionaryImportBody,
  parseDictionaryImportPreview,
  parseDictionaryQuery,
  parseDictionarySettingsBody,
  parseExportFormat,
  parseMergeConfirm,
  parseMergePreview,
  previewDictionaryImport,
  toolModelView,
  updateDictionaryEntry,
} from '../../../plugins/dictionary/admin.ts';
import {
  REPLAY_BODY_MAX_BYTES,
  SECURITY_HEADERS,
  json,
  readJsonObject,
  redact,
  requiredRevision,
  revisionRequired,
} from '../http.ts';
import { AdminQueryError } from '../audit/shared.ts';
import { CONFIG_WRITE_STATUS, readConfigFile } from '../config-file.ts';

export interface DictionaryAdminDeps {
  readonly store: BusinessStore;
  readonly configStore: RuntimeConfigurationStore;
  readonly configReloader: ConfigController | undefined;
  readonly secrets: SecretStore | undefined;
  readonly modelSwitcher: AgentModelSwitcher | undefined;
}

/** `/api/dictionary*` and the `/api/tool-model` write that feeds its merge preview. */
export function createDictionaryAdminHandler(deps: DictionaryAdminDeps) {
  const { store, configStore, configReloader, secrets, modelSwitcher } = deps;

  /** The tool-model suggestion: one auxiliary model call, no write. */
  const dictionaryMergePreview = async (request: Request, dictionary: DictionaryStore): Promise<Response> => {
    if (secrets === undefined) {
      return json({ error: 'dictionary_unavailable', message: 'Configuration reloading is not wired' }, 503);
    }
    const ids = parseMergePreview(await readJsonObject(request));
    const snapshot = configStore.current();
    const toolModel = resolveToolModel(snapshot.config);
    if (toolModel === undefined) {
      return json({ error: 'tool_model_unavailable', message: 'No tool model is configured' }, 502);
    }
    try {
      return json(
        await mergePreview(
          {
            store: dictionary,
            orm: store.orm,
            models: snapshot.models,
            secrets,
            toolModel,
          },
          ids,
        ),
      );
    } catch (error) {
      if (error instanceof AdminQueryError) {
        return json({ error: error.code, message: error.message }, error.status);
      }
      if (error instanceof Error && error.name === 'ToolModelUnavailableError') {
        return json({ error: 'tool_model_unavailable', message: redact(secrets, error) }, 502);
      }
      return json({ error: 'merge_failed', message: redact(secrets, error) }, 502);
    }
  };

  const dictionarySettings = async (request: Request, url: URL): Promise<Response> => {
    const reloader = configReloader;
    if (reloader === undefined) {
      return json({ error: 'dictionary_unavailable', message: 'Configuration reloading is not wired' }, 503);
    }
    const chatParam = url.searchParams.get('chat');
    let chatId: bigint | null = null;
    if (chatParam !== null && chatParam.length > 0) {
      if (!/^-?[1-9][0-9]{0,15}$/.test(chatParam)) {
        return json({ error: 'invalid_chat', message: 'chat must be a Telegram chat ID' }, 400);
      }
      chatId = BigInt(chatParam);
    }
    if (request.method === 'GET') {
      const { loaded, revision } = await readConfigFile(reloader, secrets);
      return json(dictionarySettingsView(loaded.config, chatId, revision));
    }
    if (request.method !== 'PUT') {
      return json({ error: 'method_not_allowed', message: 'Use GET or PUT for dictionary settings' }, 405);
    }
    const expected = requiredRevision(request);
    if (expected === null) {
      return revisionRequired();
    }
    const mode = parseDictionarySettingsBody(await readJsonObject(request));
    const { loaded, revision } = await readConfigFile(reloader, secrets);
    if (expected !== revision) {
      return json({ error: 'config_conflict', message: 'The configuration file changed; reload before editing' }, 409);
    }
    let edits: readonly ConfigEdit[];
    if (chatId === null) {
      if (mode === null) {
        return json({ error: 'invalid_body', message: 'The global injection mode cannot be cleared' }, 400);
      }
      edits =
        loaded.fileConfig.dictionary?.injection_mode === mode
          ? []
          : [{ path: ['dictionary', 'injection_mode'], value: mode }];
    } else {
      const chats = loaded.fileConfig.telegram?.chats ?? [];
      const index = chats.findIndex((chat) => BigInt(chat.id) === chatId);
      if (index === -1) {
        return json({ error: 'chat_unconfigured', message: 'The requested chat is not configured' }, 404);
      }
      const chat = chats[index];
      if ((chat?.dictionary_injection_mode ?? null) === mode) {
        edits = [];
      } else if (mode === null) {
        edits = [{ path: ['telegram', 'chats', index, 'dictionary_injection_mode'], value: undefined }];
      } else {
        edits = [{ path: ['telegram', 'chats', index, 'dictionary_injection_mode'], value: mode }];
      }
    }
    if (edits.length === 0) {
      return json(dictionarySettingsView(loaded.config, chatId, revision));
    }
    const result = await reloader.writeAndApply(edits, revision);
    if (!result.ok) {
      const message = result.fileWritten
        ? `config.jsonc was updated but not applied: ${result.message}`
        : result.message;
      return json({ error: result.code, message }, CONFIG_WRITE_STATUS[result.code] ?? 409);
    }
    const view = await readConfigFile(reloader, secrets);
    return json(dictionarySettingsView(view.loaded.config, chatId, view.revision));
  };

  /**
   * `/api/dictionary` — the dictionary manager's read and write surface.
   *
   * Every scope is explicit in the request; a group write names its Telegram
   * chat, and an entry revision (not a config revision) is the write's
   * optimistic lock. Import/merge are two-step: preview writes nothing.
   */
  const dictionary = async (request: Request, url: URL, segments: readonly string[]): Promise<Response> => {
    const dictionaryStore = new DictionaryStore(store.orm);
    const route = segments.slice(1).join('/');
    if (route === 'chats' && request.method === 'GET') {
      return json({ items: listDictionaryChatOptions(store.orm) });
    }
    if (route === 'settings') {
      return await dictionarySettings(request, url);
    }
    if (route === 'import/preview' && request.method === 'POST') {
      const body = parseDictionaryImportPreview(await readJsonObject(request, REPLAY_BODY_MAX_BYTES));
      return json(previewDictionaryImport(dictionaryStore, body));
    }
    if (route === 'import' && request.method === 'POST') {
      const body = parseDictionaryImportBody(await readJsonObject(request, REPLAY_BODY_MAX_BYTES));
      return json({ items: importDictionaryEntries(store.orm, body.entries) });
    }
    if (route === 'export' && request.method === 'GET') {
      const query = parseDictionaryQuery(url.searchParams);
      const format = parseExportFormat(url.searchParams);
      const file = dictionaryExport(dictionaryStore, query, format);
      return new Response(file.text, {
        status: 200,
        headers: {
          ...SECURITY_HEADERS,
          'content-type': format === 'csv' ? 'text/csv; charset=utf-8' : 'application/x-ndjson; charset=utf-8',
          'content-disposition': `attachment; filename="${file.filename}"`,
          'cache-control': 'private, no-store',
        },
      });
    }
    if (route === 'merge/preview' && request.method === 'POST') {
      return await dictionaryMergePreview(request, dictionaryStore);
    }
    if (route === 'merge' && request.method === 'POST') {
      const body = parseMergeConfirm(await readJsonObject(request));
      return json(mergeDictionaryEntries(store.orm, body));
    }
    if (segments.length === 1 && request.method === 'GET') {
      return json(dictionaryView(dictionaryStore, parseDictionaryQuery(url.searchParams)));
    }
    if (segments.length === 1 && request.method === 'POST') {
      const body = parseDictionaryDraft(await readJsonObject(request));
      return json(createDictionaryEntry(store.orm, body));
    }
    if (segments.length === 2 && segments[1] !== undefined) {
      const id = segments[1];
      if (request.method === 'PUT') {
        const revision = requiredRevision(request);
        if (revision === null) {
          return revisionRequired();
        }
        const body = parseDictionaryDraft(await readJsonObject(request));
        return json(updateDictionaryEntry(store.orm, id, body, revision));
      }
      if (request.method === 'DELETE') {
        const revision = requiredRevision(request);
        if (revision === null) {
          return revisionRequired();
        }
        deleteDictionaryEntry(store.orm, id, revision);
        return json({ status: 'ok' });
      }
    }
    return json({ error: 'not_found', message: 'Unknown dictionary route' }, 404);
  };

  /** The system-wide auxiliary model, written into `dictionary.tool_model`. */
  const writeToolModel = async (request: Request): Promise<Response> => {
    const reloader = configReloader;
    if (reloader === undefined) {
      return json({ error: 'tool_model_unavailable', message: 'Configuration reloading is not wired' }, 503);
    }
    const revision = requiredRevision(request);
    if (revision === null) {
      return revisionRequired();
    }
    const body = await readJsonObject(request);
    const { loaded, revision: currentRevision } = await readConfigFile(reloader, secrets);
    if (revision !== currentRevision) {
      return json({ error: 'config_conflict', message: 'The configuration file changed; reload before editing' }, 409);
    }
    let edits: readonly ConfigEdit[];
    if (body.inherit === true) {
      edits = loaded.fileConfig.tool_model === undefined ? [] : [{ path: ['tool_model'], value: undefined }];
    } else if (
      typeof body.provider === 'string' &&
      typeof body.model === 'string' &&
      typeof body.thinking_level === 'string'
    ) {
      const switcher = modelSwitcher;
      if (switcher === undefined) {
        return json({ error: 'tool_model_unavailable', message: 'Model switching is not wired' }, 503);
      }
      try {
        switcher.option(body.provider, body.model);
      } catch (error) {
        const code = error instanceof Error && error.name === 'ModelSwitchError' ? 'unknown_model' : 'invalid_body';
        return json({ error: code, message: redact(secrets, error) }, 400);
      }
      edits = [
        {
          path: ['tool_model'],
          value: { provider: body.provider, model: body.model, thinking_level: body.thinking_level },
        },
      ];
    } else {
      return json(
        { error: 'invalid_body', message: 'Expected { inherit: true } or { provider, model, thinking_level }' },
        400,
      );
    }
    const result = await reloader.writeAndApply(edits, revision);
    if (!result.ok) {
      const message = result.fileWritten
        ? `config.jsonc was updated but not applied: ${result.message}`
        : result.message;
      return json({ error: result.code, message }, CONFIG_WRITE_STATUS[result.code] ?? 409);
    }
    const view = await readConfigFile(reloader, secrets);
    return json({
      ...toolModelView(view.loaded.config),
      revision: view.revision,
      apply: { applied: result.applied, restart_required: result.restartRequired, outside_serve: result.outsideServe },
    });
  };

  return {
    async handle(request: Request, url: URL, segments: readonly string[]): Promise<Response | undefined> {
      if (segments[0] === 'dictionary') {
        return await dictionary(request, url, segments);
      }
      const route = segments.join('/');
      if (route === 'tool-model' && request.method === 'PUT') {
        return await writeToolModel(request);
      }
      return undefined;
    },
  };
}
