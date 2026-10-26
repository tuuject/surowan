import { createHash, randomBytes } from 'node:crypto';
import { lstat, open, readFile, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { applyEdits, findNodeAtLocation, type JSONPath, modify, parse, parseTree } from 'jsonc-parser';
import { assertConfigPermissions, type LoadedConfig, loadConfig } from './index.ts';
import type { ConfigEdit } from '../../../platform/config/write.ts';
import { TELEGRAM_DEFAULTS } from '../../../platform/config/resolve.ts';
import { keyJarPath, referencedJarNames, updateKeyJar } from '../../../platform/key-jar.ts';
import type { SearchProviderRule } from '../../../platform/web-search.ts';

export type ConfigWriteErrorCode =
  | 'config_symlink'
  | 'config_permissions'
  | 'config_invalid'
  | 'config_write_failed'
  | 'config_conflict';

/** A failed configuration write, carrying the code the API reports. */
export class ConfigWriteError extends Error {
  readonly code: ConfigWriteErrorCode;

  constructor(code: ConfigWriteErrorCode, message: string) {
    super(message);
    this.name = 'ConfigWriteError';
    this.code = code;
  }
}

/**
 * Identity of the configuration file's own bytes. Prompt files are excluded, so
 * a panel can compare this against the revision it last read and detect a
 * concurrent edit without also invalidating on an unrelated prompt change.
 */
export async function readConfigRevision(configPath: string): Promise<string> {
  const source = await readFile(resolve(configPath));
  return createHash('sha256').update(source).digest('hex');
}

const FORMATTING = { insertSpaces: true, tabSize: 2 } as const;

/**
 * `modify` cannot add a property under a `null` node, and an optional section
 * such as `agent` may be written as `null`: each such parent becomes `{}` first.
 */
function replaceNullParents(text: string, path: JSONPath): string {
  let result = text;
  for (let depth = 1; depth < path.length; depth += 1) {
    const prefix = path.slice(0, depth);
    const tree = parseTree(result, [], { allowTrailingComma: true });
    if (tree !== undefined && findNodeAtLocation(tree, prefix)?.type === 'null') {
      result = applyEdits(result, modify(result, prefix, {}, { formattingOptions: FORMATTING }));
    }
  }
  return result;
}

/**
 * Applies value edits to the configuration file, keeping its comments and
 * formatting.
 *
 * The write is validated before it becomes visible: the edited text goes to a
 * sibling temporary file, `loadConfig` must accept it, and only then is it
 * renamed over the original. A reader therefore sees either the old file or a
 * fully valid new one, and a rejected edit never touches the file at all.
 *
 * `expectedRevision` makes the write conditional: the file is hashed right after
 * it is read and the edit is refused with `config_conflict` when the caller's
 * revision is stale. Panel writes are already serialized by `ConfigReloader`, so
 * the remaining window between that comparison and the rename only matters for
 * hand edits landing in the same instant.
 *
 * Key jar entries carried by the edits are added before the rename, so the new
 * file never names a missing entry, and the entries the new file no longer
 * references are removed after it, so the old file never does either.
 */
export async function writeConfigEdits(
  configPath: string,
  edits: readonly ConfigEdit[],
  expectedRevision?: string,
  options: { readonly searchProviders?: readonly SearchProviderRule[] } = {},
): Promise<void> {
  const target = resolve(configPath);
  await assertWritableTarget(target);
  let source: string;
  try {
    source = await readFile(target, 'utf8');
  } catch (error) {
    throw new ConfigWriteError('config_write_failed', describe('Cannot read config', error));
  }
  if (expectedRevision !== undefined) {
    const current = createHash('sha256').update(Buffer.from(source, 'utf8')).digest('hex');
    if (current !== expectedRevision) {
      throw new ConfigWriteError(
        'config_conflict',
        'The configuration file changed since it was read; reload the panel and try again',
      );
    }
  }
  const bom = source.charCodeAt(0) === 0xfeff;
  let text = bom ? source.slice(1) : source;
  const parsedSource = parse(text, [], { allowTrailingComma: true });
  const previouslyReferenced = referencedJarNames(parsedSource);
  const added: Record<string, string> = {};
  if (createsTelegramSection(parsedSource, edits)) {
    // The section's scalars have no schema defaults, so creating it lazily with
    // only e.g. `chats[0]` would write a file `loadConfig` rejects. Every write
    // that reaches below `telegram` starts from the same defaults.
    text = applyEdits(
      text,
      modify(text, ['telegram'], { ...TELEGRAM_DEFAULTS, chats: [] }, { formattingOptions: FORMATTING }),
    );
  }
  for (const edit of edits) {
    Object.assign(added, edit.keys);
    if (edit.value !== undefined) {
      text = replaceNullParents(text, edit.path);
    }
    const valueEdits = modify(text, edit.path, edit.value, { formattingOptions: FORMATTING });
    if (valueEdits.length === 0) {
      throw new ConfigWriteError('config_write_failed', `Config edit changed nothing: ${edit.path.join('.')}`);
    }
    text = applyEdits(text, valueEdits);
  }
  const temporary = temporaryPath(target);
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(bom ? `\ufeff${text}` : text, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    await removeQuietly(temporary);
    throw new ConfigWriteError('config_write_failed', describe('Cannot write config', error));
  }
  let written: LoadedConfig;
  try {
    // Prompt paths resolve against the containing directory, so this is the same
    // validation the next `serve` would run.
    written = await loadConfig(temporary, {
      ...(options.searchProviders === undefined ? {} : { searchProviders: options.searchProviders }),
    });
  } catch (error) {
    await removeQuietly(temporary);
    throw new ConfigWriteError('config_invalid', describe('Edited config is invalid', error));
  }
  const jar = keyJarPath(target);
  const addedNames = Object.keys(added);
  if (addedNames.length > 0) {
    try {
      await updateKeyJar(jar, { add: added });
    } catch (error) {
      await removeQuietly(temporary);
      throw new ConfigWriteError('config_write_failed', describe('Cannot write key jar', error));
    }
  }
  try {
    await rename(temporary, target);
  } catch (error) {
    await removeQuietly(temporary);
    if (addedNames.length > 0) {
      await updateKeyJar(jar, { remove: addedNames }).catch(() => undefined);
    }
    throw new ConfigWriteError('config_write_failed', describe('Cannot replace config', error));
  }
  const stillReferenced = referencedJarNames(written.fileConfig);
  const released = [...previouslyReferenced].filter((name) => !stillReferenced.has(name));
  if (released.length > 0) {
    // The new file is in place and the edit succeeded; an entry left behind only
    // keeps a secret nothing uses, which is not worth reporting a failed write.
    await updateKeyJar(jar, { remove: released }).catch(() => undefined);
  }
}

async function assertWritableTarget(configPath: string): Promise<void> {
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(configPath);
  } catch (error) {
    throw new ConfigWriteError('config_write_failed', describe('Cannot stat config', error));
  }
  if (info.isSymbolicLink()) {
    // The rename below replaces the link itself with a regular file, which would
    // silently detach the configuration the operator thinks they are editing.
    throw new ConfigWriteError('config_symlink', `Config must not be a symbolic link: ${configPath}`);
  }
  try {
    await assertConfigPermissions(configPath);
  } catch (error) {
    throw new ConfigWriteError('config_permissions', describe('Config permissions', error));
  }
}

/**
 * Whether these edits would add a key under a missing `telegram` section. Such
 * a write creates the section from `TELEGRAM_DEFAULTS` first, so the schema's
 * required scalars are always present.
 */
function createsTelegramSection(parsed: unknown, edits: readonly ConfigEdit[]): boolean {
  const root = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : undefined;
  if (root !== undefined && 'telegram' in root && root.telegram !== null && root.telegram !== undefined) {
    return false;
  }
  return edits.some((edit) => edit.path[0] === 'telegram' && edit.path.length > 1 && edit.value !== undefined);
}

function temporaryPath(configPath: string): string {
  return join(dirname(configPath), `.${basename(configPath)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
}

async function removeQuietly(path: string): Promise<void> {
  await unlink(path).catch(() => undefined);
}

function describe(context: string, error: unknown): string {
  return `${context}: ${error instanceof Error ? error.message : String(error)}`;
}
