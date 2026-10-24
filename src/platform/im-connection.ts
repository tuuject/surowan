/**
 * Process-local connection state for every instant-messaging integration.
 *
 * The registry is deliberately transport-neutral: a namespace is an IM host
 * kind (`telegram` today, `discord`/`whatsapp`/`slack` later), and nothing in
 * here knows how a connection is established. State lives only in memory: a
 * restarted process derives it again, and there is no ledger to migrate.
 */

import type { HostKind } from './im-host.ts';

/** The IM integrations a process may hold a connection for. */
export type ImNamespace = Exclude<HostKind, 'playground'>;

export type ImConnectionStatus = 'disabled' | 'connected' | 'network_error' | 'config_error';

/** Why an IM connection is unusable because of its configuration. */
export type ImConnectionConfigError = 'unauthorized' | 'conflict' | 'token_unreadable';

/** The identity the IM service last reported for itself. */
export interface ImConnectionBot {
  readonly id: string;
  readonly username: string | null;
}

interface ImConnectionCommon {
  /** When this state was entered, as a canonical ISO-8601 timestamp. */
  readonly since: string;
  /** The last identity known for this namespace, when one was ever obtained. */
  readonly bot?: ImConnectionBot;
}

export type ImConnectionState =
  | (ImConnectionCommon & { readonly status: 'disabled' })
  | (ImConnectionCommon & { readonly status: 'connected'; readonly bot: ImConnectionBot })
  | (ImConnectionCommon & { readonly status: 'network_error' })
  | (ImConnectionCommon & { readonly status: 'config_error'; readonly reason: ImConnectionConfigError });

/**
 * One state slot per IM namespace. A namespace that was never registered is
 * disabled: the process starts with no connection until something opens one.
 */
export class ImConnectionRegistry {
  readonly #states = new Map<ImNamespace, ImConnectionState>();
  readonly #startedAt: string;

  constructor(now: () => Date = () => new Date()) {
    this.#startedAt = now().toISOString();
  }

  get(namespace: ImNamespace): ImConnectionState {
    return this.#states.get(namespace) ?? { status: 'disabled', since: this.#startedAt };
  }

  set(namespace: ImNamespace, state: ImConnectionState): void {
    this.#states.set(namespace, state);
  }

  botOf(namespace: ImNamespace): ImConnectionBot | undefined {
    return this.#states.get(namespace)?.bot;
  }

  /**
   * Whether this namespace may execute work right now. A connection is ready
   * once it has an identity and is either healthy or merely suffering network
   * errors: a network-error instance keeps running, so the Scheduler still
   * lets its conversations start.
   */
  isReady(namespace: ImNamespace): boolean {
    const state = this.#states.get(namespace);
    if (state === undefined || state.bot === undefined) {
      return false;
    }
    return state.status === 'connected' || state.status === 'network_error';
  }
}
