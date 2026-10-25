import {
  assembleRawConfig,
  type FileChat,
  type FileConfig,
  type RawConfig,
  type VisionSectionConfig,
} from './config.ts';
import { ChangeRecorder, classify, deepEqual, mergeField, unionKeys } from './config-diff-merge.ts';
import { mergeProviders } from './config-diff-providers.ts';

/**
 * How a changed configuration path can take effect.
 *
 * - `hot`: applied to the running process by the next reload.
 * - `restart`: saved in the file, but only effective after a restart.
 * - `outside_serve`: `serve` never reads it; the next `backup` run picks it up.
 */
export type ConfigChangeKind = 'hot' | 'restart' | 'outside_serve';

export interface ConfigChange {
  readonly path: string;
  readonly kind: ConfigChangeKind;
}

/** One configuration in both of its layers: the file, and the resolved raw form. */
export interface ConfigSource {
  readonly file: FileConfig;
  readonly raw: RawConfig;
}

export interface ConfigDiff {
  /** Changed paths, deduplicated and sorted. */
  readonly changes: readonly ConfigChange[];
  /** The active configuration with every hot and outside-serve field taken from the file. */
  readonly candidate: ConfigSource;
}

type RawChat = RawConfig['telegram']['chats'][number];

/**
 * Compares a file configuration with the active one and builds the candidate the
 * running process could adopt right now.
 *
 * The candidate keeps every restart-only value from the active configuration and
 * takes every hot and outside-serve value from the file; a field the file no
 * longer carries is dropped when it is hot, and kept when it is restart-only.
 * No I/O happens here: prompt texts come from the two already-loaded raw forms,
 * so a chat and its instructions file can disappear together without failing.
 */
export function diffConfig(active: ConfigSource, file: ConfigSource): ConfigDiff {
  const recorder = new ChangeRecorder();
  const candidateFile = mergeFileConfig(active, file, recorder);
  return {
    changes: recorder.changes(),
    candidate: { file: candidateFile, raw: buildCandidateRaw(active, file, candidateFile) },
  };
}

function mergeFileConfig(active: ConfigSource, file: ConfigSource, recorder: ChangeRecorder): FileConfig {
  const result = structuredClone(active.file);
  const activeRecord = active.file as unknown as Record<string, unknown>;
  const fileRecord = file.file as unknown as Record<string, unknown>;
  const target = result as unknown as Record<string, unknown>;
  for (const key of unionKeys(activeRecord, fileRecord)) {
    if (key === 'telegram' || key === 'providers' || key === 'agent' || key === 'vision') {
      continue;
    }
    mergeField(activeRecord, fileRecord, target, key, key, recorder);
  }
  const mergedTelegram = mergeTelegram(active, file, recorder);
  if (mergedTelegram === undefined) {
    delete result.telegram;
  } else {
    result.telegram = mergedTelegram;
  }
  const mergedVision = mergeVision(active, file, recorder);
  if (mergedVision === undefined) {
    delete result.vision;
  } else {
    result.vision = mergedVision;
  }
  const mergedAgent = mergeAgent(active, file, recorder);
  if (mergedAgent === undefined) {
    delete result.agent;
  } else {
    result.agent = mergedAgent;
  }
  result.providers = mergeProviders(active, file, recorder);
  return result;
}

function mergeTelegram(active: ConfigSource, file: ConfigSource, recorder: ChangeRecorder): FileConfig['telegram'] {
  // The section itself is optional. Both sides merge as empty records, so each
  // field keeps its own classification: the token is hot, everything else stays
  // restart-only, and a section that disappears entirely keeps its restart-only
  // fields until the next start while the token drops immediately.
  const activeRecord = (active.file.telegram ?? {}) as Record<string, unknown>;
  const fileRecord = (file.file.telegram ?? {}) as Record<string, unknown>;
  const result = structuredClone(activeRecord);
  for (const key of unionKeys(activeRecord, fileRecord)) {
    if (key === 'chats') {
      continue;
    }
    // A SecretRef is one value, not a tree of settings: merging its `jar`/`env`/
    // `command` field-by-field would classify the change below the hot path and
    // leave the running process on the previous token until a restart. The whole
    // reference is hot, so replace it as a unit.
    if (key === 'token') {
      const before = activeRecord.token;
      const after = fileRecord.token;
      if (Object.hasOwn(fileRecord, key) === false) {
        delete result.token;
        recorder.add('telegram.token', classify('telegram.token'));
      } else if (Object.hasOwn(activeRecord, key) === false || !deepEqual(before, after)) {
        result.token = structuredClone(after);
        recorder.add('telegram.token', classify('telegram.token'));
      }
      continue;
    }
    mergeField(activeRecord, fileRecord, result, key, `telegram.${key}`, recorder);
  }
  const chats = mergeChats(active, file, recorder);
  if (chats.length > 0 || active.file.telegram !== undefined || file.file.telegram !== undefined) {
    result.chats = chats;
  }
  if (Object.keys(result).length === 0 && file.file.telegram === undefined) {
    return undefined;
  }
  return result as FileConfig['telegram'];
}

function mergeAgent(active: ConfigSource, file: ConfigSource, recorder: ChangeRecorder): FileConfig['agent'] {
  const fileAgent = file.file.agent;
  if (fileAgent === undefined || fileAgent === null) {
    // The section is optional: a missing or null `agent` drops every field the
    // active configuration carried, and each drop is an ordinary hot change.
    for (const key of Object.keys(active.file.agent ?? {})) {
      recorder.add(`agent.${key}`, classify(`agent.${key}`));
    }
    return fileAgent;
  }
  const result = structuredClone(active.file.agent ?? null) ?? {};
  const activeRecord = (active.file.agent ?? {}) as unknown as Record<string, unknown>;
  const fileRecord = fileAgent as unknown as Record<string, unknown>;
  const target = result as unknown as Record<string, unknown>;
  for (const key of unionKeys(activeRecord, fileRecord)) {
    if (key === 'system_prompt_file') {
      const merged = mergeSystemPromptFile(active, file, recorder);
      if (merged === undefined) {
        delete target[key];
      } else {
        target[key] = merged;
      }
      continue;
    }
    mergeField(activeRecord, fileRecord, target, key, `agent.${key}`, recorder);
  }
  return result;
}

/**
 * `vision` is optional like `agent`, but mixes hot and restart-only fields, so a
 * missing or null section merges as an empty one: its hot fields drop and its
 * restart-only fields stay until the restart. Only a section left with nothing
 * takes the file's absent or null form.
 */
function mergeVision(active: ConfigSource, file: ConfigSource, recorder: ChangeRecorder): FileConfig['vision'] {
  const activeRecord = (active.file.vision ?? {}) as Record<string, unknown>;
  const fileRecord = (file.file.vision ?? {}) as Record<string, unknown>;
  const result = structuredClone(activeRecord);
  for (const key of unionKeys(activeRecord, fileRecord)) {
    mergeField(activeRecord, fileRecord, result, key, `vision.${key}`, recorder);
  }
  if (Object.keys(result).length === 0 && (file.file.vision === undefined || file.file.vision === null)) {
    return file.file.vision;
  }
  return result as VisionSectionConfig;
}

/**
 * The prompt file is compared by path and by content: an edited prompt keeps the
 * same path, and a renamed file with the same text is still a change. A
 * configuration without `agent.system_prompt_file` yields `undefined`, which the
 * caller deletes from the candidate rather than storing a present-undefined key.
 */
function mergeSystemPromptFile(active: ConfigSource, file: ConfigSource, recorder: ChangeRecorder): string | undefined {
  const pathChanged = !deepEqual(active.file.agent?.system_prompt_file, file.file.agent?.system_prompt_file);
  const contentChanged = active.raw.agent.system_prompt !== file.raw.agent.system_prompt;
  if (pathChanged || contentChanged) {
    recorder.add('agent.system_prompt_file', 'hot');
  }
  return file.file.agent?.system_prompt_file;
}

function mergeChats(active: ConfigSource, file: ConfigSource, recorder: ChangeRecorder): FileChat[] {
  const activeChats = new Map((active.file.telegram?.chats ?? []).map((chat) => [chat.id, chat]));
  const fileChats = new Map((file.file.telegram?.chats ?? []).map((chat) => [chat.id, chat]));
  const activeRaw = new Map(active.raw.telegram.chats.map((chat) => [chat.id, chat]));
  const fileRaw = new Map(file.raw.telegram.chats.map((chat) => [chat.id, chat]));
  const result: FileChat[] = [];
  for (const [id, chat] of activeChats) {
    const fromFile = fileChats.get(id);
    if (fromFile === undefined) {
      // Removing a chat needs a restart: the allowlist, the participation
      // registry and every conversation row already exist for it.
      recorder.add(`telegram.chats[${id}]`, 'restart');
      result.push(structuredClone(chat));
      continue;
    }
    result.push(mergeChat(chat, fromFile, activeRaw.get(id), fileRaw.get(id), recorder));
  }
  for (const [id, chat] of fileChats) {
    if (!activeChats.has(id)) {
      // Adding a chat is hot: the ingestion allowlist, the participation
      // registry and `resolveChatConfig` all read the published configuration,
      // and a brand-new chat has no stored history to protect. Removal and
      // edits to an existing chat's restart-only fields stay restart-only.
      recorder.add(`telegram.chats[${id}]`, 'hot');
      result.push(structuredClone(chat));
    }
  }
  return result;
}

function mergeChat(
  active: FileChat,
  file: FileChat,
  activeRaw: RawChat | undefined,
  fileRaw: RawChat | undefined,
  recorder: ChangeRecorder,
): FileChat {
  const result = structuredClone(active);
  const activeRecord = active as unknown as Record<string, unknown>;
  const fileRecord = file as unknown as Record<string, unknown>;
  const target = result as unknown as Record<string, unknown>;
  for (const key of unionKeys(activeRecord, fileRecord)) {
    if (key === 'id') {
      continue;
    }
    if (key === 'instructions_file') {
      const path = `telegram.chats[${active.id}].instructions_file`;
      const pathChanged = !deepEqual(active.instructions_file, file.instructions_file);
      const contentChanged = (activeRaw?.instructions ?? '') !== (fileRaw?.instructions ?? '');
      if (pathChanged || contentChanged) {
        recorder.add(path, 'hot');
      }
      if (file.instructions_file === undefined) {
        delete result.instructions_file;
      } else {
        result.instructions_file = file.instructions_file;
      }
      continue;
    }
    if (
      key === 'provider' ||
      key === 'model' ||
      key === 'thinking_level' ||
      key === 'ignored_user_ids' ||
      key === 'dictionary_injection_mode'
    ) {
      const path = `telegram.chats[${active.id}].${key}`;
      const hasFile = Object.hasOwn(fileRecord, key);
      const hasActive = Object.hasOwn(activeRecord, key);
      if (!hasFile) {
        recorder.add(path, 'hot');
        delete target[key];
      } else if (!hasActive) {
        recorder.add(path, 'hot');
        target[key] = fileRecord[key];
      } else if (!deepEqual(activeRecord[key], fileRecord[key])) {
        recorder.add(path, 'hot');
        target[key] = fileRecord[key];
      }
      continue;
    }
    mergeField(activeRecord, fileRecord, target, key, `telegram.chats[${active.id}].${key}`, recorder);
  }
  return result;
}

/**
 * The candidate's raw layer reuses the prompt texts already loaded from both
 * sides — never the disk. A chat that exists only in the active configuration is
 * waiting for a restart, so it keeps its instructions; every other chat takes
 * the text the file just loaded.
 */
function buildCandidateRaw(active: ConfigSource, file: ConfigSource, candidateFile: FileConfig): RawConfig {
  const fileInstructions = new Map(file.raw.telegram.chats.map((chat) => [chat.id, chat.instructions]));
  const activeInstructions = new Map(active.raw.telegram.chats.map((chat) => [chat.id, chat.instructions]));
  const instructions = new Map<number, string>();
  for (const chat of candidateFile.telegram?.chats ?? []) {
    instructions.set(chat.id, fileInstructions.get(chat.id) ?? activeInstructions.get(chat.id) ?? '');
  }
  return assembleRawConfig(candidateFile, file.raw.agent.system_prompt, instructions);
}
