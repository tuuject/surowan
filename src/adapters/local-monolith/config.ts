import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { type ParseError, parse as parseJsonc, printParseErrorCode } from 'jsonc-parser';
import { type FileConfig, type RawConfig, assembleRawConfig } from '../../platform/config.ts';
import type { PersistedConfig } from '../../platform/config-write.ts';
import { stripHtmlComments } from '../../platform/prompt-markdown.ts';
import { validatePromptTemplate } from '../../platform/prompt-template.ts';
import { validateFileConfig } from '../../platform/config-validate.ts';

export interface LoadedConfig extends PersistedConfig {
  readonly configPath: string;
  /**
   * Soft-failure notices. Today only the image section degrades: a structurally
   * invalid block is stripped (so the process starts with image generation
   * disabled) and its schema errors are reported here instead of thrown.
   */
  readonly warnings: readonly string[];
}

function describeOffset(source: string, offset: number): string {
  let line = 0;
  let lineStart = 0;
  for (let index = 0; index < offset && index < source.length; index += 1) {
    if (source.charCodeAt(index) === 0x0a) {
      line += 1;
      lineStart = index + 1;
    }
  }
  return `line ${line + 1}, column ${offset - lineStart + 1}`;
}

export async function loadConfig(path: string): Promise<LoadedConfig> {
  const configPath = resolve(path);
  const text = await readFile(configPath, 'utf8');
  // jsonc-parser records a UTF-8 BOM as an invalid symbol, so strip it before
  // parsing. The hash below still covers the raw text.
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const parseErrors: ParseError[] = [];
  const parsed = parseJsonc(source, parseErrors, { allowTrailingComma: true }) as unknown;
  if (parsed === undefined || parseErrors.length > 0) {
    const details = parseErrors
      .slice(0, 10)
      .map((error) => `${printParseErrorCode(error.error)} at ${describeOffset(source, error.offset)}`)
      .join('; ');
    throw new Error(`Invalid JSONC: ${details || 'empty document'}`);
  }
  const { fileConfig: validated, warnings } = validateFileConfig(parsed);
  const { config, promptFiles } = await resolvePrompts(validated, dirname(configPath));
  const hash = createHash('sha256');
  hash.update(text);
  for (const file of promptFiles) {
    hash.update(`\u0000${file.content}`);
  }
  return { config, fileConfig: validated, configPath, hash: hash.digest('hex'), warnings };
}

interface PromptFile {
  readonly content: string;
}

async function resolvePrompts(
  fileConfig: FileConfig,
  directory: string,
): Promise<{ config: RawConfig; promptFiles: PromptFile[] }> {
  const promptFiles: PromptFile[] = [];
  // Without a system_prompt_file the runtime prompt is empty: the core protocol
  // is baked into code, so an unconfigured agent still has a legal (and unused,
  // since no invocation can start) prompt.
  const systemPromptFile = fileConfig.agent?.system_prompt_file;
  const systemPrompt =
    systemPromptFile === undefined
      ? ''
      : await readPromptFile(resolve(directory, systemPromptFile), 'agent.system_prompt_file', promptFiles);
  if (systemPromptFile !== undefined) {
    if (systemPrompt.length === 0) {
      throw new Error(`agent.system_prompt_file is empty or contains only HTML comments: ${systemPromptFile}`);
    }
    validatePromptTemplate(systemPrompt, 'agent.system_prompt_file');
  }
  const instructionsByChatId = new Map<number, string>();
  for (const chat of fileConfig.telegram?.chats ?? []) {
    const instructions =
      chat.instructions_file === undefined
        ? ''
        : await readPromptFile(
            resolve(directory, chat.instructions_file),
            `chat ${chat.id} instructions_file`,
            promptFiles,
          );
    validatePromptTemplate(instructions, `chat ${chat.id} instructions_file`);
    instructionsByChatId.set(chat.id, instructions);
  }
  return { promptFiles, config: assembleRawConfig(fileConfig, systemPrompt, instructionsByChatId) };
}

async function readPromptFile(path: string, label: string, sink: PromptFile[]): Promise<string> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    throw new Error(`Cannot read ${label} file ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  // A UTF-8 BOM must not reach the prompt text; the hash still covers the raw
  // bytes.
  if (raw.charCodeAt(0) === 0xfeff) {
    raw = raw.slice(1);
  }
  if (raw.includes('\u0000')) {
    throw new Error(`${label} file ${path} contains a NUL character`);
  }
  // The hash keeps covering the raw file, so a comment-only edit still changes
  // config_hash; the prompt itself sees only the text outside HTML comments.
  sink.push({ content: raw });
  return stripHtmlComments(raw);
}

export async function assertConfigPermissions(configPath: string): Promise<void> {
  if (process.platform === 'win32') {
    return;
  }
  const file = await stat(configPath);
  const parent = await stat(resolve(configPath, '..'));
  if ((file.mode & 0o777) !== 0o600) {
    throw new Error(`Config must have mode 0600: ${configPath}`);
  }
  if ((parent.mode & 0o777) !== 0o700) {
    throw new Error(`Config parent must have mode 0700: ${resolve(configPath, '..')}`);
  }
}
