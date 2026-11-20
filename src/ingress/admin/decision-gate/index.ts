import Compile from 'typebox/compile';
import type {
  DecisionGateChatConfig,
  DecisionGateConfig,
  FileConfig,
  SecretRef,
} from '../../../platform/config/index.ts';
import { DecisionGateSchema } from '../../../platform/config/schema-sections.ts';
import { validateDecisionGate } from '../../../platform/config/semantics-decision-gate.ts';
import type { ConfigEdit, KeychainReplacement, SecretWrite } from '../../../platform/config/write.ts';
import {
  DECISION_GATE_DEFAULTS,
  resolveDecisionGate,
  type DecisionGateScope,
} from '../../../platform/decision-gate.ts';
import { KEYCHAIN_NAME_PATTERN } from '../../../platform/keychain.ts';
import { AdminQueryError } from '../audit/shared.ts';
import {
  type CallerClass,
  type KeychainUsageForInput,
  resolveSecretInput,
  SecretAllocator,
  type SecretInput,
  type SecretSourceView,
  sameSecretRef,
  secretSourceOf,
} from '../secret-input.ts';

/**
 * The panel's view of `telegram.decision_gate` and the translation of one form
 * submission into a configuration edit. The gate's credential never travels
 * back: the view says whether a key is configured (and, for a panel session,
 * where it comes from), and a submitted plaintext becomes a keychain entry.
 *
 * `GET /decision-gate` reports two sides the way `GET /harness` does — `saved`
 * is the file on disk and `active` is the running configuration — so the page
 * can show a pending edit the process has not applied. An absent field reports
 * the value `resolveDecisionGate` actually uses for it.
 */

/** The behavior fields the global section and a Chat override share. */
const BEHAVIOR_FIELDS = [
  'enabled',
  'mode',
  'threshold',
  'history_messages',
  'pending_messages',
  'instructions',
] as const;
const GLOBAL_FIELDS = [...BEHAVIOR_FIELDS, 'model', 'base_url', 'timeout_ms'] as const;

type BehaviorField = (typeof BEHAVIOR_FIELDS)[number];
type GlobalField = (typeof GLOBAL_FIELDS)[number];

/**
 * The section's own schema decides every range, enum and length, so the panel
 * can never accept a value the file would reject. `Compile` of an optional
 * property still checks the bare type, the trick `harness.ts` relies on.
 */
const gateProperties = DecisionGateSchema.properties;
const FIELD_VALIDATORS: Readonly<Record<GlobalField, ReturnType<typeof Compile>>> = {
  enabled: Compile(gateProperties.enabled),
  mode: Compile(gateProperties.mode),
  threshold: Compile(gateProperties.threshold),
  history_messages: Compile(gateProperties.history_messages),
  pending_messages: Compile(gateProperties.pending_messages),
  instructions: Compile(gateProperties.instructions),
  model: Compile(gateProperties.model),
  base_url: Compile(gateProperties.base_url),
  timeout_ms: Compile(gateProperties.timeout_ms),
};

type Nullable<T> = NonNullable<T> | null;

/** One submitted patch: an absent field is kept, `null` removes it from the file. */
export interface DecisionGateBody {
  readonly enabled?: Nullable<DecisionGateConfig['enabled']>;
  readonly mode?: Nullable<DecisionGateConfig['mode']>;
  readonly threshold?: Nullable<DecisionGateConfig['threshold']>;
  readonly history_messages?: Nullable<DecisionGateConfig['history_messages']>;
  readonly pending_messages?: Nullable<DecisionGateConfig['pending_messages']>;
  readonly instructions?: Nullable<DecisionGateConfig['instructions']>;
  readonly model?: Nullable<DecisionGateConfig['model']>;
  readonly base_url?: Nullable<DecisionGateConfig['base_url']>;
  readonly api_key?: SecretInput | null;
  readonly timeout_ms?: Nullable<DecisionGateConfig['timeout_ms']>;
}

export type DecisionGateChatBody = Pick<DecisionGateBody, BehaviorField>;

/** The ten fields, minus the secret, with every default filled in. */
export interface DecisionGateValues {
  readonly enabled: boolean;
  readonly mode: 'shadow' | 'enforce';
  readonly threshold: number;
  readonly history_messages: number;
  readonly pending_messages: number;
  readonly instructions: string;
  readonly model: string;
  readonly base_url: string;
  readonly timeout_ms: number;
}

export interface DecisionGateView {
  readonly revision: string;
  readonly saved: DecisionGateValues;
  readonly active: DecisionGateValues;
  /** Whether the saved section names a credential; never the credential itself. */
  readonly key_configured: boolean;
  /** Panel sessions only: which keychain entry, env var or command the reference names. */
  readonly key_source?: SecretSourceView;
}

function gateValues(scope: DecisionGateScope): DecisionGateValues {
  const settings = resolveDecisionGate(scope);
  return {
    enabled: settings.enabled,
    mode: settings.mode,
    threshold: settings.threshold,
    history_messages: settings.history_messages,
    pending_messages: settings.pending_messages,
    instructions: settings.instructions,
    model: settings.model,
    base_url: settings.base_url,
    timeout_ms: settings.timeout_ms,
  };
}

/** The scope a whole Telegram section scopes to; an absent section means all defaults. */
export function decisionGateScope(
  telegram: { readonly decision_gate?: DecisionGateConfig | undefined } | undefined,
): DecisionGateScope {
  return telegram?.decision_gate === undefined ? {} : { decision_gate: telegram.decision_gate };
}

export function decisionGateView(
  saved: DecisionGateScope,
  active: DecisionGateScope,
  revision: string,
  withSource: boolean,
): DecisionGateView {
  const reference = saved.decision_gate?.api_key;
  return {
    revision,
    saved: gateValues(saved),
    active: gateValues(active),
    key_configured: reference !== undefined,
    ...(withSource ? { key_source: secretSourceOf(reference) } : {}),
  };
}

/**
 * Parses one submitted patch. Every value is checked against the configuration
 * schema's own field, so a range the file would reject is refused here with a
 * 400 instead of surfacing as an apply failure; an unknown key — a connection
 * field on a Chat write, a typo — is refused rather than ignored.
 */
export function parseDecisionGateBody(body: Record<string, unknown>): DecisionGateBody {
  return parsePatch(body, GLOBAL_FIELDS, true);
}

/** The Chat override: the six behavior fields, never the connection ones. */
export function parseChatDecisionGateBody(body: Record<string, unknown>): DecisionGateChatBody {
  return parsePatch(body, BEHAVIOR_FIELDS, false) as DecisionGateChatBody;
}

function parsePatch(
  body: Record<string, unknown>,
  allowed: readonly GlobalField[],
  withSecret: boolean,
): DecisionGateBody {
  const entries = Object.entries(body);
  if (entries.length === 0) {
    throw new AdminQueryError('invalid_body', 'Provide at least one decision_gate field');
  }
  const parsed: Record<string, unknown> = {};
  for (const [key, value] of entries) {
    if (key === 'api_key') {
      if (!withSecret) {
        throw new AdminQueryError(
          'invalid_body',
          `Unknown Chat decision_gate field api_key; expected ${allowed.join(', ')}`,
        );
      }
      parsed[key] = parseSecretInput(value);
      continue;
    }
    if (!(allowed as readonly string[]).includes(key)) {
      throw new AdminQueryError('invalid_body', `Unknown decision_gate field ${key}; expected ${allowed.join(', ')}`);
    }
    if (value === null) {
      parsed[key] = null;
      continue;
    }
    if (!FIELD_VALIDATORS[key as GlobalField].Check(value)) {
      throw new AdminQueryError(
        'invalid_body',
        `Invalid value for telegram.decision_gate.${key}; it must match the configuration schema`,
      );
    }
    parsed[key] = value;
  }
  return parsed as DecisionGateBody;
}

/** `api_key` accepts the shared secret input union; `null` removes the reference. */
function parseSecretInput(value: unknown): SecretInput | null {
  if (value === null) {
    return null;
  }
  if (typeof value === 'string') {
    return value.length === 0 || value.length > 4_096 ? invalidSecretInput() : value;
  }
  if (typeof value === 'object' && !Array.isArray(value) && value !== null) {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.length === 1 && keys[0] === 'entry' && typeof record.entry === 'string') {
      return KEYCHAIN_NAME_PATTERN.test(record.entry) ? { entry: record.entry } : invalidSecretInput();
    }
    const known = keys.every((key) => key === 'value' || key === 'name');
    const plaintext = record.value;
    if (known && typeof plaintext === 'string' && plaintext.length > 0 && plaintext.length <= 4_096) {
      if (keys.length === 1) {
        return { value: plaintext };
      }
      if (typeof record.name === 'string' && KEYCHAIN_NAME_PATTERN.test(record.name)) {
        return { value: plaintext, name: record.name };
      }
    }
  }
  return invalidSecretInput();
}

function invalidSecretInput(): never {
  throw new AdminQueryError(
    'invalid_body',
    'api_key must be a string of 1-4096 characters, { value, name? } or { entry }, or null to remove it',
  );
}

/**
 * The plaintext a submitted `api_key` carries, for registration before it can
 * leak. It reads the raw, not yet validated body on purpose: a body that fails
 * validation still carried the secret.
 */
export function decisionGatePlaintext(value: unknown): string | undefined {
  const plaintext =
    typeof value === 'object' && value !== null && 'value' in value ? (value as { value: unknown }).value : value;
  return typeof plaintext === 'string' && plaintext.length > 0 ? plaintext : undefined;
}

/** What one accepted patch writes: the file edits and the keychain half. */
export interface DecisionGateWrite {
  readonly edits: readonly ConfigEdit[];
  readonly secrets: SecretWrite;
}

const API_KEY_PATH = 'telegram.decision_gate.api_key';

/**
 * Turns a global patch into file edits, resolving the secret exactly like the
 * search and Telegram-token writes do: a plaintext rotates a singly-used entry
 * in place, repairs a dangling reference, or allocates a new named entry when
 * the current one is shared. A programmatic credential may not choose an
 * existing entry (403) and may not carry the current key to another address
 * (400).
 */
export function decisionGateEdits(
  file: FileConfig,
  body: DecisionGateBody,
  caller: CallerClass,
  keychain: KeychainUsageForInput,
): DecisionGateWrite {
  const current: DecisionGateConfig | undefined = file.telegram?.decision_gate;
  const chats = file.telegram?.chats ?? [];
  const allocator = new SecretAllocator(new Set(keychain.entries), keychain.usage);
  const keys: Record<string, string> = Object.create(null);
  const repairs: Record<string, string> = Object.create(null);
  const replacements: KeychainReplacement[] = [];

  // The effective addresses, so writing the default explicitly is not a move
  // and dropping an override back to it is. A shared key must not be pointed at
  // a new host by a credential a prompt could have steered.
  const currentBase = current?.base_url ?? DECISION_GATE_DEFAULTS.base_url;
  const nextBase = body.base_url === null ? DECISION_GATE_DEFAULTS.base_url : (body.base_url ?? currentBase);
  if (
    caller === 'programmatic' &&
    body.api_key === undefined &&
    current?.api_key !== undefined &&
    nextBase !== currentBase
  ) {
    throw new AdminQueryError(
      'decision_gate_invalid',
      'base_url changed while keeping the api_key; submit the key again in the same request',
      400,
    );
  }

  let apiKey: SecretRef | undefined = current?.api_key;
  if (body.api_key === null) {
    apiKey = undefined;
  } else if (body.api_key !== undefined) {
    const resolved = resolveSecretInput(
      body.api_key,
      {
        path: API_KEY_PATH,
        editPath: ['telegram', 'decision_gate', 'api_key'],
        current: current?.api_key,
        suggestedName: 'decision-gate',
      },
      caller,
      allocator,
    );
    apiKey = resolved.ref;
    if (resolved.kind === 'new') {
      keys[resolved.name] = resolved.plaintext;
    } else if (resolved.kind === 'repair') {
      repairs[resolved.name] = resolved.plaintext;
    } else if (resolved.kind === 'rotate') {
      replacements.push({ name: resolved.name, value: resolved.plaintext, requestedBy: API_KEY_PATH });
    }
  }

  const next = patchedSection(body, current, apiKey);
  // The same cross-field rules configuration loading enforces: an enabled gate
  // needs a credential anywhere, and the address stays a plain HTTPS prefix.
  try {
    validateDecisionGate(isBlank(next) ? { chats } : { decision_gate: next, chats });
  } catch (error) {
    throw new AdminQueryError('decision_gate_invalid', error instanceof Error ? error.message : String(error), 400);
  }

  return {
    edits: sectionEdits(current, next, keys),
    secrets: {
      ...(Object.keys(repairs).length === 0 ? {} : { add: repairs }),
      ...(replacements.length === 0 ? {} : { replace: replacements }),
    },
  };
}

function isBlank(section: DecisionGateConfig): boolean {
  return Object.keys(section).length === 0;
}

/** One field of the patch: absent keeps the file's value, `null` removes it. */
function patched<K extends GlobalField>(
  body: DecisionGateBody,
  key: K,
  current: DecisionGateConfig | undefined,
): DecisionGateConfig[K] | undefined {
  const value: unknown = Object.hasOwn(body, key) ? (body as Readonly<Record<string, unknown>>)[key] : current?.[key];
  return value === null || value === undefined ? undefined : (value as NonNullable<DecisionGateConfig[K]>);
}

function patchedSection(
  body: DecisionGateBody,
  current: DecisionGateConfig | undefined,
  apiKey: SecretRef | undefined,
): DecisionGateConfig {
  const enabled = patched(body, 'enabled', current);
  const mode = patched(body, 'mode', current);
  const threshold = patched(body, 'threshold', current);
  const history = patched(body, 'history_messages', current);
  const pending = patched(body, 'pending_messages', current);
  const instructions = patched(body, 'instructions', current);
  const model = patched(body, 'model', current);
  const baseUrl = patched(body, 'base_url', current);
  const timeout = patched(body, 'timeout_ms', current);
  return {
    ...(enabled === undefined ? {} : { enabled }),
    ...(mode === undefined ? {} : { mode }),
    ...(threshold === undefined ? {} : { threshold }),
    ...(history === undefined ? {} : { history_messages: history }),
    ...(pending === undefined ? {} : { pending_messages: pending }),
    ...(instructions === undefined ? {} : { instructions }),
    ...(model === undefined ? {} : { model }),
    ...(baseUrl === undefined ? {} : { base_url: baseUrl }),
    ...(timeout === undefined ? {} : { timeout_ms: timeout }),
    ...(apiKey === undefined ? {} : { api_key: apiKey }),
  };
}

/**
 * The minimal file edits for the next section: the whole object when the file
 * has none (or none is left), one edit per changed field otherwise, so comments
 * on the fields this write leaves alone survive. An unchanged write yields no
 * edits, which the route reports as a no-op instead of rewriting the file.
 */
function sectionEdits(
  current: DecisionGateConfig | undefined,
  next: DecisionGateConfig,
  keys: Readonly<Record<string, string>>,
): ConfigEdit[] {
  if (isBlank(next)) {
    return current === undefined ? [] : [{ path: ['telegram', 'decision_gate'], value: undefined }];
  }
  const keychain = Object.keys(keys).length === 0 ? {} : { keys };
  if (current === undefined) {
    return [{ path: ['telegram', 'decision_gate'], value: next, ...keychain }];
  }
  const path = ['telegram', 'decision_gate'];
  const edits: ConfigEdit[] = GLOBAL_FIELDS.filter(
    (field) => JSON.stringify(next[field]) !== JSON.stringify(current[field]),
  ).map((field) => ({ path: [...path, field], value: next[field] }));
  if (!sameSecretRef(next.api_key, current.api_key)) {
    edits.push({ path: [...path, 'api_key'], value: next.api_key, ...keychain });
  }
  return edits;
}

/** The credential is global-only, so a Chat can never write it. */
function globalApiKey(file: FileConfig): SecretRef | undefined {
  return file.telegram?.decision_gate?.api_key;
}

/**
 * Edits only the Chat's `decision_gate` override. A private chat is refused:
 * the gate decides about a batch of group messages, and a direct conversation
 * has none. Removing every field removes the whole object, restoring
 * "inherit the global section field by field".
 */
export function updateChatDecisionGate(file: FileConfig, id: number, body: DecisionGateChatBody): ConfigEdit[] {
  const chats = file.telegram?.chats ?? [];
  const index = chats.findIndex((chat) => chat.id === id);
  const chat = chats[index];
  if (chat === undefined) {
    throw new AdminQueryError('chat_not_found', `Chat ${id} is not configured in the file`, 404);
  }
  if (chat.id > 0) {
    throw new AdminQueryError('invalid_body', 'Private chats cannot configure the decision gate', 400);
  }
  const current = chat.decision_gate;
  const next: DecisionGateChatConfig = {};
  for (const field of BEHAVIOR_FIELDS) {
    const value = patched(body as DecisionGateBody, field, current);
    if (value !== undefined) {
      Object.assign(next, { [field]: value });
    }
  }
  const path = ['telegram', 'chats', index, 'decision_gate'];
  if (Object.keys(next).length === 0) {
    return current === undefined ? [] : [{ path, value: undefined }];
  }
  // A Chat that turns the gate on without the global credential would fail open
  // on every batch, with nothing but `secret_unresolved` rows to show for it.
  if (next.enabled === true && globalApiKey(file) === undefined) {
    throw new AdminQueryError(
      'decision_gate_invalid',
      `telegram.decision_gate.api_key is required when chat ${id} enables the decision gate`,
      400,
    );
  }
  if (current === undefined) {
    return [{ path, value: next }];
  }
  return BEHAVIOR_FIELDS.filter((field) => JSON.stringify(next[field]) !== JSON.stringify(current[field])).map(
    (field) => ({ path: [...path, field], value: next[field] }),
  );
}
