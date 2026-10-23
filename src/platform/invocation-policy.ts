/**
 * The policy an invocation runs under, resolved once and then fixed.
 *
 * Core code used to reach into `config.telegram` directly: the context builder
 * and the agent runtime resolved the chat entry by Telegram chat id, and the
 * scheduler read the debounce window from the live config while finalising a
 * run. That only works for one host, because a Playground room has no Telegram
 * chat id and no `telegram.chats` entry to resolve.
 *
 * A policy names the host explicitly and carries the pieces an invocation
 * needs (agent settings, timezone, debounce window, gate key). Resolving it is
 * the only place that decides how a host maps to those pieces, so callers do
 * not have to know whether they are looking at a Telegram chat or a room.
 */
import type { RawConfig } from './config.ts';
import type { HostKind } from './im-host.ts';
import { resolveChatConfig, type Orm } from '../store/store.ts';
import { resolveAgentSettings } from './config-resolve.ts';

/** The resolved agent settings for one scope. */
export type InvocationAgentSettings = ReturnType<typeof resolveAgentSettings>;

/** The chat a policy belongs to, as core sees it. */
export interface InvocationScope {
  readonly hostKind: HostKind;
  /**
   * The host's chat id: the Telegram chat id for Telegram, the internal chat
   * id for a Playground room. It is never used as another host's id.
   */
  readonly chatId: bigint;
  readonly chatType: string;
}

export interface InvocationPolicy {
  readonly hostKind: HostKind;
  readonly chatId: bigint;
  readonly chatType: string;
  readonly agent: InvocationAgentSettings;
  readonly timezone: string;
  /**
   * The debounce window this host's batches collect. Rooms are sealed when
   * their input is released, so they collect nothing.
   */
  readonly bucketWindowSeconds: number;
  /** Instructions the chat entry contributes, empty when it has none. */
  readonly instructions: string;
  /** The model gate key: host first, so equal ids never share a gate. */
  readonly gateKey: string;
}

/**
 * The model gate key for a scope.
 *
 * Telegram chat ids and internal chat ids are drawn from different sequences,
 * so an unqualified id can make a room and a Telegram chat share a gate. The
 * host prefix keeps them apart while leaving every Telegram run on one key.
 */
export function invocationGateKey(hostKind: HostKind, chatId: bigint): string {
  return `${hostKind}:${chatId}`;
}

/**
 * The debounce window a host collects its batches with.
 *
 * Telegram keeps the configured window; a room is sealed when its input is
 * released, so it collects nothing.
 */
export function resolveBucketWindowSeconds(config: RawConfig, hostKind: HostKind): number {
  return hostKind === 'telegram' ? config.telegram.bucket_window_seconds : 0;
}

/** The Telegram chat entry for a scope, or undefined when it is not Telegram. */
export function invocationChatEntry(
  config: RawConfig,
  orm: Orm,
  scope: InvocationScope,
): RawConfig['telegram']['chats'][number] | undefined {
  if (scope.hostKind !== 'telegram') {
    return undefined;
  }
  return resolveChatConfig(config, orm, scope.chatId);
}

/**
 * Resolve the policy for a scope.
 *
 * Telegram keeps its original behaviour: the chat entry decides the agent and
 * timezone, and the missing-entry error stays exactly as it was. A room has no
 * chat entry, so it uses the configured agent defaults, the global timezone,
 * and no debounce window.
 */
export function resolveInvocationPolicy(config: RawConfig, orm: Orm, scope: InvocationScope): InvocationPolicy {
  const chat = invocationChatEntry(config, orm, scope);
  if (scope.hostKind === 'telegram' && chat === undefined) {
    throw new Error(`Invocation chat ${scope.chatId} is no longer configured`);
  }
  return {
    hostKind: scope.hostKind,
    chatId: scope.chatId,
    chatType: scope.chatType,
    agent: resolveAgentSettings(config, chat),
    timezone: chat?.timezone ?? config.timezone,
    bucketWindowSeconds: resolveBucketWindowSeconds(config, scope.hostKind),
    instructions: chat?.instructions ?? '',
    gateKey: invocationGateKey(scope.hostKind, scope.chatId),
  };
}
