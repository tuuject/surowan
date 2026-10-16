/**
 * The dependency direction the extraction is for.
 *
 * The platform half of the bot decides what to say and when; the host half
 * knows how it gets there. These tests fail if that leaks: no transport client
 * may reach the orchestration layer, and the platform capability modules must
 * not assemble Telegram wire parameters themselves.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));

function sourceFiles(directory: string): readonly string[] {
  const found: string[] = [];
  for (const entry of readdirSync(join(root, directory))) {
    const relative = `${directory}/${entry}`;
    if (statSync(join(root, relative)).isDirectory()) {
      found.push(...sourceFiles(relative));
      continue;
    }
    if (entry.endsWith('.ts')) {
      found.push(relative);
    }
  }
  return found;
}

function read(relative: string): string {
  return readFileSync(join(root, relative), 'utf8');
}

function offenders(files: readonly string[], pattern: RegExp): readonly string[] {
  return files.filter((file) => pattern.test(read(file)));
}

/** The removed modules must stay removed. */
test('the old transport construction entry points are gone', () => {
  const all = sourceFiles('src');
  expect(offenders(all, /\bTelegramSendApi\b/)).toEqual([]);
  expect(offenders(all, /\bMentionTyping\b/)).toEqual([]);
  expect(all).not.toContain('src/capabilities/telegram-send-api.ts');
  expect(all).not.toContain('src/capabilities/mention-typing.ts');
  expect(all).not.toContain('src/capabilities/typing.ts');
});

test('the orchestrator imports the host contract, not a transport client', () => {
  const files = sourceFiles('src/orchestration');
  expect(offenders(files, /from 'grammy'/)).toEqual([]);
  expect(offenders(files, /from '\.\.\/adapters\/local-monolith\/telegram-host\.ts'/)).toEqual([]);
});

test('only the Telegram host owns the grammY client, the local monolith and its CLI excepted', () => {
  const files = [
    ...sourceFiles('src/platform'),
    ...sourceFiles('src/capabilities'),
    ...sourceFiles('src/orchestration'),
  ];
  expect(offenders(files, /from 'grammy'/)).toEqual([]);
});

test('platform capabilities do not assemble Telegram wire parameters', () => {
  const files = [...sourceFiles('src/platform'), ...sourceFiles('src/capabilities')];
  expect(offenders(files, /message_thread_id/)).toEqual([]);
  expect(offenders(files, /reply_parameters/)).toEqual([]);
});

test('Telegram markup is named in exactly two places outside the tool schema', () => {
  // The model still asks for `MarkdownV2`, because that argument name is pinned
  // in the prompt. It is translated to the neutral `markup` once, in the send
  // tool, and the host is the only other module that knows the name.
  const files = sourceFiles('src');
  expect([...offenders(files, /MarkdownV2/)].sort()).toEqual([
    'src/adapters/local-monolith/telegram-host.ts',
    'src/capabilities/send-tool.ts',
  ]);
});

/**
 * Known remaining coupling, pinned so it stays visible and so removing it is a
 * deliberate change rather than a silent one. These modules still read Telegram
 * update shapes directly; they are not part of the delivery or activity
 * boundary this extraction moved, and they are tracked separately.
 */
test('the remaining Telegram type coupling is exactly this and no more', () => {
  const coupled = offenders(sourceFiles('src/platform'), /from 'grammy\/types'/).concat(
    offenders(sourceFiles('src/orchestration'), /from 'grammy\/types'/),
  );
  expect([...coupled].sort()).toEqual(['src/orchestration/bot-commands.ts', 'src/platform/participation.ts']);
});
