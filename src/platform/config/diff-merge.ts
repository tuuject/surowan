import type { ConfigChange, ConfigChangeKind } from './diff.ts';

/**
 * The hot whitelist and the field-level merge primitives shared by every
 * section of `config-diff.ts`. Keeping them here means each section module
 * (this one, the provider merge, the main composition) can import the same
 * classification rules without a cycle: only these types cross back, and they
 * are erased at runtime.
 */

/**
 * The hot whitelist. This module is the only place that defines it: every path
 * that is not listed here is restart-only, and a configuration field added to
 * the schema stays restart-only until it is listed.
 */
const HOT_PATHS: ReadonlySet<string> = new Set([
  'developer',
  'developer.record_model_payloads',
  'developer.record_agent_thinking',
  'agent.provider',
  'agent.model',
  'agent.system_prompt_file',
  'agent.thinking_level',
  'agent.context_stop_ratio',
  'agent.send_max_text_length',
  'agent.send_disallow_blank_lines',
  'agent.send_nudge_enabled',
  'agent.send_barrier_enabled',
  'agent.allow_reply_message_multiple_times',
  'agent.send_duplicate_guard_enabled',
  'agent.daily_budget',
  'agent.daily_budget.max_tokens',
  'agent.context',
  'agent.rate_limits',
  'agent.max_concurrency',
  'agent.history_messages',
  'agent.memory_ttl_warning_days',
  'vision.provider',
  'vision.model',
  'vision.max_output_tokens',
  'image',
  'dictionary',
  // The search section is read per invocation and per request; a reload that
  // changes it is published immediately, and availability transitions abort
  // running invocations from the composition root.
  'web_search',
  'tool_model',
  'telegram.admins',
  // The connection manager owns the grammY instance and follows the resolved
  // token, so rotating or clearing it never needs a process restart.
  'telegram.token',
]);

/**
 * `agent.context` and `agent.rate_limits` are hot as a whole; their fields are
 * listed for the report. Every provider field is hot — connection fields, the model list and
 * per-model paths, which are built dynamically — because a reload rebuilds the
 * model registry and publishes it with the configuration. The image section is
 * hot as a whole for the same reason: a reload re-resolves its SecretRefs and
 * republishes the image snapshot atomically.
 */
const HOT_PREFIXES: readonly string[] = [
  'agent.context.',
  'agent.rate_limits.',
  'providers.',
  'image.',
  'dictionary.',
  'web_search.',
  'tool_model.',
];

/**
 * `serve` reads these only through `backup` and the pre-migration backup, so
 * they are neither applied nor pending a restart.
 */
const OUTSIDE_SERVE_PATHS: ReadonlySet<string> = new Set([
  'paths.backups',
  'retention.online_days',
  'retention.backup_copies',
]);

/**
 * Chat IDs appear verbatim in change paths, including negative supergroup IDs.
 * Per-Chat runtime policies resolve from the published configuration, so every
 * scalar below them is hot as well.
 */
const HOT_PARTICIPATION_PATHS = [/^telegram\.participation(\.|$)/, /^telegram\.chats\[-?\d+\]\.participation(\.|$)/];
const HOT_PROACTIVE_REPLY_PATHS = [
  /^telegram\.proactive_reply(\.|$)/,
  /^telegram\.chats\[-?\d+\]\.proactive_reply(\.|$)/,
];

export function classify(path: string): ConfigChangeKind {
  if (OUTSIDE_SERVE_PATHS.has(path)) {
    return 'outside_serve';
  }
  if (HOT_PATHS.has(path) || HOT_PREFIXES.some((prefix) => path.startsWith(prefix))) {
    return 'hot';
  }
  // Participation schedules compile on demand from the published configuration
  // (`ParticipationRegistry.ruleFor`), so a changed schedule takes effect with
  // the next reload like a hot-added Chat. The object merges field by field,
  // so every path inside either level counts.
  if (HOT_PARTICIPATION_PATHS.some((pattern) => pattern.test(path))) {
    return 'hot';
  }
  // Same for spontaneous-participation tuning: the gate resolves the current
  // published values and resets a counter whose parameter set changed.
  if (HOT_PROACTIVE_REPLY_PATHS.some((pattern) => pattern.test(path))) {
    return 'hot';
  }
  return 'restart';
}

/** Structural equality that ignores object key order, unlike a JSON comparison. */
export function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true;
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => deepEqual(item, right[index]));
  }
  if (isJsonObject(left) && isJsonObject(right)) {
    const keys = Object.keys(left);
    return (
      keys.length === Object.keys(right).length &&
      keys.every((key) => Object.hasOwn(right, key) && deepEqual(left[key], right[key]))
    );
  }
  return false;
}

export class ChangeRecorder {
  readonly #changes = new Map<string, ConfigChangeKind>();

  add(path: string, kind: ConfigChangeKind): void {
    if (!this.#changes.has(path)) {
      this.#changes.set(path, kind);
    }
  }

  changes(): readonly ConfigChange[] {
    return [...this.#changes.entries()]
      .map(([path, kind]) => ({ path, kind }))
      .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  }
}

/** Merges one field into a candidate record, honouring the whitelist. */
export function mergeField(
  active: Record<string, unknown>,
  file: Record<string, unknown>,
  target: Record<string, unknown>,
  key: string,
  path: string,
  recorder: ChangeRecorder,
): void {
  const hasActive = Object.hasOwn(active, key);
  const hasFile = Object.hasOwn(file, key);
  if (!hasActive && !hasFile) {
    return;
  }
  if (!hasFile) {
    const kind = classify(path);
    recorder.add(path, kind);
    if (kind === 'restart') {
      target[key] = active[key];
    } else {
      delete target[key];
    }
    return;
  }
  if (!hasActive) {
    const kind = classify(path);
    recorder.add(path, kind);
    if (kind !== 'restart') {
      target[key] = file[key];
    }
    return;
  }
  target[key] = mergeValue(active[key], file[key], path, recorder);
}

function mergeValue(activeValue: unknown, fileValue: unknown, path: string, recorder: ChangeRecorder): unknown {
  if (isJsonObject(activeValue) && isJsonObject(fileValue)) {
    return mergeObject(activeValue, fileValue, path, recorder);
  }
  if (deepEqual(activeValue, fileValue)) {
    return fileValue;
  }
  const kind = classify(path);
  recorder.add(path, kind);
  return kind === 'restart' ? activeValue : fileValue;
}

function mergeObject(
  active: Record<string, unknown>,
  file: Record<string, unknown>,
  path: string,
  recorder: ChangeRecorder,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of unionKeys(active, file)) {
    mergeField(active, file, result, key, `${path}.${key}`, recorder);
  }
  return result;
}

export function unionKeys(left: object, right: object): readonly string[] {
  return [...new Set([...Object.keys(left), ...Object.keys(right)])];
}

export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
