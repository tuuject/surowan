import type { RuntimeConfigurationStore } from '../../platform/runtime-config.ts';
import type { SecretStore } from '../../platform/secrets.ts';
import type { BucketScheduler } from '../../orchestration/scheduler.ts';
import type { ConfigController } from '../../platform/config-write.ts';
import { resolveChatConfig, type BusinessStore } from '../../store/store.ts';
import { getPromptVersion } from '../../store/prompt-versions.ts';
import { REPLAY_BODY_MAX_BYTES, json, readJsonObject, requiredRevision } from './admin-http.ts';
import { parseId } from './audit.ts';
import { redactInspection } from './config-inspection.ts';
import { CONFIG_WRITE_STATUS } from './config-file-admin.ts';
import {
  cancelPromptRunningInvocations,
  type PromptSaveResult,
  parsePromptCancelBody,
  parsePromptChatParam,
  parsePromptDiffQuery,
  parsePromptRestoreBody,
  parsePromptSaveBody,
  parsePromptVersionsQuery,
  promptDiffView,
  promptVersionContentView,
  promptVersionsView,
  promptVersionView,
  restorePromptVersion,
  savePromptVersion,
} from './prompts-admin.ts';

export interface PromptsAdminDeps {
  readonly store: BusinessStore;
  readonly configStore: RuntimeConfigurationStore;
  readonly configReloader: ConfigController | undefined;
  readonly secrets: SecretStore | undefined;
  readonly scheduler: BucketScheduler | undefined;
}

/**
 * `/api/prompts/*` — the prompt manager's versioned read and write surface.
 * The plain prompt views (`GET prompts/global` / `prompts/group`) stay on the
 * shared inspection surface, so this dispatch returns `undefined` for them
 * and they fall through to the inspection allowlist.
 */
export function createPromptsAdminHandler(deps: PromptsAdminDeps) {
  const { store, configStore, configReloader, secrets, scheduler } = deps;

  const promptSaveResponse = (outcome: PromptSaveResult): Response => {
    if (outcome.kind === 'unchanged') {
      return json({
        status: 'unchanged',
        version: outcome.latest === undefined ? null : promptVersionView(outcome.latest),
      });
    }
    if (outcome.kind === 'apply_failed') {
      const message = `The prompt file was written and the version recorded, but the configuration was not applied: ${outcome.message}`;
      return json(
        { error: outcome.code, message, version: promptVersionView(outcome.version) },
        CONFIG_WRITE_STATUS[outcome.code] ?? 409,
      );
    }
    return json({
      status: 'saved',
      version: promptVersionView(outcome.version),
      applied: outcome.result.applied,
      restart_required: outcome.result.restartRequired,
      outside_serve: outcome.result.outsideServe,
      active_hash: outcome.result.status.activeHash,
      file_hash: outcome.result.status.fileHash,
      // Running invocations still on the old prompt; cancel them explicitly.
      affected_running: outcome.affectedRunning,
      // The changed stable prompt rebuilds the affected Conversation Contexts
      // on their next run.
      context_rebuild: true,
    });
  };

  const promptSave = async (
    request: Request,
    url: URL,
    scope: 'global' | 'group',
    username: string,
  ): Promise<Response> => {
    const reloader = configReloader;
    if (reloader === undefined) {
      return json({ error: 'prompts_unavailable', message: 'Prompt management is not wired' }, 503);
    }
    const expected = requiredRevision(request);
    if (expected === null) {
      return json({ error: 'revision_required', message: 'If-Match with the prompt content hash is required' }, 400);
    }
    const body = parsePromptSaveBody(await readJsonObject(request, REPLAY_BODY_MAX_BYTES));
    let chatId: bigint | undefined;
    if (scope === 'group') {
      chatId = parsePromptChatParam(url.searchParams.get('chat'));
    } else if (url.searchParams.size > 0) {
      return json({ error: 'invalid_query', message: 'The global prompt takes no query parameters' }, 400);
    }
    const outcome = await savePromptVersion(store.orm, reloader, {
      scope,
      chatId,
      content: body.prompt,
      note: body.note,
      source: 'panel',
      expectedHash: expected,
      username,
    });
    return promptSaveResponse(outcome);
  };

  const promptRestore = async (request: Request, versionId: string, username: string): Promise<Response> => {
    const reloader = configReloader;
    if (reloader === undefined) {
      return json({ error: 'prompts_unavailable', message: 'Prompt management is not wired' }, 503);
    }
    const expected = requiredRevision(request);
    if (expected === null) {
      return json({ error: 'revision_required', message: 'If-Match with the prompt content hash is required' }, 400);
    }
    const body = parsePromptRestoreBody(await readJsonObject(request, REPLAY_BODY_MAX_BYTES));
    const outcome = await restorePromptVersion(store.orm, reloader, parseId(versionId, 'version_id'), {
      expectedHash: expected,
      note: body.note,
      username,
    });
    return promptSaveResponse(outcome);
  };

  const promptVersionsViewFor = (url: URL): Response => {
    const query = parsePromptVersionsQuery(url);
    if (query.scope === 'group') {
      // Same resolution as `configuredPromptView`, so the panel's chat filter
      // accepts the configured or migrated ID it already shows.
      const chat = resolveChatConfig(configStore.current().config, store.orm, query.chatId);
      if (chat === undefined) {
        return json({ error: 'chat_unconfigured', message: 'The requested chat is not configured' }, 404);
      }
      return json(promptVersionsView(store.orm, 'group', BigInt(chat.id)));
    }
    return json(promptVersionsView(store.orm, 'global', 0n));
  };

  const promptCancelRunning = async (request: Request): Promise<Response> => {
    const body = parsePromptCancelBody(await readJsonObject(request));
    let configuredChatId: bigint | undefined;
    if (body.scope === 'group') {
      if (body.chat_id === undefined) {
        return json({ error: 'invalid_body', message: 'chat_id is required for the group scope' }, 400);
      }
      const chat = resolveChatConfig(configStore.current().config, store.orm, BigInt(body.chat_id));
      if (chat === undefined) {
        return json({ error: 'chat_unconfigured', message: 'The requested chat is not configured' }, 404);
      }
      configuredChatId = BigInt(chat.id);
    } else if (body.chat_id !== undefined) {
      return json({ error: 'invalid_body', message: 'chat_id is not valid for the global scope' }, 400);
    }
    const current = configStore.current();
    return json(cancelPromptRunningInvocations(store.orm, scheduler, current.hash, body.scope, configuredChatId));
  };

  return {
    async handle(
      request: Request,
      url: URL,
      segments: readonly string[],
      username: string,
    ): Promise<Response | undefined> {
      if (segments[0] !== 'prompts') {
        return undefined;
      }
      const second = segments[1];
      if (segments.length === 2 && (second === 'global' || second === 'group')) {
        if (request.method === 'GET') {
          return undefined;
        }
        if (request.method !== 'PUT') {
          return json({ error: 'method_not_allowed', message: 'Use PUT to save a prompt' }, 405);
        }
        return await promptSave(request, url, second === 'global' ? 'global' : 'group', username);
      }
      if (segments.length === 2 && second === 'versions') {
        if (request.method !== 'GET') {
          return json({ error: 'method_not_allowed', message: 'Prompt versions are read-only' }, 405);
        }
        return promptVersionsViewFor(url);
      }
      if (segments.length === 3 && second === 'versions' && request.method === 'GET') {
        const version = getPromptVersion(store.orm, parseId(segments[2] ?? '', 'version_id'));
        if (version === undefined) {
          return json({ error: 'version_not_found', message: 'The prompt version does not exist' }, 404);
        }
        return json(redactInspection(promptVersionContentView(version), secrets));
      }
      if (segments.length === 4 && second === 'versions' && segments[3] === 'restore' && request.method === 'POST') {
        return await promptRestore(request, segments[2] ?? '', username);
      }
      if (segments.length === 2 && second === 'diff') {
        if (request.method !== 'GET') {
          return json({ error: 'method_not_allowed', message: 'Prompt diff is read-only' }, 405);
        }
        const { from, to } = parsePromptDiffQuery(url);
        return json(redactInspection(promptDiffView(store.orm, from, to), secrets));
      }
      if (segments.length === 2 && second === 'cancel-running' && request.method === 'POST') {
        return await promptCancelRunning(request);
      }
      return undefined;
    },
  };
}
