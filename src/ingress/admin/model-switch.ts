import { sql } from 'drizzle-orm';
import type { RawConfig } from '../../platform/config/index.ts';
import type { BucketScheduler } from '../../orchestration/scheduler/index.ts';
import type { HostKind } from '../../platform/im-host/identity.ts';
import { resolveInvocationPolicy } from '../../platform/invocation-policy.ts';
import type { RuntimeConfigurationStore } from '../../platform/runtime-config.ts';
import type { Orm } from '../../store/store.ts';

/**
 * A panel model switch takes effect at once: Invocations still running on the
 * model being replaced are stopped, so the next batch of the Conversation starts
 * on the new one. Stopping them drops the reply to the batch they were working
 * on, so the switch endpoints first refuse with this code and the number of
 * Invocations involved; the admin confirms by sending the same request again
 * with `abort_running: true`.
 */
export const MODEL_IN_USE = 'model_in_use';

/** The abort reason the scheduler signals; the run records its own outcome. */
export const MODEL_SWITCH_ABORT_REASON = 'model_switched';

interface RunningInvocationRow {
  readonly id: bigint;
  readonly config_hash: string;
  readonly host_kind: string;
  readonly telegram_chat_id: bigint | null;
  readonly chat_id: bigint;
  readonly chat_type: string;
}

/**
 * The agent model one running Invocation resolves to under `config`, as
 * `provider/model` JSON, or `null` when the scope names no complete model or is
 * no longer configured — nothing there is running on a model a switch replaces.
 */
function agentModelKey(orm: Orm, config: RawConfig, row: RunningInvocationRow): string | null {
  const hostKind = row.host_kind as HostKind;
  let agent: ReturnType<typeof resolveInvocationPolicy>['agent'];
  try {
    agent = resolveInvocationPolicy(config, orm, {
      hostKind,
      chatId: hostKind === 'telegram' ? (row.telegram_chat_id ?? 0n) : row.chat_id,
      chatType: row.chat_type,
    }).agent;
  } catch {
    return null;
  }
  return agent.provider === undefined || agent.model === undefined
    ? null
    : JSON.stringify([agent.provider, agent.model]);
}

/**
 * Running Invocations whose agent model is not the same under `before` and
 * `after`: the ones a switch from one configuration to the other leaves on the
 * replaced model. Thinking-level changes alone never count.
 *
 * `excludeConfigHash` leaves out runs that started under that configuration.
 * After the switch is published, it is the new hash: a run that started since
 * then already uses the new model, even though `before` resolves it to the old.
 */
export function invocationsLeavingModel(
  orm: Orm,
  before: RawConfig,
  after: RawConfig,
  options: { readonly excludeConfigHash?: string } = {},
): bigint[] {
  const rows = orm.all<RunningInvocationRow>(sql`SELECT i.id AS id, i.config_hash AS config_hash,
      c.host_kind AS host_kind, c.telegram_chat_id AS telegram_chat_id, c.id AS chat_id, c.type AS chat_type
    FROM invocations i
    JOIN conversations v ON v.id = i.conversation_id
    JOIN chats c ON c.id = v.chat_id
    WHERE i.state = 'running'
    ORDER BY i.id`);
  return rows
    .filter((row) => options.excludeConfigHash === undefined || row.config_hash !== options.excludeConfigHash)
    .filter((row) => {
      const previous = agentModelKey(orm, before, row);
      return previous !== null && previous !== agentModelKey(orm, after, row);
    })
    .map((row) => row.id);
}

/**
 * Stops the runs `before` put on a model the active configuration no longer
 * gives them, once the switch is published. Recomputing here rather than
 * reusing the pre-write check also stops a run that started while the file was
 * being written; one that started on the new configuration is left alone.
 *
 * The batches an aborted run consumed close with it and get no reply; batches
 * attached to it but not injected yet go back to the queue, so the new model
 * answers them. Delegated long tasks are not touched.
 */
export function abortInvocationsLeavingModel(
  orm: Orm,
  configStore: RuntimeConfigurationStore,
  scheduler: Pick<BucketScheduler, 'abortInvocations' | 'wake'> | undefined,
  before: RawConfig,
): number {
  const after = configStore.current();
  const ids = invocationsLeavingModel(orm, before, after.config, { excludeConfigHash: after.hash });
  const aborted = ids.length === 0 ? 0 : (scheduler?.abortInvocations(ids, MODEL_SWITCH_ABORT_REASON) ?? 0);
  scheduler?.wake();
  return aborted;
}

/** `config` with the global agent model replaced, for checking a switch before it is written. */
export function withAgentModel(config: RawConfig, provider: string, model: string): RawConfig {
  return { ...config, agent: { ...config.agent, provider, model } };
}

/**
 * `config` with one Chat's model override replaced; `null` removes it so the
 * Chat follows the global model again.
 */
export function withChatModel(
  config: RawConfig,
  configuredChatId: number,
  provider: string | null,
  model: string | null,
): RawConfig {
  const chats = config.telegram.chats.map((chat) => {
    if (chat.id !== configuredChatId) {
      return chat;
    }
    const { provider: _provider, model: _model, ...rest } = chat;
    return provider === null || model === null ? rest : { ...rest, provider, model };
  });
  return { ...config, telegram: { ...config.telegram, chats } };
}

/** The refusal a switch answers with while Invocations still run on the replaced model. */
export function modelInUseBody(count: number): {
  readonly error: string;
  readonly message: string;
  readonly running_invocations: number;
} {
  return {
    error: MODEL_IN_USE,
    message: `${count} running invocation(s) still use the current model; send abort_running: true to stop them and switch`,
    running_invocations: count,
  };
}
