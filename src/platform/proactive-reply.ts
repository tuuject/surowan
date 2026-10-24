import type { FileChat, ProactiveReplyConfig } from './config.ts';

export interface ProactiveReplySettings {
  readonly enabled: boolean;
  readonly base_probability: number;
  readonly increment: number;
  readonly hard_pity: number;
}

/**
 * Defaults for a configuration that never mentions `proactive_reply`. The
 * feature stays off so upgrading a running deployment cannot silently change
 * how often the bot speaks.
 */
export const PROACTIVE_REPLY_DEFAULTS: ProactiveReplySettings = {
  enabled: false,
  base_probability: 0.2,
  increment: 0.1,
  hard_pity: 8,
};

export interface ProactiveReplyScope {
  readonly telegram?: {
    readonly proactive_reply?: ProactiveReplyConfig;
  };
}

/**
 * Merges the global section with one Chat's overrides field by field. Unlike
 * participation windows there is no list to replace wholesale, so an override
 * only has to mention the values it changes.
 */
export function resolveProactiveReply(
  config: ProactiveReplyScope,
  chat?: Pick<FileChat, 'proactive_reply'>,
): ProactiveReplySettings {
  const global: ProactiveReplyConfig | undefined = config.telegram?.proactive_reply;
  const local: ProactiveReplyConfig | undefined = chat?.proactive_reply;
  return {
    enabled: local?.enabled ?? global?.enabled ?? PROACTIVE_REPLY_DEFAULTS.enabled,
    base_probability: local?.base_probability ?? global?.base_probability ?? PROACTIVE_REPLY_DEFAULTS.base_probability,
    increment: local?.increment ?? global?.increment ?? PROACTIVE_REPLY_DEFAULTS.increment,
    hard_pity: local?.hard_pity ?? global?.hard_pity ?? PROACTIVE_REPLY_DEFAULTS.hard_pity,
  };
}

/** Identity of one numeric parameter set; a change resets the pity counter. */
export function proactiveReplyFingerprint(settings: ProactiveReplySettings): string {
  return JSON.stringify([settings.base_probability, settings.increment, settings.hard_pity]);
}

/**
 * Probability of the given attempt (1-based). `hard_pity` is a guarantee, not
 * just another increment: the configured attempt always hits even when the
 * arithmetic would still be below 1.
 */
export function proactiveReplyProbability(attempt: number, settings: ProactiveReplySettings): number {
  if (attempt >= settings.hard_pity) {
    return 1;
  }
  return Math.min(1, Math.max(0, settings.base_probability + Math.max(0, attempt - 1) * settings.increment));
}

export interface ProactiveReplySample {
  /** 1-based attempt this sample represents. */
  readonly attempt: number;
  readonly probability: number;
  readonly hit: boolean;
  /** True when the hit came from the hard-pity guarantee rather than the roll. */
  readonly pity: boolean;
}

export function sampleProactiveReply(
  consecutiveMisses: number,
  settings: ProactiveReplySettings,
  random: () => number,
): ProactiveReplySample {
  const attempt = Math.max(0, Math.trunc(consecutiveMisses)) + 1;
  const probability = proactiveReplyProbability(attempt, settings);
  const pity = attempt >= settings.hard_pity;
  return {
    attempt,
    probability,
    hit: pity || random() < probability,
    pity,
  };
}
