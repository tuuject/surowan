/**
 * The IMH-03 boundary test: core code must not branch on a host literal. Any
 * `'telegram'` / `'playground'` string (all three quote styles) or a SQL
 * `host_kind = '` literal outside the allowlist fails this file.
 *
 * Allowed forms instead: read a trait from `hostExecutionProfile(kind)`, or an
 * exhaustive `switch (kind)` inside one of the boundary files listed below.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, test } from 'vitest';

const SRC_ROOT = join(import.meta.dirname, '..', '..', 'src');

/**
 * Every path where a host literal is a boundary rather than core logic, with
 * the reason it stays. A prefix entry (trailing `/`) covers a whole directory;
 * keep this list as short as the real boundaries allow.
 */
const ALLOWLIST: Readonly<Record<string, string>> = {
  'platform/host-profile.ts': 'the host trait table itself',
  'platform/im-host/': 'the HostKind union and its exhaustive-switch policies',
  'platform/config/': 'config.jsonc keeps its telegram.* shape; this is the projection layer',
  'adapters/local-monolith/telegram/': 'the Telegram adapter names its own host',
  'adapters/local-monolith/playground/': 'the Playground adapter names its own host',
  'adapters/local-monolith/config/': 'the adapter config layer writes telegram.* paths',
  'adapters/local-monolith/runtime/': 'the composition root wires per-host readiness',
  'ingress/telegram-ingestion/': "Telegram intake is Telegram's own edge, including its getUpdates catch-up passes",
  'ingress/playground.ts': 'the room ingress writes the room host kind',
  'ingress/admin/': 'Admin routes and queries are the per-host HTTP surface',
  'store/playground/': 'the room store writes its own host kind',
  'store/host-scope.ts': 'the host-scope SQL helpers are the generator, not a call site',
  'capabilities/media/local-assets.ts': 'the room-asset resolver owns the on-disk images/playground path',
  'capabilities/media/sticker-index.ts': "sticker media rows are Telegram's own subsystem",
  'context/builder/render.ts': 'exhaustive per-host switches render host-native history rows',
  'context/builder/schema.ts': 'the room snapshot schema pins host: playground and an exhaustive validator switch',
  'tui/': 'the setup wizard writes telegram.* configuration',
  'doctor.ts': 'diagnostics wire the Telegram bot explicitly',
  'cli.ts': 'the CLI wires Telegram-only commands',
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

const LITERAL_PATTERN = /['"`](?:telegram|playground)['"`]|host_kind\s*=\s*'/g;

/**
 * A `hosts: [...]` mount declaration whose value is only host strings. The
 * mount contract is data, not a branch, so these literals are exempt anywhere
 * they appear — a plugin tree no longer needs a directory allowlist.
 */
const HOSTS_DECLARATION = /\bhosts\s*:\s*\[(?:\s*['"](?:telegram|playground)['"]\s*,?)*\s*\]/g;

/** The 1-based lines in `source` that carry a host literal, comments stripped. */
function findHostLiterals(source: string): readonly number[] {
  const stripped = stripComments(source);
  const chars = stripped.split('');
  for (const match of stripped.matchAll(HOSTS_DECLARATION)) {
    for (let index = match.index; index < match.index + match[0].length; index += 1) {
      if (chars[index] !== '\n') {
        chars[index] = ' ';
      }
    }
  }
  const scan = chars.join('');
  const lines: number[] = [];
  for (const match of scan.matchAll(LITERAL_PATTERN)) {
    lines.push(source.slice(0, match.index).split('\n').length);
  }
  return lines;
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

describe('host literal boundary', () => {
  test('no host literal survives outside the allowlist', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC_ROOT)) {
      const path = relative(SRC_ROOT, file).split(sep).join('/');
      if (isAllowlisted(path)) {
        continue;
      }
      const hits = findHostLiterals(readFileSync(file, 'utf8'));
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

  test('the scanner catches all three quote styles and SQL literals', () => {
    expect(findHostLiterals("const a = 'telegram';")).toEqual([1]);
    expect(findHostLiterals('const a = "playground";')).toEqual([1]);
    expect(findHostLiterals('const a = `telegram`;')).toEqual([1]);
    expect(findHostLiterals("sql`WHERE host_kind = 'telegram'`")).toEqual([1]);
    expect(findHostLiterals("eq(chats.hostKind, 'playground')")).toEqual([1]);
  });

  test('the scanner ignores comments, identifiers and longer strings', () => {
    expect(findHostLiterals("// mounted on 'telegram' only\nconst a = 1;")).toEqual([]);
    expect(findHostLiterals("/* a 'playground' literal\nin prose */ const a = 1;")).toEqual([]);
    expect(findHostLiterals('const a = { telegram: 1, playground: 2 };')).toEqual([]);
    expect(findHostLiterals("const a = 'telegram_network_error';")).toEqual([]);
    expect(findHostLiterals('const url = "https://api.telegram.org/file";')).toEqual([]);
  });

  test('a hosts mount declaration is exempt; a host literal elsewhere is not', () => {
    expect(findHostLiterals("const plugin = { hosts: ['telegram', 'playground'] };")).toEqual([]);
    expect(findHostLiterals("const injector = {\n  hosts: ['telegram'],\n};")).toEqual([]);
    expect(findHostLiterals("if (kind === 'telegram') { return 1; }")).toEqual([1]);
    expect(findHostLiterals("const plugin = { hosts: ['telegram'], pick: 'telegram' };")).toEqual([1]);
    // An array that mixes a variable in is not a pure mount declaration.
    expect(findHostLiterals("const plugin = { hosts: ['telegram', other] };")).toEqual([1]);
  });
});
