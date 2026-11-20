/**
 * Skill discovery for the "MCP with Skills" extension: the client side of
 * `skills/list` plus `resources/read`, with every file verified.
 *
 * A server's skills are untrusted data. Nothing here is trusted to describe
 * itself honestly, so a skill only survives when its manifest is well formed,
 * stays inside its own root and inside the bounds below, and every file it
 * lists reads back as text whose UTF-8 size and sha256 match the manifest. A
 * bad skill is dropped alone; discovery never throws, because a server's
 * skills must never cost the connection its tools.
 */
import { createHash } from 'node:crypto';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { z } from 'zod';
import type { McpSkill } from './support.ts';

export const SKILLS_EXTENSION = 'io.modelcontextprotocol/skills';

export const MAX_SKILLS_PER_SERVER = 32;
export const MAX_FILES_PER_SKILL = 64;
export const MAX_FILE_BYTES = 32_768;
export const MAX_SERVER_SKILL_BYTES = 1_048_576;
const MAX_LIST_PAGES = 8;
const MAX_DESCRIPTION_CHARACTERS = 1_000;
/** One request, and the whole discovery, each get their own bound. */
const REQUEST_TIMEOUT_MS = 10_000;
const DISCOVERY_TIMEOUT_MS = 30_000;

/** The same shape system resources use for one path segment. */
export const SKILL_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const SkillEntrySchema = z.looseObject({
  uri: z.string(),
  frontmatter: z.looseObject({ name: z.string(), description: z.string() }),
  resources: z.array(z.looseObject({ uri: z.string(), digest: z.string(), size: z.number().int().nonnegative() })),
});
const SkillsListResultSchema = z.looseObject({
  skills: z.array(z.unknown()),
  nextCursor: z.string().optional(),
});

export interface SkillsDiscovery {
  readonly skills: readonly McpSkill[];
  /** The first problem met, as a short code; `null` when discovery was clean. */
  readonly error: string | null;
}

const NONE: SkillsDiscovery = { skills: [], error: null };

/** Why one skill was dropped; the code is what the panel shows. */
class SkillRejected extends Error {}

/** Whether the connected server advertised the skills extension. */
export function advertisesSkills(client: Client): boolean {
  return client.getServerCapabilities()?.extensions?.[SKILLS_EXTENSION] !== undefined;
}

export async function discoverSkills(client: Client, attemptSignal: AbortSignal): Promise<SkillsDiscovery> {
  if (!advertisesSkills(client)) {
    return NONE;
  }
  // Skill files travel through `resources/read`; without it nothing could be
  // verified, and a strict client would refuse the call anyway.
  if (client.getServerCapabilities()?.resources === undefined) {
    return { skills: [], error: 'skills_resources_unsupported' };
  }
  const signal = AbortSignal.any([attemptSignal, AbortSignal.timeout(DISCOVERY_TIMEOUT_MS)]);
  let entries: z.infer<typeof SkillEntrySchema>[];
  let error: string | null = null;
  try {
    const listed = await listEntries(client, signal);
    entries = listed.entries;
    error = listed.error;
  } catch {
    return { skills: [], error: 'skills_list_failed' };
  }
  const skills: McpSkill[] = [];
  const names = new Set<string>();
  let remainingBytes = MAX_SERVER_SKILL_BYTES;
  for (const entry of entries) {
    // A later duplicate is skipped before any of its files are fetched.
    if (names.has(entry.frontmatter.name)) {
      continue;
    }
    try {
      const skill = await verifySkill(client, entry, remainingBytes, signal);
      names.add(skill.name);
      remainingBytes -= skill.totalBytes;
      skills.push(skill);
    } catch (failure) {
      error ??= failure instanceof SkillRejected ? failure.message : 'skill_read_failed';
    }
  }
  return { skills, error };
}

async function listEntries(
  client: Client,
  signal: AbortSignal,
): Promise<{ entries: z.infer<typeof SkillEntrySchema>[]; error: string | null }> {
  const entries: z.infer<typeof SkillEntrySchema>[] = [];
  let error: string | null = null;
  let cursor: string | undefined;
  for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
    const result = await client.request(
      { method: 'skills/list', params: cursor === undefined ? {} : { cursor } },
      SkillsListResultSchema,
      { signal, timeout: REQUEST_TIMEOUT_MS },
    );
    for (const raw of result.skills) {
      const parsed = SkillEntrySchema.safeParse(raw);
      if (!parsed.success) {
        error ??= 'skill_manifest_invalid';
      } else if (entries.length < MAX_SKILLS_PER_SERVER) {
        entries.push(parsed.data);
      } else {
        error ??= 'skills_limit_exceeded';
      }
    }
    cursor = result.nextCursor;
    if (cursor === undefined || cursor.length === 0) {
      return { entries, error };
    }
  }
  return { entries, error: error ?? 'skills_limit_exceeded' };
}

/**
 * Maps one manifest entry to a skill whose files are all verified. The skill
 * root is the entry's own URI without its trailing `SKILL.md`; a resource
 * outside that root, or with a path segment a model-facing URI cannot carry,
 * invalidates the whole skill.
 */
async function verifySkill(
  client: Client,
  entry: z.infer<typeof SkillEntrySchema>,
  remainingBytes: number,
  signal: AbortSignal,
): Promise<McpSkill> {
  const name = entry.frontmatter.name;
  const description = entry.frontmatter.description.trim();
  if (!SKILL_SEGMENT_PATTERN.test(name) || description.length === 0) {
    throw new SkillRejected('skill_manifest_invalid');
  }
  const suffix = 'SKILL.md';
  if (!entry.uri.endsWith(`/${suffix}`)) {
    throw new SkillRejected('skill_manifest_invalid');
  }
  const root = entry.uri.slice(0, entry.uri.length - suffix.length);
  if (entry.resources.length > MAX_FILES_PER_SKILL) {
    throw new SkillRejected('skills_limit_exceeded');
  }
  const paths = new Map<string, z.infer<typeof SkillEntrySchema>['resources'][number]>();
  for (const resource of entry.resources) {
    if (!resource.uri.startsWith(root) || resource.uri.length === root.length) {
      throw new SkillRejected('skill_manifest_invalid');
    }
    const path = resource.uri.slice(root.length);
    if (!path.split('/').every((segment) => SKILL_SEGMENT_PATTERN.test(segment)) || paths.has(path)) {
      throw new SkillRejected('skill_manifest_invalid');
    }
    paths.set(path, resource);
  }
  if (!paths.has(suffix)) {
    throw new SkillRejected('skill_manifest_invalid');
  }
  let declared = 0;
  for (const resource of paths.values()) {
    if (resource.size > MAX_FILE_BYTES) {
      throw new SkillRejected('skills_limit_exceeded');
    }
    declared += resource.size;
  }
  if (declared > remainingBytes) {
    throw new SkillRejected('skills_limit_exceeded');
  }
  const files = new Map<string, string>();
  let totalBytes = 0;
  for (const [path, resource] of paths) {
    const read = await client.readResource({ uri: resource.uri }, { signal, timeout: REQUEST_TIMEOUT_MS });
    const content = read.contents.find((item) => item.uri === resource.uri) ?? read.contents[0];
    if (content === undefined || !('text' in content) || typeof content.text !== 'string') {
      // A blob is not a document the model can read.
      throw new SkillRejected('skill_not_text');
    }
    const text = content.text;
    const size = Buffer.byteLength(text);
    if (size !== resource.size) {
      throw new SkillRejected('skill_size_mismatch');
    }
    const digest = `sha256:${createHash('sha256').update(text).digest('hex')}`;
    if (digest !== resource.digest.toLowerCase()) {
      throw new SkillRejected('skill_digest_mismatch');
    }
    totalBytes += size;
    files.set(path, text);
  }
  return { name, description: description.slice(0, MAX_DESCRIPTION_CHARACTERS), files, totalBytes };
}
