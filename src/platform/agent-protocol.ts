import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const AGENT_PROMPT_VERSION = 11n;

const PROMPTS_DIR = join(import.meta.dirname, 'prompts');

/**
 * Built-in system prompt partitions shipped with the runtime and read once at
 * startup. Anything that varies per invocation belongs in the injected batch
 * instead, because a change here rebuilds every Conversation Context.
 */
export const CORE_AGENT_PROTOCOL = readFileSync(join(PROMPTS_DIR, 'core-protocol.md'), 'utf8').trim();
export const CAPABILITIES_PROMPT = readFileSync(join(PROMPTS_DIR, 'capabilities.md'), 'utf8').trim();
export const PERSONA_PROMPT = readFileSync(join(PROMPTS_DIR, 'persona.md'), 'utf8').trim();
