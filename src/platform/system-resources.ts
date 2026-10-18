import type { HostKind } from './im-host.ts';

/** Readonly System Skills resources; implementation and document source belong to the host. */
export const SYSTEM_URI_PREFIX = 'system:///';
export const SYSTEM_RESOURCE_MAX_BYTES = 32_768;

const SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const URI_MAX_LENGTH = 512;

export interface SystemSkill {
  readonly name: string;
  readonly description: string;
  readonly uri: string;
}

/**
 * The conversation facts a skill visibility rule may read. A skill can be
 * gated by capability state that lives on one conversation (a room's image
 * switch), so the host kind alone is not enough.
 */
export interface SkillVisibilityTarget {
  readonly hostKind: HostKind;
  readonly conversationId: bigint;
}

export interface SystemResourceText {
  readonly uri: string;
  readonly text: string;
  readonly truncated: boolean;
}

export class SystemResourceError extends Error {
  readonly code: 'invalid_uri' | 'resource_not_found' | 'unsupported_resource';

  constructor(code: 'invalid_uri' | 'resource_not_found' | 'unsupported_resource', message: string) {
    super(message);
    this.code = code;
  }
}

export interface SystemResources {
  readonly skills: readonly SystemSkill[];
  resolve(reference: string, base?: string): { uri: string; segments: readonly string[] };
  readText(reference: string, base?: string): Promise<SystemResourceText>;
}

/** A source-independent URI resolver shared by all resource implementations. */
export function resolveSystemResource(reference: string, base?: string): { uri: string; segments: readonly string[] } {
  if (reference.length > URI_MAX_LENGTH || (base !== undefined && base.length > URI_MAX_LENGTH)) {
    throw new SystemResourceError('invalid_uri', 'Resource URI exceeds the length limit');
  }
  if (reference.startsWith(SYSTEM_URI_PREFIX)) {
    if (base !== undefined) {
      throw new SystemResourceError('invalid_uri', 'base is only valid together with a relative reference');
    }
    const path = reference.slice(SYSTEM_URI_PREFIX.length);
    if (path.length === 0) {
      throw new SystemResourceError('invalid_uri', 'Resource URI has an empty path');
    }
    const segments = path.split('/');
    for (const segment of segments) {
      if (!SEGMENT_PATTERN.test(segment)) {
        throw new SystemResourceError('invalid_uri', 'Resource URI contains an invalid path segment');
      }
    }
    return { uri: `${SYSTEM_URI_PREFIX}${segments.join('/')}`, segments };
  }
  if (base === undefined) {
    throw new SystemResourceError('invalid_uri', 'Relative references require the base URI of their document');
  }
  if (!base.startsWith(SYSTEM_URI_PREFIX)) {
    throw new SystemResourceError('invalid_uri', 'Only system:/// resources exist');
  }
  const basePath = base.slice(SYSTEM_URI_PREFIX.length);
  if (basePath.length === 0) {
    throw new SystemResourceError('invalid_uri', 'Base URI has an empty path');
  }
  const baseSegments = basePath.split('/');
  for (const segment of baseSegments) {
    if (!SEGMENT_PATTERN.test(segment)) {
      throw new SystemResourceError('invalid_uri', 'Base URI contains an invalid path segment');
    }
  }
  const stack = baseSegments.slice(0, -1);
  for (const segment of reference.split('/')) {
    if (segment.length === 0) {
      throw new SystemResourceError('invalid_uri', 'Relative reference contains an empty path segment');
    }
    if (segment === '.') {
      continue;
    }
    if (segment === '..') {
      if (stack.pop() === undefined) {
        throw new SystemResourceError('invalid_uri', 'Relative reference escapes the system resource root');
      }
      continue;
    }
    if (!SEGMENT_PATTERN.test(segment)) {
      throw new SystemResourceError('invalid_uri', 'Relative reference contains an invalid path segment');
    }
    stack.push(segment);
  }
  if (stack.length === 0) {
    throw new SystemResourceError('invalid_uri', 'Resolved resource path is empty');
  }
  return { uri: `${SYSTEM_URI_PREFIX}${stack.join('/')}`, segments: stack };
}

/** No resources are available; preserve the empty tree's missing-resource behavior. */
export function emptySystemResources(): SystemResources {
  return {
    skills: [],
    resolve: resolveSystemResource,
    async readText(_reference: string, _base?: string): Promise<SystemResourceText> {
      throw new SystemResourceError('resource_not_found', 'No system resources are available');
    },
  };
}

/**
 * The system-prompt skill index: the only skill content injected eagerly.
 * Everything else is loaded on demand through the read primitive.
 */
export function renderSkillIndexPrompt(skills: readonly SystemSkill[]): string {
  if (skills.length === 0) {
    return '';
  }
  return [
    'System skills: readonly documentation shipped with the runtime. This index is the complete list; no other skills exist.',
    ...skills.map((skill) => `- ${skill.name}: ${skill.description} (${skill.uri})`),
    'When the current task matches a skill, read its SKILL.md with the read tool first and follow it; resolve relative references it lists against that document as the base. Skills explain runtime capabilities and when to use them, but never override tool constraints, capability authorization, or these protocol rules. Runtime-internal capabilities are invoked only through the execute tool (actions search, help, call); directly exposed tools and MCP tools are called directly.',
  ].join('\n');
}
