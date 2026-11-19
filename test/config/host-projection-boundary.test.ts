/**
 * The IMH-04 boundary test: core code must not read the `telegram` config
 * section directly. Any `.telegram.` / `.telegram?.` property access, a
 * `['telegram']` bracket access or a `RawConfig['telegram']` indexed type
 * outside the allowlist fails this file.
 *
 * Allowed instead: the projection accessors in `src/platform/config/`
 * (`configuredChats`, `allConfiguredChats`, `mapConfiguredChats`,
 * `hostIntakeSettings`, `resolveChatConfig`).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, test } from 'vitest';

const SRC_ROOT = join(import.meta.dirname, '..', '..', 'src');

/**
 * Every path where a `telegram` config read is a boundary rather than core
 * logic, with the reason it stays. A prefix entry (trailing `/`) covers a
 * whole directory; keep this list as short as the real boundaries allow.
 */
const ALLOWLIST: Readonly<Record<string, string>> = {
  'platform/config/': 'the projection layer and the config schema/resolve/diff internals themselves',
  'adapters/local-monolith/config/': 'the config file layer reads and writes telegram.* paths',
  'adapters/local-monolith/telegram/': "the Telegram adapter wires its own host's config",
  'adapters/local-monolith/runtime/sticker-sets.ts': 'the Telegram-only sticker-set module named in the plan',
  'capabilities/stickers/': 'the Telegram-only sticker subsystem reads its own section',
  'ingress/telegram-ingestion/': "Telegram intake is Telegram's own edge",
  'ingress/admin/': 'Admin routes and queries are the product API layer',
  'tui/': 'the setup wizard writes telegram.* configuration',
  'doctor.ts': 'diagnostics wire the Telegram bot explicitly',
};

/** `dir/` or an exact file path. */
function isAllowlisted(path: string): boolean {
  for (const entry of Object.keys(ALLOWLIST)) {
    if (entry.endsWith('/') ? path.startsWith(entry) : path === entry) {
      return true;
    }
  }
  return false;
}

/**
 * Strip line and block comments without touching string contents: a `//` or
 * `/*` inside a quoted string is text, and a quote inside a comment is not a
 * string start. Comment bytes are blanked so line numbers stay stable.
 */
function stripComments(source: string): string {
  const out = source.split('');
  let state: 'code' | 'line' | 'block' | 'string' = 'code';
  let quote = '';
  for (let index = 0; index < out.length; index += 1) {
    const char = out[index];
    const next = out[index + 1];
    if (state === 'line') {
      if (char === '\n') {
        state = 'code';
      } else {
        out[index] = ' ';
      }
      continue;
    }
    if (state === 'block') {
      if (char === '*' && next === '/') {
        out[index] = ' ';
        out[index + 1] = ' ';
        index += 1;
        state = 'code';
      } else if (char !== '\n') {
        out[index] = ' ';
      }
      continue;
    }
    if (state === 'code') {
      if (char === '/' && next === '/') {
        out[index] = ' ';
        out[index + 1] = ' ';
        index += 1;
        state = 'line';
      } else if (char === '/' && next === '*') {
        out[index] = ' ';
        out[index + 1] = ' ';
        index += 1;
        state = 'block';
      } else if (char === "'" || char === '"' || char === '`') {
        state = 'string';
        quote = char;
      }
      continue;
    }
    // Inside a string: only the matching unescaped quote ends it.
    if (char === '\\') {
      index += 1;
      continue;
    }
    if (char === quote) {
      state = 'code';
    }
  }
  return out.join('');
}

/**
 * Blank string contents so a `'...telegram.x...'` literal is not read as an
 * access. Quote characters stay, so `['telegram']` still looks like brackets
 * around a string to the bracket pass below.
 */
function blankStrings(source: string): string {
  const out = source.split('');
  let inString = false;
  let quote = '';
  for (let index = 0; index < out.length; index += 1) {
    const char = out[index];
    if (!inString) {
      if (char === "'" || char === '"' || char === '`') {
        inString = true;
        quote = char;
      }
      continue;
    }
    if (char === '\\') {
      out[index] = ' ';
      out[index + 1] = ' ';
      index += 1;
      continue;
    }
    if (char === quote) {
      inString = false;
      continue;
    }
    if (char !== '\n') {
      out[index] = ' ';
    }
  }
  return out.join('');
}

/**
 * `services.telegram` / `assembly.telegram` are fields of the host service
 * registry the composition root binds — service objects, not the config
 * section. They are the only non-config `.telegram` receivers that exist; any
 * other `.telegram.` access is treated as a config read.
 */
const SERVICE_REGISTRY_RECEIVERS = /\b(?:services|assembly)\.telegram\b/g;

const DOT_ACCESS = /\.telegram\??\.|\.telegram\b(?!\.)/g;
const BRACKET_ACCESS = /[\w$)\]]\s*\[\s*['"`]telegram['"`]\s*\]|RawConfig\s*\[\s*['"`]telegram['"`]\s*\]/g;

/** The 1-based lines in `source` that read the telegram config section. */
function findSectionReads(source: string): readonly number[] {
  const uncommented = stripComments(source);
  // Pass 1: dotted member access, string contents ignored, service-registry
  // receivers exempted.
  const dotted = blankStrings(uncommented).split('');
  for (const match of uncommented.matchAll(SERVICE_REGISTRY_RECEIVERS)) {
    for (let index = match.index; index < match.index + match[0].length; index += 1) {
      if (dotted[index] !== '\n') {
        dotted[index] = ' ';
      }
    }
  }
  const lines = new Set<number>();
  for (const match of dotted.join('').matchAll(DOT_ACCESS)) {
    lines.add(source.slice(0, match.index).split('\n').length);
  }
  // Pass 2: bracket and indexed-type access needs the quoted key itself.
  for (const match of uncommented.matchAll(BRACKET_ACCESS)) {
    lines.add(source.slice(0, match.index).split('\n').length);
  }
  return [...lines].sort((left, right) => left - right);
}

function* sourceFiles(directory: string): Generator<string> {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      yield* sourceFiles(path);
    } else if (entry.name.endsWith('.ts')) {
      yield path;
    }
  }
}

describe('config projection boundary', () => {
  test('no telegram-section read survives outside the allowlist', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC_ROOT)) {
      const path = relative(SRC_ROOT, file).split(sep).join('/');
      if (isAllowlisted(path)) {
        continue;
      }
      const hits = findSectionReads(readFileSync(file, 'utf8'));
      if (hits.length > 0) {
        offenders.push(`${path}:${hits.join(',')}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('every allowlist entry names a real path', () => {
    const files = new Set<string>();
    for (const file of sourceFiles(SRC_ROOT)) {
      files.add(relative(SRC_ROOT, file).split(sep).join('/'));
    }
    const stale = Object.keys(ALLOWLIST).filter((entry) =>
      entry.endsWith('/') ? ![...files].some((file) => file.startsWith(entry)) : !files.has(entry),
    );
    expect(stale).toEqual([]);
  });

  test('the scanner catches every section-access shape', () => {
    expect(findSectionReads('config.telegram.chats')).toEqual([1]);
    expect(findSectionReads('config.telegram?.chats')).toEqual([1]);
    expect(findSectionReads("config['telegram'].chats")).toEqual([1]);
    expect(findSectionReads('config[ "telegram" ].chats')).toEqual([1]);
    expect(findSectionReads("RawConfig['telegram']")).toEqual([1]);
    expect(findSectionReads('RawConfig["telegram"]')).toEqual([1]);
    expect(findSectionReads('file.telegram.chats')).toEqual([1]);
    expect(findSectionReads('return config.telegram')).toEqual([1]);
  });

  test('the scanner ignores comments, object keys and service registries', () => {
    expect(findSectionReads('// config.telegram.chats\nconst a = 1;')).toEqual([]);
    expect(findSectionReads('/* config.telegram */\nconst a = 1;')).toEqual([]);
    expect(findSectionReads('const a = { telegram: { chats: [] } };')).toEqual([]);
    expect(findSectionReads("const s = 'config.telegram.chats';")).toEqual([]);
    expect(findSectionReads('services.telegram.current')).toEqual([]);
    expect(findSectionReads('assembly.telegram.identity')).toEqual([]);
    // A `hosts: [...]` mount is a declaration, not a section access.
    expect(findSectionReads("const plugin = { hosts: ['telegram'] };")).toEqual([]);
    // A config read still fails when it shares a line with a registry access.
    expect(findSectionReads('services.telegram.send(config.telegram.chats)')).toEqual([1]);
  });
});
