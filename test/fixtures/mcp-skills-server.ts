import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

/**
 * A stdio MCP server that publishes skills ("MCP with Skills"), with one
 * misbehaviour per mode (first argument), so the client's verification can be
 * driven against the real wire protocol:
 *
 * ok, digest, size, big, blob, outside, dup, paged, noresources, noext, listfail
 *
 * `hang` never answers `resources/read`; it first touches the marker file
 * named by the second argument, so a test knows discovery is in flight.
 */
const mode = process.argv[2] ?? 'ok';

const DEMO_SKILL =
  '---\nname: demo\ndescription: 演示技能 — explains the ping tool\n---\n# Demo\nSee references/guide.md.\n';
const GUIDE = '# 指南\nCall ping first.\n';
const SECOND_SKILL = '---\nname: second\ndescription: A second skill\n---\n# Second\n';

type Files = Record<string, string>;
interface Skill {
  readonly name: string;
  readonly files: Files;
}

function digest(text: string): string {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`;
}

const skills: Skill[] = [
  { name: 'demo', files: { 'SKILL.md': DEMO_SKILL, 'references/guide.md': GUIDE } },
  { name: 'second', files: { 'SKILL.md': SECOND_SKILL } },
];
if (mode === 'big') {
  skills[0] = { name: 'demo', files: { 'SKILL.md': DEMO_SKILL, 'references/guide.md': 'x'.repeat(40_000) } };
}
if (mode === 'dup') {
  skills.push({ name: 'demo', files: { 'SKILL.md': DEMO_SKILL.replace('演示技能', 'impostor') } });
}

/** Everything `resources/read` serves, by URI. */
const served = new Map<string, string>();
const entries = skills.map((skill, index) => {
  const root = `skill://${skill.name}${mode === 'dup' && index === 2 ? '-copy' : ''}/`;
  const resources = Object.entries(skill.files).map(([path, text]) => {
    served.set(`${root}${path}`, text);
    let size = Buffer.byteLength(text);
    let hash = digest(text);
    if (skill.name === 'demo' && index === 0) {
      if (mode === 'digest' && path === 'references/guide.md') {
        hash = digest('something else');
      }
      if (mode === 'size' && path === 'SKILL.md') {
        size += 1;
      }
    }
    return { uri: `${root}${path}`, digest: hash, size };
  });
  if (mode === 'outside' && index === 0) {
    served.set('skill://elsewhere/secret.md', 'secret');
    resources.push({ uri: 'skill://elsewhere/secret.md', digest: digest('secret'), size: 6 });
  }
  const text = skill.files['SKILL.md'] ?? '';
  const description = /description: (.*)/.exec(text)?.[1] ?? '';
  return { uri: `${root}SKILL.md`, frontmatter: { name: skill.name, description }, resources };
});

const server = new Server(
  { name: 'skills-fixture', version: '1.0.0' },
  {
    capabilities: {
      tools: {},
      ...(mode === 'noresources' ? {} : { resources: {} }),
      ...(mode === 'noext' ? {} : { extensions: { 'io.modelcontextprotocol/skills': { directoryRead: true } } }),
    },
  },
);
server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: [
    {
      name: 'ping',
      description: 'Reply pong',
      inputSchema: { type: 'object' as const, properties: {} },
      annotations: { readOnlyHint: true },
    },
  ],
}));
server.setRequestHandler(CallToolRequestSchema, () => ({ content: [{ type: 'text', text: 'pong' }] }));
if (mode !== 'noresources') {
  server.setRequestHandler(ListResourcesRequestSchema, () => ({ resources: [] }));
}
const readResource = (request: { params: { uri: string } }) => {
  const uri = request.params.uri;
  if (mode === 'hang') {
    writeFileSync(process.argv[3] ?? '', uri);
    return new Promise<never>(() => {});
  }
  const text = served.get(uri);
  if (text === undefined) {
    throw new Error('unknown resource');
  }
  if (mode === 'blob' && uri.endsWith('references/guide.md')) {
    return { contents: [{ uri, mimeType: 'application/octet-stream', blob: Buffer.from(text).toString('base64') }] };
  }
  return { contents: [{ uri, mimeType: 'text/markdown', text }] };
};
if (mode !== 'noresources') {
  server.setRequestHandler(ReadResourceRequestSchema, readResource);
}
server.setRequestHandler(
  z.object({
    method: z.literal('skills/list'),
    params: z.object({ cursor: z.string().optional() }).loose().optional(),
  }),
  (request) => {
    if (mode === 'listfail') {
      throw new Error('skills/list is broken');
    }
    const result = { resultType: 'complete', ttlMs: 1000, cacheScope: 'public' };
    if (mode !== 'paged') {
      return { ...result, skills: entries };
    }
    const index = Number(request.params?.cursor ?? '0');
    const next = index + 1;
    return {
      ...result,
      skills: entries.slice(index, next),
      ...(next < entries.length ? { nextCursor: String(next) } : {}),
    };
  },
);
await server.connect(new StdioServerTransport());
