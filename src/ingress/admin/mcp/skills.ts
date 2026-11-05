import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

/** The one skill the MCP server publishes; the standalone fallback has the same source. */
export const MCP_SKILL_NAME = 'surowan-mcp';
const SKILL_ROOT_URI = `skill://${MCP_SKILL_NAME}`;
const MAX_SKILL_FILES = 512;
const MAX_SKILL_BYTES = 16 * 1024 * 1024;

export interface SkillResource {
  readonly uri: string;
  readonly digest: string;
  readonly size: number;
}

export interface SkillEntry {
  readonly uri: string;
  readonly frontmatter: Readonly<Record<string, unknown>> & { readonly name: string; readonly description: string };
  readonly resources: readonly SkillResource[];
}

export interface SkillFile {
  readonly uri: string;
  readonly relativePath: string;
  readonly text: string;
  readonly size: number;
  readonly digest: string;
  readonly mimeType: string;
}

export interface SkillCatalog {
  readonly entries: readonly SkillEntry[];
  readonly files: readonly SkillFile[];
  readonly directories: readonly string[];
}

export const EMPTY_SKILL_CATALOG: SkillCatalog = { entries: [], files: [], directories: [] };

function mimeTypeFor(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith('.md')) {
    return 'text/markdown';
  }
  if (lower.endsWith('.yaml') || lower.endsWith('.yml')) {
    return 'text/yaml';
  }
  if (lower.endsWith('.json')) {
    return 'application/json';
  }
  if (lower.endsWith('.txt')) {
    return 'text/plain';
  }
  return 'application/octet-stream';
}

function parseFrontmatter(text: string, label: string): Record<string, unknown> {
  if (!text.startsWith('---\n')) {
    throw new Error(`${label} is missing frontmatter`);
  }
  const end = text.indexOf('\n---\n', 4);
  if (end < 0) {
    throw new Error(`${label} has unterminated frontmatter`);
  }
  const fields: Record<string, unknown> = {};
  for (const rawLine of text.slice(4, end).split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) {
      continue;
    }
    const separator = line.indexOf(':');
    if (separator <= 0) {
      throw new Error(`${label} has an invalid frontmatter line`);
    }
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    } else if (value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    }
    fields[key] = value;
  }
  return fields;
}

/**
 * Reads a skill directory into the MCP Skills manifest. The manifest is a
 * complete enumeration with digests and sizes, so a client can verify every
 * `resources/read` without a second catalog call.
 */
export async function loadSkillCatalog(root: string): Promise<SkillCatalog> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true }).catch(() => null);
  if (entries === null) {
    return EMPTY_SKILL_CATALOG;
  }
  const paths = entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)).replaceAll('\\', '/'))
    .sort();
  if (paths.length === 0 || paths.length > MAX_SKILL_FILES) {
    return EMPTY_SKILL_CATALOG;
  }
  let total = 0;
  const files: SkillFile[] = [];
  for (const path of paths) {
    const text = await readFile(join(root, path), 'utf8');
    const size = Buffer.byteLength(text);
    total += size;
    if (total > MAX_SKILL_BYTES) {
      return EMPTY_SKILL_CATALOG;
    }
    files.push({
      uri: `${SKILL_ROOT_URI}/${path}`,
      relativePath: path,
      text,
      size,
      digest: `sha256:${createHash('sha256').update(text).digest('hex')}`,
      mimeType: mimeTypeFor(path),
    });
  }
  const skillFile = files.find((file) => file.relativePath === 'SKILL.md');
  if (skillFile === undefined) {
    return EMPTY_SKILL_CATALOG;
  }
  const frontmatter = parseFrontmatter(skillFile.text, skillFile.uri);
  const name = frontmatter.name;
  const description = frontmatter.description;
  if (name !== MCP_SKILL_NAME || typeof description !== 'string' || description.length === 0) {
    return EMPTY_SKILL_CATALOG;
  }
  const directories = new Set<string>([SKILL_ROOT_URI]);
  for (const file of files) {
    const parts = file.relativePath.split('/');
    for (let index = 1; index < parts.length; index += 1) {
      directories.add(`${SKILL_ROOT_URI}/${parts.slice(0, index).join('/')}`);
    }
  }
  return {
    entries: [
      {
        uri: `${SKILL_ROOT_URI}/SKILL.md`,
        frontmatter: { ...frontmatter, name, description },
        resources: files.map((file) => ({ uri: file.uri, digest: file.digest, size: file.size })),
      },
    ],
    files,
    directories: [...directories].sort(),
  };
}

export function skillEntry(catalog: SkillCatalog, uri: string): SkillEntry {
  const entry = catalog.entries.find((candidate) => candidate.uri === uri);
  if (entry === undefined) {
    throw new McpError(ErrorCode.InvalidParams, 'Unknown skill URI');
  }
  return entry;
}

export function skillFile(catalog: SkillCatalog, uri: string): SkillFile {
  const file = catalog.files.find((candidate) => candidate.uri === uri);
  if (file === undefined) {
    throw new McpError(ErrorCode.InvalidParams, 'Unknown resource URI');
  }
  return file;
}

/** Direct children of a skill directory, never recursive. */
export function directoryResources(
  catalog: SkillCatalog,
  uri: string,
): readonly { readonly uri: string; readonly name: string; readonly mimeType: string }[] {
  // The root is published as `skill://surowan-mcp/`; both spellings name one directory.
  const directory = uri.endsWith('/') ? uri.slice(0, -1) : uri;
  if (!catalog.directories.includes(directory)) {
    throw new McpError(ErrorCode.InvalidParams, 'Unknown directory URI');
  }
  const prefix = `${directory}/`;
  const children = new Map<string, { uri: string; name: string; mimeType: string }>();
  for (const file of catalog.files) {
    if (!file.uri.startsWith(prefix)) {
      continue;
    }
    const rest = file.uri.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash < 0) {
      children.set(file.uri, { uri: file.uri, name: rest, mimeType: file.mimeType });
    } else {
      const child = `${prefix}${rest.slice(0, slash)}`;
      children.set(child, { uri: child, name: rest.slice(0, slash), mimeType: 'inode/directory' });
    }
  }
  for (const directory of catalog.directories) {
    if (!directory.startsWith(prefix)) {
      continue;
    }
    const rest = directory.slice(prefix.length);
    if (rest.length > 0 && !rest.includes('/')) {
      children.set(directory, { uri: directory, name: rest, mimeType: 'inode/directory' });
    }
  }
  return [...children.values()].sort((left, right) => left.uri.localeCompare(right.uri));
}
