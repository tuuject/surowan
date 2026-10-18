import type { HostKind } from '../platform/im-host.ts';
import { LongTaskService } from '../store/long-tasks.ts';
import { AgentRuntime, type AgentRuntimeOptions } from './agent-runtime.ts';
import { ConversationRuntime } from './conversation-runtime.ts';
import { BucketScheduler } from './scheduler.ts';

/** Prepared host dependencies only: no file loading, transport or process lifecycle. */
export interface CoreRuntimeOptions extends Omit<AgentRuntimeOptions, 'conversationRuntime'> {
  readonly tasks?: LongTaskService;
}

/**
 * Assemble the shared agent/scheduler semantics without starting background work.
 * Hosts own initialization, scheduler start/stop and dependency disposal.
 */
export function createCoreRuntime(options: CoreRuntimeOptions) {
  const conversationRuntime = new ConversationRuntime({
    agentCacheSize: () => options.configStore.current().config.agent.context.agent_cache_size,
  });
  let scheduler: BucketScheduler | undefined;
  const tasks = options.tasks ?? new LongTaskService(options.store.orm, () => scheduler?.wake());
  // The scheduler's scope is the set of hosts this runtime is bound to: it must
  // never launch, recover or wait on work of a host the process does not carry.
  // A scope covering every bound host is the same as no scope.
  const hosts = Object.keys(options.hosts) as HostKind[];
  // `tasks` belongs to the scheduler; AgentRuntime has no such option.
  const { tasks: _tasks, ...agentOptions } = options;
  const runtime = new AgentRuntime({ ...agentOptions, conversationRuntime });
  scheduler = new BucketScheduler(
    options.store,
    options.configStore,
    (invocationId, snapshot, signal) => runtime.run(invocationId, snapshot, signal),
    conversationRuntime,
    tasks,
    { bot: options.bot },
    hosts,
  );
  return { runtime, scheduler, conversationRuntime, tasks };
}

export type CoreRuntime = ReturnType<typeof createCoreRuntime>;
