/**
 * The IMH-05 transport boundary test: `grammy` is Telegram's own SDK, so only
 * the Telegram edge may import it. Any `from 'grammy'`, `from 'grammy/types'`,
 * bare `import 'grammy'`, dynamic `import('grammy')` or `require('grammy')`
 * outside the allowlist fails this file, keeping the neutral intake path and
 * the composition root free of transport types.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, test } from 'vitest';

const SRC_ROOT = join(import.meta.dirname, '..', '..', 'src');

/**
 * Every path allowed to name the grammY package, with the reason it stays. A
 * prefix entry (trailing `/`) covers a whole directory; keep this list as
 * short as the real boundaries allow.
 */
const ALLOWLIST: Readonly<Record<string, string>> = {
  'adapters/local-monolith/telegram/': 'the Telegram adapter owns the grammY transport and its live-update handler',
  'ingress/telegram-ingestion/':
    'Telegram intake, its catch-up drains and cue/command extraction read Update and Message',
  'doctor.ts': 'diagnostics probe Telegram with a real grammY Bot',
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
 * One grammY package specifier reached through an import or a require: static
 * `from 'grammy[/…]'` covers `import type` and re-exports, `import 'grammy'`
 * is the side-effect form, `import('grammy')` and `require('grammy')` the
 * dynamic ones. The keyword must not be a member (`x.from`) or a suffix of a
 * longer identifier, and the specifier must be exactly `grammy` or a path
 * inside it — `'grammyx'` is not the SDK.
 */
const GRAMMY_IMPORT =
  /(?<![\w$.])(?:from\s*['"`]grammy(?:\/[^'"`\s]*)?['"`]|import\s*\(?\s*['"`]grammy(?:\/[^'"`\s]*)?['"`]|require\s*\(\s*['"`]grammy(?:\/[^'"`\s]*)?['"`])/g;

/**
 * Per-byte flags: 1 inside a comment or a string literal, 0 in code. Import
 * specifiers are strings, so a match is only real when its keyword starts in
 * code — a `"from 'grammy'"` inside a quoted fixture is text, not an import.
 */
function nonCodeMask(source: string): Uint8Array {
  const mask = new Uint8Array(source.length);
  let state: 'code' | 'line' | 'block' | 'string' = 'code';
  let quote = '';
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (state === 'line') {
      if (char === '\n') {
        state = 'code';
      } else {
        mask[index] = 1;
      }
      continue;
    }
    if (state === 'block') {
      mask[index] = 1;
      if (char === '*' && next === '/') {
        mask[index + 1] = 1;
        index += 1;
        state = 'code';
      }
      continue;
    }
    if (state === 'code') {
      if (char === '/' && next === '/') {
        mask[index] = 1;
        mask[index + 1] = 1;
        index += 1;
        state = 'line';
      } else if (char === '/' && next === '*') {
        mask[index] = 1;
        mask[index + 1] = 1;
        index += 1;
        state = 'block';
      } else if (char === "'" || char === '"' || char === '`') {
        mask[index] = 1;
        state = 'string';
        quote = char;
      }
      continue;
    }
    // Inside a string: the quotes and escaped bytes are all non-code.
    mask[index] = 1;
    if (char === '\\') {
      mask[index + 1] = 1;
      index += 1;
      continue;
    }
    if (char === quote) {
      state = 'code';
    }
  }
  return mask;
}

/** The 1-based lines whose grammY import sits in code, not in prose or a string. */
function findGrammyImports(source: string): readonly number[] {
  const mask = nonCodeMask(source);
  const lines: number[] = [];
  for (const match of source.matchAll(GRAMMY_IMPORT)) {
    if (mask[match.index] === 0) {
      lines.push(source.slice(0, match.index).split('\n').length);
    }
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

describe('grammy import boundary', () => {
  test('no grammY import survives outside the allowlist', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC_ROOT)) {
      const path = relative(SRC_ROOT, file).split(sep).join('/');
      if (isAllowlisted(path)) {
        continue;
      }
      const hits = findGrammyImports(readFileSync(file, 'utf8'));
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

  test('the scanner catches every grammY import form', () => {
    expect(findGrammyImports("import { Bot } from 'grammy';")).toEqual([1]);
    expect(findGrammyImports('import { Bot } from "grammy";')).toEqual([1]);
    expect(findGrammyImports("import type { Update } from 'grammy/types';")).toEqual([1]);
    expect(findGrammyImports("import type {Message} from 'grammy'")).toEqual([1]);
    expect(findGrammyImports("export { Bot } from 'grammy';")).toEqual([1]);
    expect(findGrammyImports("export type { Update } from 'grammy/types';")).toEqual([1]);
    expect(findGrammyImports("import 'grammy';")).toEqual([1]);
    expect(findGrammyImports("const g = require('grammy');")).toEqual([1]);
    expect(findGrammyImports("const g = await import('grammy');")).toEqual([1]);
    expect(findGrammyImports("const m = await import ( 'grammy/types' );")).toEqual([1]);
    expect(findGrammyImports("const x = 1;\nimport { Bot } from 'grammy';")).toEqual([2]);
    expect(findGrammyImports("const m = from\n  'grammy';")).toEqual([1]);
  });

  test('the scanner ignores comments, strings and lookalike specifiers', () => {
    expect(findGrammyImports("// import { Bot } from 'grammy';\nconst a = 1;")).toEqual([]);
    expect(findGrammyImports("/* an import from 'grammy'\nin prose */ const a = 1;")).toEqual([]);
    expect(findGrammyImports('const s = "from \'grammy\'";')).toEqual([]);
    expect(findGrammyImports("const s = `import 'grammy'`;")).toEqual([]);
    expect(findGrammyImports("import { x } from 'grammy-x';")).toEqual([]);
    expect(findGrammyImports("import { x } from './grammy';")).toEqual([]);
    expect(findGrammyImports("import { x } from 'mygrammy';")).toEqual([]);
    expect(findGrammyImports("const a = Array.from('grammy');")).toEqual([]);
    expect(findGrammyImports('const meta = import.meta.url;')).toEqual([]);
    expect(findGrammyImports('const meta = import.meta.env.MODE;')).toEqual([]);
  });
});
