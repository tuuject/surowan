import { sql } from 'drizzle-orm';
import type { RawConfig } from '../platform/config/index.ts';
import type { HostKind } from '../platform/im-host/identity.ts';
import { type InvocationAgentSettings, resolveInvocationPolicy } from '../platform/invocation-policy.ts';
import type { RuntimeConfigurationStore } from '../platform/runtime-config.ts';
import { type Orm, resolveChatConfig } from '../store/store.ts';
import type { BucketScheduler } from './scheduler/index.ts';

/**
 * A model switch takes effect at once: Invocations still running on the model
 * being replaced are stopped, so the next batch of their Conversation starts on
 * the new one. The Admin Panel asks before it stops anything (see
 * `ingress/admin/model-switch.ts`); Telegram's `/model` is the admin's decision
 * already and stops them directly.
 */

/** The abort reason the scheduler signals; the run records its own outcome. */
export const MODEL_SWITCH_ABORT_REASON = 'model_switched';

export interface ModelSwitchScope {
  /**
   * Only consider runs in this configured Chat (migrated ids included). A Chat
   * switch applies the whole file, so without it a pending hand edit applied
   * along the way could stop runs elsewhere that nobody asked about.
   */
  readonly configuredChatId?: number;
}

interface RunningInvocationRow {
  readonly id: bigint;
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
  let agent: InvocationAgentSettings;
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

function inScope(orm: Orm, config: RawConfig, row: RunningInvocationRow, scope: ModelSwitchScope): boolean {
  if (scope.configuredChatId === undefined) {
    return true;
  }
  return (
    row.host_kind === 'telegram' &&
    row.telegram_chat_id !== null &&
    resolveChatConfig(config, orm, row.telegram_chat_id)?.id === scope.configuredChatId
  );
}

/**
 * Running Invocations whose own model is not the model `after` gives their
 * Chat: the ones a switch leaves on the replaced model. Thinking-level changes
 * alone never count.
 *
 * A run's model is read from the snapshot it actually started with, not from
 * the configuration active now: another apply may have moved the configuration
 * on while this run kept its own. A switch back to a model a run already uses
 * therefore stops nothing, even when the active configuration named something
 * else in between. A run with no live snapshot (started before this process,
 * or a scheduler-less caller) falls back to the active configuration.
 */
export function invocationsLeavingModel(
  orm: Orm,
  before: RawConfig,
  after: RawConfig,
  scheduler: Pick<BucketScheduler, 'invocationSnapshot' | 'invocationStopping'> | undefined,
  options: ModelSwitchScope = {},
): bigint[] {
  const rows = orm.all<RunningInvocationRow>(sql`SELECT i.id AS id,
      c.host_kind AS host_kind, c.telegram_chat_id AS telegram_chat_id, c.id AS chat_id, c.type AS chat_type
    FROM invocations i
    JOIN conversations v ON v.id = i.conversation_id
    JOIN chats c ON c.id = v.chat_id
    WHERE i.state = 'running'
    ORDER BY i.id`);
  return rows
    .filter((row) => inScope(orm, after, row, options))
    .filter((row) => !(scheduler?.invocationStopping(row.id) ?? false))
    .filter((row) => {
      const target = agentModelKey(orm, after, row);
      const snapshot = scheduler?.invocationSnapshot(row.id);
      const running =
        snapshot === undefined ? agentModelKey(orm, before, row) : agentModelKey(orm, snapshot.config, row);
      return running !== null && running !== target;
    })
    .map((row) => row.id);
}

/**
 * Stops the runs `before` put on a model the active configuration no longer
 * gives them, once the switch is published. Recomputing here rather than
 * reusing a pre-write check also stops a run that started while the file was
 * being written; one that started on the new configuration is left alone.
 *
 * The batches an aborted run consumed close with it and get no reply; batches
 * attached to it but not injected yet go back to the queue, so the new model
 * answers them. Delegated long tasks are not touched.
 */
export function abortInvocationsLeavingModel(
  orm: Orm,
  configStore: RuntimeConfigurationStore,
  scheduler:
    | Pick<BucketScheduler, 'abortInvocations' | 'wake' | 'invocationSnapshot' | 'invocationStopping'>
    | undefined,
  before: RawConfig,
  scope: ModelSwitchScope = {},
): number {
  const after = configStore.current();
  const ids = invocationsLeavingModel(orm, before, after.config, scheduler, scope);
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
