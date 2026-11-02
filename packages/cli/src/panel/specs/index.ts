import { AUDIT_SPECS } from './audit.ts';
import { AUTH_SPECS } from './auth.ts';
import { CHAT_SPECS } from './chats.ts';
import { CONTROL_SPECS } from './control.ts';
import { DICTIONARY_SPECS } from './dictionary.ts';
import { IMAGE_SPECS } from './image.ts';
import { MEMORY_SPECS } from './memory.ts';
import { PLAYGROUND_SPECS } from './playground.ts';
import { PROMPT_SPECS } from './prompts.ts';
import { PROVIDER_SPECS } from './providers.ts';
import { SEARCH_SPECS } from './search.ts';
import { ADMIN_SPECS, TELEGRAM_SPECS, WARNING_SPECS } from './settings.ts';
import { TUNING_SPECS } from './tuning.ts';
import type { EndpointSpec } from '../types.ts';

/**
 * Every Admin Panel operation, as data. The panel's `/api` dispatch is the
 * source of truth; a route added there belongs here too, and `commands` lists
 * whatever is registered so the surface stays auditable.
 */
export const PANEL_SPECS: readonly EndpointSpec[] = [
  ...AUDIT_SPECS,
  ...AUTH_SPECS,
  ...CONTROL_SPECS,
  ...TUNING_SPECS,
  ...DICTIONARY_SPECS,
  ...PROVIDER_SPECS,
  ...CHAT_SPECS,
  ...PROMPT_SPECS,
  ...SEARCH_SPECS,
  ...IMAGE_SPECS,
  ...MEMORY_SPECS,
  ...TELEGRAM_SPECS,
  ...WARNING_SPECS,
  ...ADMIN_SPECS,
  ...PLAYGROUND_SPECS,
];

const BY_COMMAND = new Map(PANEL_SPECS.map((spec) => [spec.command, spec]));

/** The longest-match command lookup, so `prompt save` wins over `prompt`. */
export function findPanelSpec(
  words: readonly string[],
): { readonly spec: EndpointSpec; readonly rest: readonly string[] } | undefined {
  for (let length = words.length; length > 0; length -= 1) {
    const spec = BY_COMMAND.get(words.slice(0, length).join(' '));
    if (spec !== undefined) {
      return { spec, rest: words.slice(length) };
    }
  }
  return undefined;
}

/** Command words that share a first word, for a targeted "did you mean" list. */
export function panelCommandsStartingWith(prefix: string): readonly string[] {
  return PANEL_SPECS.map((spec) => spec.command).filter((command) => command.startsWith(`${prefix} `));
}
