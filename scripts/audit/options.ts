import { resolve } from 'node:path';
import { DEFAULT_DATABASE, DEFAULT_LIMIT } from './support.ts';

type Command = 'invocation' | 'conversation' | 'prompt' | 'search';

export interface Options {
  readonly command: Command;
  readonly target: string | null;
  readonly text: string | null;
  readonly database: string;
  readonly limit: number;
  readonly json: boolean;
  readonly out: string | null;
  readonly since: string | null;
}

export function parseOptions(argv: readonly string[]): Options {
  let command: string | null = null;
  let target: string | null = null;
  let text: string | null = null;
  let database = DEFAULT_DATABASE;
  let limit = DEFAULT_LIMIT;
  let json = false;
  let out: string | null = null;
  let since: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = (): string => {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new Error(`Missing value for ${argument ?? ''}`);
      }
      index += 1;
      return value;
    };
    if (argument === '--db' || argument === '--database') {
      database = resolve(next());
      continue;
    }
    if (argument === '--limit') {
      limit = Number.parseInt(next(), 10);
      if (!Number.isInteger(limit) || limit <= 0) {
        throw new Error('--limit must be a positive integer');
      }
      continue;
    }
    if (argument === '--text') {
      text = next();
      continue;
    }
    if (argument === '--since') {
      since = next();
      continue;
    }
    if (argument === '--out') {
      out = resolve(next());
      continue;
    }
    if (argument === '--json') {
      json = true;
      continue;
    }
    if (argument?.startsWith('--')) {
      throw new Error(`Unknown argument: ${argument}`);
    }
    if (command === null) {
      command = argument ?? '';
      continue;
    }
    if (target === null) {
      target = argument ?? '';
      continue;
    }
    throw new Error(`Unexpected argument: ${argument ?? ''}`);
  }
  if (command !== 'invocation' && command !== 'conversation' && command !== 'prompt' && command !== 'search') {
    throw new Error('Usage: node scripts/audit.ts <invocation|conversation|prompt|search> [id] [--db <path>] [--json]');
  }
  if (command === 'search' && (text === null || text.length === 0)) {
    throw new Error('search requires --text <text>');
  }
  if (command !== 'search' && target === null) {
    throw new Error(`${command} requires an id`);
  }
  return { command, target, text, database, limit, json, out, since };
}
