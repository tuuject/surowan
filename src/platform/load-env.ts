import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

// Editors on Windows write a UTF-8 BOM and CR line endings; left in, the BOM
// becomes part of the first key and a CR part of a value. `process.loadEnvFile`
// takes only a path, so the file is read, normalized and handed to `parseEnv`,
// the same built-in parser. Only `KEY=value` lines are assignments. Variables
// already set are never overridden, so precedence is: real environment >
// `.env.local` > `.env`. Missing and unreadable files are skipped silently.
const ENV_FILES = ['.env.local', '.env'] as const;

export function loadEnvFiles(paths: readonly string[] = ENV_FILES): void {
  for (const path of paths) {
    let contents: string;
    try {
      contents = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    contents = contents.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    for (const [key, value] of Object.entries(parseEnv(contents))) {
      if (process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  }
}
