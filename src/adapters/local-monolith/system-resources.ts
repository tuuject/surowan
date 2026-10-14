import type { Dirent } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import Type from 'typebox';
import Compile from 'typebox/compile';
import { truncateUtf8 } from '../../platform/truncate.ts';
import {
  SYSTEM_RESOURCE_MAX_BYTES,
  SYSTEM_URI_PREFIX,
  SystemResourceError,
  resolveSystemResource,
  type SystemResources,
  type SystemSkill,
  type SystemResourceText,
} from '../../platform/system-resources.ts';

/** Content root shipped inside the repository; Docker copies src/ verbatim. */
export const BUNDLED_SYSTEM_RESOURCES_DIR = join(import.meta.dirname, '..', '..', 'system-resources');

const SKILL_NAME_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const SkillFrontmatterSchema = Type.Object(
  {
    name: Type.String({ pattern: SKILL_NAME_PATTERN.source }),
    description: Type.String({ minLength: 1, maxLength: 500 }),
  },
  { additionalProperties: false },
);
const frontmatterValidator = Compile(SkillFrontmatterSchema);

/** Filesystem-backed Local Monolith implementation of the shared resource contract. */
export class FileSystemResources implements SystemResources {
  readonly #root: string;
  readonly #skills: readonly SystemSkill[];
  /** Skill name → directory on disk; serves every path under system:///skills/<name>/. */
  readonly #skillDirectories: ReadonlyMap<string, string>;

  private constructor(root: string, skills: readonly SystemSkill[], skillDirectories: ReadonlyMap<string, string>) {
    this.#root = root;
    this.#skills = skills;
    this.#skillDirectories = skillDirectories;
  }

  /**
   * Loads and validates the bundled resource tree. Invalid skill manifests are
   * startup failures: the skill index is the capability discovery layer, so a
   * half-parsed tree must never reach the model. `skillDirectories` are plugin
   * skills: each basename is the skill name, and it may not shadow another.
   */
  static async load(root: string, skillDirectories: readonly string[] = []): Promise<FileSystemResources> {
    const skillsDirectory = join(root, 'skills');
    let entries: Dirent[] = [];
    try {
      entries = await readdir(skillsDirectory, { withFileTypes: true });
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
        throw error;
      }
    }
    const candidates: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        throw new Error(`System skills directory contains a non-directory entry: ${entry.name}`);
      }
      candidates.push(join(skillsDirectory, entry.name));
    }
    candidates.push(...skillDirectories);
    const skills: SystemSkill[] = [];
    const directories = new Map<string, string>();
    for (const directory of candidates) {
      const name = basename(directory);
      if (!SKILL_NAME_PATTERN.test(name)) {
        throw new Error(`System skill directory name is invalid: ${name}`);
      }
      if (directories.has(name)) {
        throw new Error(`Duplicate system skill name: ${name}`);
      }
      let content: string;
      try {
        content = await readFile(join(directory, 'SKILL.md'), 'utf8');
      } catch {
        throw new Error(`System skill ${name} is missing SKILL.md`);
      }
      const frontmatter = parseFrontmatter(content, `system:///skills/${name}/SKILL.md`);
      if (frontmatter.name !== name) {
        throw new Error(`System skill ${name} declares name ${frontmatter.name}`);
      }
      directories.set(name, directory);
      skills.push({
        name: frontmatter.name,
        description: frontmatter.description,
        uri: `${SYSTEM_URI_PREFIX}skills/${name}/SKILL.md`,
      });
    }
    skills.sort((left, right) => (left.name < right.name ? -1 : 1));
    return new FileSystemResources(root, skills, directories);
  }

  get skills(): readonly SystemSkill[] {
    return this.#skills;
  }

  resolve = resolveSystemResource;

  async readText(reference: string, base?: string): Promise<SystemResourceText> {
    const resolved = this.resolve(reference, base);
    const filename = resolved.segments[resolved.segments.length - 1];
    if (filename === undefined || !filename.endsWith('.md')) {
      throw new SystemResourceError('unsupported_resource', 'Only markdown documents are readable');
    }
    const [top, skillName, ...rest] = resolved.segments;
    const skillDirectory =
      top === 'skills' && skillName !== undefined && rest.length > 0
        ? this.#skillDirectories.get(skillName)
        : undefined;
    let raw: string;
    try {
      raw = await readFile(
        skillDirectory === undefined ? join(this.#root, ...resolved.segments) : join(skillDirectory, ...rest),
        'utf8',
      );
    } catch {
      throw new SystemResourceError('resource_not_found', 'Resource does not exist');
    }
    const text = truncateUtf8(raw, SYSTEM_RESOURCE_MAX_BYTES);
    return { uri: resolved.uri, text, truncated: text !== raw };
  }
}

function parseFrontmatter(content: string, label: string): { name: string; description: string } {
  const lines = content.split('\n');
  if ((lines[0] ?? '').trim() !== '---') {
    throw new Error(`${label} is missing frontmatter`);
  }
  const closing = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (closing === -1) {
    throw new Error(`${label} has unterminated frontmatter`);
  }
  const fields: Record<string, string> = {};
  for (const line of lines.slice(1, closing)) {
    const separator = line.indexOf(':');
    if (separator <= 0) {
      throw new Error(`${label} has an invalid frontmatter line: ${line}`);
    }
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key in fields) {
      throw new Error(`${label} has duplicate frontmatter key: ${key}`);
    }
    fields[key] = value;
  }
  if (!frontmatterValidator.Check(fields)) {
    const details = frontmatterValidator
      .Errors(fields)
      .slice(0, 3)
      .map((error) => error.message)
      .join('; ');
    throw new Error(`${label} has invalid frontmatter: ${details}`);
  }
  return fields;
}
