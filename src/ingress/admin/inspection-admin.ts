import Type from 'typebox';
import { Compile } from 'typebox/compile';
import type { RuntimeConfigurationStore } from '../../platform/runtime-config.ts';
import type { SecretStore } from '../../platform/secrets.ts';
import { isThinkingLevel } from '../../platform/thinking-levels.ts';
import type { ConfigController } from '../../platform/config-write.ts';
import type { BusinessStore } from '../../store/store.ts';
import { listActiveTextModels } from '../../platform/model-switch.ts';
import { ThinkingLevelSchema } from '../../platform/config-schema-model.ts';
import { listAlarms } from '../../plugins/alarm/admin.ts';
import { REPLAY_BODY_MAX_BYTES, SECURITY_HEADERS, json, listQuery, readJsonObject } from './admin-http.ts';
import { authenticateApiKey } from './api-keys.ts';
import { AdminQueryError, parseId } from './audit.ts';
import { getConversationContext, listConversationContexts } from './audit/conversations.ts';
import { getInvocation } from './audit/invocation-detail.ts';
import { listInvocations } from './audit/invocations.ts';
import { getMessage, listMessages } from './audit/messages.ts';
import { overview, usage } from './audit/overview.ts';
import { listStickerSets, listStickers } from './audit/stickers.ts';
import {
  configurationView,
  configuredPromptView,
  inspectConfiguration,
  inspectionQuery,
  redactInspection,
} from './config-inspection.ts';
import { type InvocationMediaReader, listInvocationMedia } from './invocation-media.ts';
import type { ReplayInvocationInput, ReplayPreflightSelection } from './server.ts';

const MAX_PROMPT_LENGTH = 65_536;
const replayBodyValidator = Compile(
  Type.Object(
    {
      global_prompt: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_PROMPT_LENGTH })),
      group_prompt: Type.Optional(Type.String({ maxLength: MAX_PROMPT_LENGTH })),
      before_send_id: Type.Optional(Type.String({ pattern: '^[1-9]\\d{0,18}$' })),
      provider: Type.Optional(Type.String({ minLength: 1 })),
      model: Type.Optional(Type.String({ minLength: 1 })),
      thinking_level: Type.Optional(ThinkingLevelSchema),
    },
    { additionalProperties: false },
  ),
);

function validateBeforeSendId(value: string): string {
  if (!/^[1-9]\d{0,18}$/.test(value) || BigInt(value) > 9_223_372_036_854_775_807n) {
    throw new AdminQueryError('invalid_before_send_id', 'before_send_id must be a positive 64-bit decimal ID');
  }
  return value;
}

function validateReplayModelPair(
  provider: string | undefined,
  model: string | undefined,
  code: 'invalid_body' | 'invalid_query',
): void {
  if ((provider === undefined) !== (model === undefined)) {
    throw new AdminQueryError(code, 'provider and model must be provided together');
  }
  for (const value of [provider, model]) {
    if (value !== undefined && (value.trim().length === 0 || value.length > 256 || /\p{Cc}/u.test(value))) {
      throw new AdminQueryError(code, 'provider and model must be 1 to 256 characters without control characters');
    }
  }
}

function parseReplayInput(value: unknown): ReplayInvocationInput {
  if (!replayBodyValidator.Check(value)) {
    throw new AdminQueryError(
      'invalid_body',
      'Only before_send_id, provider/model, thinking_level and global_prompt/group_prompt templates of at most 65536 characters are accepted; system prompt overrides are forbidden',
    );
  }
  if (value.before_send_id !== undefined) {
    validateBeforeSendId(value.before_send_id);
  }
  validateReplayModelPair(value.provider, value.model, 'invalid_body');
  return value;
}

const REPLAY_PREFLIGHT_PARAMS = new Set(['before_send_id', 'provider', 'model', 'thinking_level']);

/**
 * Builds the read-only replay selection from a preflight query. Unknown or
 * repeated keys were already rejected; this validates the values: `provider`
 * and `model` must arrive together and `thinking_level` must be a known level.
 */
function preflightSelection(url: URL): ReplayPreflightSelection {
  const beforeSendId = url.searchParams.get('before_send_id');
  const provider = url.searchParams.get('provider');
  const model = url.searchParams.get('model');
  const thinkingLevel = url.searchParams.get('thinking_level');
  validateReplayModelPair(provider ?? undefined, model ?? undefined, 'invalid_query');
  if (thinkingLevel !== null && !isThinkingLevel(thinkingLevel)) {
    throw new AdminQueryError('invalid_query', 'thinking_level must be a supported level');
  }
  return {
    ...(beforeSendId === null ? {} : { before_send_id: validateBeforeSendId(beforeSendId) }),
    ...(provider === null || model === null ? {} : { provider, model }),
    ...(thinkingLevel === null ? {} : { thinking_level: thinkingLevel }),
  };
}

export interface InspectionAdminDeps {
  readonly store: BusinessStore;
  readonly configStore: RuntimeConfigurationStore;
  readonly configReloader: ConfigController | undefined;
  readonly secrets: SecretStore | undefined;
  /** Replays one audit invocation; absent when the agent runtime is not wired. */
  readonly replayInvocation:
    | ((id: bigint, input: ReplayInvocationInput, signal: AbortSignal) => Promise<unknown>)
    | undefined;
  readonly replayPreflight: ((id: bigint, selection?: ReplayPreflightSelection) => unknown) | undefined;
  readonly invocationPrompts: ((id: bigint) => unknown) | undefined;
  readonly readInvocationMedia: InvocationMediaReader | undefined;
}

/**
 * The read-only half of `/api`: the fixed programmatic surface API keys reach,
 * the exact inspection allowlist, and the audit listings. Nothing here writes.
 */
export function createInspectionAdminHandler(deps: InspectionAdminDeps) {
  const {
    store,
    configStore,
    configReloader,
    secrets,
    replayInvocation,
    replayPreflight,
    invocationPrompts,
    readInvocationMedia,
  } = deps;

  /**
   * Replay is dispatched to the host-supplied engine; the AdminServer neither
   * reads invocation state nor runs a model itself. Domain failures surface as
   * AdminQueryError thrown by the engine and are rendered by `handle`; anything
   * else becomes the generic internal error, so no engine detail leaks.
   */
  const replayInvocationRoute = async (request: Request, invocationId: bigint): Promise<Response> => {
    if (replayInvocation === undefined) {
      return json({ error: 'replay_unavailable', message: 'Invocation replay is not wired' }, 503);
    }
    const input = parseReplayInput(await readJsonObject(request, REPLAY_BODY_MAX_BYTES));
    return json(await replayInvocation(invocationId, input, request.signal));
  };

  /**
   * The programmatic surface of an `Authorization: Bearer pwk_…` request. The
   * key authenticates the caller, but the surface is fixed: inspection reads,
   * invocation reads and isolated replay. Every other route is refused — including
   * API key management and credential/config writes. A cookie never upgrades it.
   */
  const apiKeyRequest = async (
    request: Request,
    url: URL,
    segments: readonly string[],
    authorization: string,
  ): Promise<Response> => {
    const scheme = 'Bearer ';
    const token =
      authorization.slice(0, scheme.length).toLowerCase() === scheme.toLowerCase()
        ? authorization.slice(scheme.length).trim()
        : '';
    if (token.length === 0 || authenticateApiKey(store.orm, token) === null) {
      return json({ error: 'unauthenticated', message: 'A valid API key is required' }, 401);
    }
    secrets?.remember(token);
    const inspection = await inspect(request, url, segments, token);
    if (inspection !== undefined) {
      return inspection;
    }
    if (segments[0] !== 'invocations') {
      return json({ error: 'forbidden', message: 'API keys may only access inspection and invocation routes' }, 403);
    }
    if (segments.length === 1 && request.method === 'GET') {
      return json(
        redactInspection(listInvocations(store.orm, listQuery(url), configStore.current().config), secrets, token),
      );
    }
    if (segments.length === 2 && request.method === 'GET') {
      const found = getInvocation(store.orm, parseId(segments[1] ?? '', 'id'));
      return found === null ? json({ error: 'not_found', message: 'Invocation does not exist' }, 404) : json(found);
    }
    if (segments.length === 3 && segments[2] === 'replay' && request.method === 'POST') {
      return await replayInvocationRoute(request, parseId(segments[1] ?? '', 'id'));
    }
    return json({ error: 'forbidden', message: 'API keys may only access inspection and invocation routes' }, 403);
  };

  /** Exact GET allowlist shared by sessions and keys; never dispatches panel writes. */
  const inspect = async (
    request: Request,
    url: URL,
    segments: readonly string[],
    token?: string,
  ): Promise<Response | undefined> => {
    if (request.method !== 'GET') {
      return undefined;
    }
    const route = segments.join('/');
    const inspectedJson = (value: unknown): Response => json(redactInspection(value, secrets, token));
    if (route === 'config/view' || route === 'prompts/global' || route === 'prompts/group') {
      const query = inspectionQuery(url, route === 'prompts/group');
      const { config, ...metadata } = await inspectConfiguration(configStore, configReloader, query.source);
      return inspectedJson(
        route === 'config/view'
          ? { ...metadata, config: configurationView(config) }
          : {
              ...metadata,
              ...configuredPromptView(config, store.orm, route === 'prompts/global' ? 'global' : 'group', query.chatId),
            },
      );
    }
    if (route === 'models') {
      if (url.searchParams.size > 0) {
        throw new AdminQueryError('invalid_query', 'The models listing takes no query parameters');
      }
      const snapshot = configStore.current();
      return inspectedJson({
        source: 'active',
        generation: snapshot.generation,
        models: listActiveTextModels(configStore),
      });
    }
    if (segments[0] !== 'invocations') {
      return undefined;
    }
    const action = segments[2];
    if (segments.length === 3 && (action === 'replay-preflight' || action === 'prompts')) {
      for (const key of url.searchParams.keys()) {
        if (
          action !== 'replay-preflight' ||
          !REPLAY_PREFLIGHT_PARAMS.has(key) ||
          url.searchParams.getAll(key).length !== 1
        ) {
          throw new AdminQueryError(
            'invalid_query',
            'Replay preflight accepts at most one before_send_id, provider, model and thinking_level parameter',
          );
        }
      }
      const id = parseId(segments[1] ?? '', 'id');
      const selection = preflightSelection(url);
      if (action === 'replay-preflight') {
        if (replayPreflight === undefined) {
          throw new AdminQueryError('replay_unavailable', 'Invocation replay inspection is not wired', 503);
        }
        return inspectedJson(await replayPreflight(id, selection));
      }
      if (invocationPrompts === undefined) {
        throw new AdminQueryError('replay_unavailable', 'Invocation replay inspection is not wired', 503);
      }
      return inspectedJson(await invocationPrompts(id));
    }
    if (action !== 'media') {
      return undefined;
    }
    if (segments.length === 3) {
      if (url.searchParams.size > 0) {
        throw new AdminQueryError('invalid_query', 'Media listing takes no query parameters');
      }
      return inspectedJson(listInvocationMedia(store.orm, parseId(segments[1] ?? '', 'id')));
    }
    if (segments.length !== 5 || segments[4] !== 'content') {
      return undefined;
    }
    for (const key of url.searchParams.keys()) {
      if (key !== 'variant' || url.searchParams.getAll(key).length !== 1) {
        throw new AdminQueryError('invalid_query', 'Media content only accepts one variant parameter');
      }
    }
    const variant = url.searchParams.get('variant') ?? 'original';
    if (variant !== 'original' && variant !== 'preview') {
      throw new AdminQueryError('invalid_variant', 'variant must be original or preview');
    }
    const invocationId = parseId(segments[1] ?? '', 'id');
    const mediaId = parseId(segments[3] ?? '', 'media_id');
    if (readInvocationMedia === undefined) {
      throw new AdminQueryError('media_unavailable', 'Invocation media downloading is not wired', 503);
    }
    const content = await readInvocationMedia(invocationId, mediaId, variant, request.signal);
    return new Response(new Uint8Array(content.bytes), {
      headers: {
        ...SECURITY_HEADERS,
        'content-type': content.mime,
        'content-length': String(content.bytes.byteLength),
        'cache-control': 'private, no-store',
        'content-disposition': 'attachment',
        'x-plasticwan-media-variant': content.variant,
      },
    });
  };

  /** The audit listings; each returns `undefined` when the path names something else. */
  const list = async (url: URL, segments: readonly string[]): Promise<Response | undefined> => {
    const route = segments.join('/');
    const query = listQuery(url);
    if (route === 'overview') {
      return json(overview(store.orm));
    }
    if (route === 'alarms') {
      return json(listAlarms(store.orm, query));
    }
    if (route === 'usage') {
      const daysParam = url.searchParams.get('days');
      const days = daysParam === null ? 7 : Number.parseInt(daysParam, 10);
      if (!Number.isInteger(days) || days < 1 || days > 90) {
        return json({ error: 'invalid_days', message: 'days must be an integer between 1 and 90' }, 400);
      }
      return json(usage(store.orm, days));
    }
    if (route === 'invocations') {
      return json(redactInspection(listInvocations(store.orm, query, configStore.current().config), secrets));
    }
    if (segments[0] === 'invocations' && segments.length === 2) {
      const found = getInvocation(store.orm, parseId(segments[1] ?? '', 'id'));
      return found === null ? json({ error: 'not_found', message: 'Invocation does not exist' }, 404) : json(found);
    }
    if (route === 'contexts') {
      return json(listConversationContexts(store.orm, query));
    }
    if (segments[0] === 'contexts' && segments.length === 2) {
      const found = getConversationContext(store.orm, parseId(segments[1] ?? '', 'id'));
      return found === null
        ? json({ error: 'not_found', message: 'Conversation context does not exist' }, 404)
        : json(found);
    }
    if (route === 'messages') {
      return json(listMessages(store.orm, query));
    }
    if (segments[0] === 'messages' && segments.length === 2) {
      const found = getMessage(store.orm, parseId(segments[1] ?? '', 'id'));
      return found === null ? json({ error: 'not_found', message: 'Message does not exist' }, 404) : json(found);
    }
    if (route === 'sticker-sets') {
      return json({ items: listStickerSets(store.orm) });
    }
    if (route === 'stickers') {
      return json(listStickers(store.orm, query));
    }
    return undefined;
  };

  return { apiKeyRequest, inspect, list };
}
