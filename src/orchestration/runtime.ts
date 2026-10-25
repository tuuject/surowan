import { HOST_KINDS, type HostKind } from '../platform/im-host.ts';
import { LongTaskService } from '../store/long-tasks.ts';
import type { WarningService } from '../store/warnings.ts';
import { AgentRuntime } from './agent-runtime.ts';
import type { AgentRuntimeOptions } from './agent-runtime-types.ts';
import { ConversationRuntime } from './conversation-runtime.ts';
import { everyHostReady, type HostReadiness } from './host-scope.ts';
import { BucketScheduler } from './scheduler.ts';

/** Prepared host dependencies only: no file loading, transport or process lifecycle. */
export interface CoreRuntimeOptions extends Omit<AgentRuntimeOptions, 'conversationRuntime'> {
  readonly tasks?: LongTaskService;
  /** Receives terminal invocation samples; absent in tests that do not assert warnings. */
  readonly warnings?: WarningService;
  /** Whether one host may execute work right now; every host by default. */
  readonly isHostReady?: HostReadiness;
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
  // The scheduler's scope is the set of hosts this runtime is bound to: it must
  // never launch, recover or wait on work of a host the process does not carry.
  // A scope covering every bound host is the same as no scope.
  const hosts = Object.keys(options.hosts) as HostKind[];
  const tasks = options.tasks ?? new LongTaskService(options.store.orm, () => scheduler?.wake(), hosts);
  // The scheduler completes timers through `tasks` before it filters receipts,
  // so a task service with a wider scope would complete foreign timers.
  if (!sameHostScope(tasks.hosts, hosts)) {
    throw new Error('the long-task service must serve exactly the hosts this runtime binds');
  }
  // `tasks` belongs to the scheduler; AgentRuntime has no such option.
  const { tasks: _tasks, warnings, isHostReady, ...agentOptions } = options;
  const runtime = new AgentRuntime({ ...agentOptions, conversationRuntime });
  scheduler = new BucketScheduler(
    options.store,
    options.configStore,
    (invocationId, snapshot, signal) => runtime.run(invocationId, snapshot, signal),
    conversationRuntime,
    tasks,
    { bot: options.bot },
    hosts,
    warnings,
    isHostReady ?? everyHostReady,
  );
  return { runtime, scheduler, conversationRuntime, tasks };
}

export type CoreRuntime = ReturnType<typeof createCoreRuntime>;

function sameHostScope(left: readonly HostKind[] | undefined, right: readonly HostKind[]): boolean {
  const covered = (scope: readonly HostKind[] | undefined) =>
    HOST_KINDS.filter((host) => scope === undefined || scope.length === 0 || scope.includes(host)).join(',');
  return covered(left) === covered(right);
}
