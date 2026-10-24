import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import { eq } from 'drizzle-orm';
import { afterAll, expect, test } from 'vitest';
import { loadConfig } from '../src/adapters/local-monolith/config.ts';
import { SqliteStore } from '../src/adapters/local-monolith/database.ts';
import { bundledManualSpace, FileSystemDocSpaces } from '../src/adapters/local-monolith/doc-spaces.ts';
import { createDocumentTools } from '../src/capabilities/document-tools.ts';
import { capability, createExecuteTool } from '../src/capabilities/execute-tool.ts';
import { TelegramIngestion } from '../src/ingress/telegram-ingestion.ts';
import { BucketScheduler } from '../src/orchestration/scheduler.ts';
import {
  DOC_PATH_MAX_LENGTH,
  DOC_READ_MAX_BYTES,
  type DocAccessContext,
  DocSpaceError,
  emptyDocSpaces,
  resolveDocPath,
} from '../src/platform/doc-spaces.ts';
import type { InvocationContext } from '../src/platform/invocation-context.ts';
import { toolCalls } from '../src/store/schema.ts';
import { createToolAudit } from '../src/store/tool-audit.ts';
import { renderInvocationContext, testConfigJsonc, testConfigStore, writeTestConfig } from './helpers.ts';

const directories: string[] = [];
const access: DocAccessContext = { conversationId: 1n, chatId: 2n };

afterAll(async () => {
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
  );
});

async function tempRoot(prefix = 'plasticwan-doc-spaces-'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  directories.push(root);
  return root;
}

async function writePack(root: string, pages: Readonly<Record<string, string>>, index?: string): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'index.md'), index ?? '# Fixture manual\n\n- [Start](start/quick-start.md): first page\n');
  for (const [path, text] of Object.entries(pages)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
}

function isDocSpaceError(error: unknown): error is DocSpaceError {
  return error instanceof DocSpaceError;
}

function expectResolveError(path: string, code: DocSpaceError['code'], base?: string): void {
  try {
    resolveDocPath(path, base);
  } catch (error) {
    if (!isDocSpaceError(error)) {
      throw error;
    }
    expect(error.code).toBe(code);
    return;
  }
  throw new Error(`Expected ${path} to be rejected`);
}

async function expectReadError(promise: Promise<unknown>, code: DocSpaceError['code']): Promise<void> {
  const error = await promise.then(
    () => undefined,
    (failure: unknown) => failure,
  );
  if (!isDocSpaceError(error)) {
    throw error;
  }
  expect(error.code).toBe(code);
}

function resultText(result: AgentToolResult<unknown>): string {
  return result.content
    .filter((entry) => entry.type === 'text')
    .map((entry) => entry.text)
    .join('\n');
}

test('resolves space-relative paths and page links inside the space', () => {
  expect(resolveDocPath('start/quick-start.md')).toEqual(['start', 'quick-start.md']);
  expect(resolveDocPath('./start/./quick-start.md')).toEqual(['start', 'quick-start.md']);
  // A link is resolved against the directory of the document that contains it.
  expect(resolveDocPath('config.md', 'configure/config-file.md')).toEqual(['configure', 'config.md']);
  expect(resolveDocPath('../configure/models.md', 'guides/budgets.md')).toEqual(['configure', 'models.md']);
  expect(resolveDocPath('./../start/./quick-start.md', 'guides/per-chat.md')).toEqual(['start', 'quick-start.md']);
  // Manual links carry heading fragments; the fragment never names a file.
  expect(resolveDocPath('../operations/upgrade.md#镜像标签', 'start/quick-start.md')).toEqual([
    'operations',
    'upgrade.md',
  ]);
  expect(resolveDocPath('telegram.md#自助忽略与恢复', 'configure/admin.md')).toEqual(['configure', 'telegram.md']);
  expect(resolveDocPath('start/quick-start.md#准备')).toEqual(['start', 'quick-start.md']);
  expect(resolveDocPath('#内置用户手册', 'guides/extensions.md')).toEqual(['guides', 'extensions.md']);
});

test('rejects absolute, escaping, malformed, and non-markdown paths', () => {
  expectResolveError('/etc/passwd.md', 'invalid_path');
  expectResolveError('..', 'invalid_path');
  expectResolveError('../outside.md', 'invalid_path');
  expectResolveError('start/../../outside.md', 'invalid_path');
  expectResolveError('../../outside.md', 'invalid_path', 'guides/budgets.md');
  expectResolveError('start//quick-start.md', 'invalid_path');
  expectResolveError('start/../secrets.md', 'invalid_path');
  expectResolveError('C:\\docs\\secret.md', 'invalid_path');
  expectResolveError('start\\quick-start.md', 'invalid_path');
  expectResolveError('start/%2e%2e/secret.md', 'invalid_path');
  expectResolveError('stärke.md', 'invalid_path');
  expectResolveError('', 'invalid_path');
  expectResolveError(`${'a'.repeat(DOC_PATH_MAX_LENGTH)}.md`, 'invalid_path');
  expectResolveError('assets/logo.png', 'unsupported_document');
  expectResolveError('start/quick-start', 'unsupported_document');
  expectResolveError('config.md', 'unsupported_document', 'configure/config-file');
  // Dropping a fragment keeps every other path rule.
  expectResolveError('#section', 'invalid_path');
  expectResolveError('#section', 'invalid_path', '../outside.md');
  expectResolveError('../../outside.md#section', 'invalid_path', 'guides/budgets.md');
  expectResolveError('assets/logo.png#section', 'unsupported_document');
});

test('an empty document space set lists nothing and rejects every read', async () => {
  const spaces = emptyDocSpaces();
  expect(await spaces.spaces(access)).toEqual([]);
  await expectReadError(spaces.index(access, 'manual'), 'unknown_space');
  await expectReadError(spaces.read(access, 'manual', 'index.md'), 'unknown_space');
});

test('loads a space from disk and serves its index and documents', async () => {
  const root = await tempRoot();
  await writePack(root, {
    'start/quick-start.md': '# Quick start\n\nSee [configuration](../configure/config.md).\n',
    'configure/config.md': '# Configuration\n',
  });
  const spaces = await FileSystemDocSpaces.load([bundledManualSpace(root)]);
  expect(spaces.missing).toEqual([]);
  const summaries = await spaces.spaces(access);
  expect(summaries).toEqual([
    {
      id: 'manual',
      title: '塑料碗用户手册',
      description: '塑料碗（Surowan）的部署、配置与维护指南，与当前运行版本一起发布',
      documents: 2,
    },
  ]);

  const index = await spaces.index(access, 'manual');
  expect(index).toEqual({
    space: 'manual',
    path: 'index.md',
    text: '# Fixture manual\n\n- [Start](start/quick-start.md): first page\n',
    truncated: false,
  });

  const page = await spaces.read(access, 'manual', 'start/quick-start.md');
  expect(page).toMatchObject({
    space: 'manual',
    path: 'start/quick-start.md',
    text: '# Quick start\n\nSee [configuration](../configure/config.md).\n',
    truncated: false,
  });
  const linked = await spaces.read(access, 'manual', '../configure/config.md', page.path);
  expect(linked.path).toBe('configure/config.md');
  expect(linked.text).toBe('# Configuration\n');
});

test('reports an uninstalled pack and rejects reads with the available spaces', async () => {
  const spaces = await FileSystemDocSpaces.load([bundledManualSpace(join(await tempRoot(), 'absent'))]);
  expect(spaces.summaries).toEqual([]);
  expect(spaces.missing).toEqual(['manual']);
  expect(await spaces.spaces(access)).toEqual([]);
  await expectReadError(spaces.read(access, 'manual', 'index.md'), 'unknown_space');
  await expect(spaces.read(access, 'manual', 'index.md')).rejects.toThrow('available: none installed');
});

test('treats a root without its index as a packaging error', async () => {
  const root = await tempRoot();
  await mkdir(root, { recursive: true });
  await expect(FileSystemDocSpaces.load([bundledManualSpace(root)])).rejects.toThrow('missing its index document');

  await writePack(root, {});
  await expect(FileSystemDocSpaces.load([{ ...bundledManualSpace(root), id: 'Manual_1' }])).rejects.toThrow(
    'Document space id is invalid',
  );
  await expect(FileSystemDocSpaces.load([bundledManualSpace(root), bundledManualSpace(root)])).rejects.toThrow(
    'Duplicate document space id',
  );
});

test('rejects traversal, absolute paths, non-markdown files, and symlink escapes', async () => {
  const root = await tempRoot();
  const outside = await tempRoot('plasticwan-doc-spaces-outside-');
  await writeFile(join(outside, 'secret.md'), '# Secret\n');
  await writePack(root, { 'start/quick-start.md': '# Quick start\n' });
  await symlink(join(outside, 'secret.md'), join(root, 'leak.md'));
  await symlink(outside, join(root, 'linked'));
  await symlink(join(root, 'start/quick-start.md'), join(root, 'alias.md'));
  const spaces = await FileSystemDocSpaces.load([bundledManualSpace(root)]);

  await expectReadError(spaces.read(access, 'manual', '../secret.md'), 'invalid_path');
  await expectReadError(spaces.read(access, 'manual', '/etc/passwd.md'), 'invalid_path');
  await expectReadError(spaces.read(access, 'manual', 'start/../../secret.md'), 'invalid_path');
  await expectReadError(spaces.read(access, 'manual', 'start/quick-start.png'), 'unsupported_document');
  await expectReadError(spaces.read(access, 'manual', 'start/missing.md'), 'document_not_found');
  await expectReadError(spaces.read(access, 'manual', 'leak.md'), 'document_not_found');
  await expectReadError(spaces.read(access, 'manual', 'linked/secret.md'), 'document_not_found');
  await mkdir(join(root, 'folder.md'), { recursive: true });
  await expectReadError(spaces.read(access, 'manual', 'folder.md'), 'document_not_found');

  // A symlink whose target stays inside the space root is still readable.
  expect((await spaces.read(access, 'manual', 'alias.md')).text).toBe('# Quick start\n');
});

test('bounds a read to the document limit with the shared truncation marker', async () => {
  const root = await tempRoot();
  await writePack(root, { 'reference/fields.md': 'x'.repeat(DOC_READ_MAX_BYTES + 1_024) });
  const spaces = await FileSystemDocSpaces.load([bundledManualSpace(root)]);
  const page = await spaces.read(access, 'manual', 'reference/fields.md');
  expect(page.truncated).toBe(true);
  expect(page.text.endsWith('\n[content truncated]')).toBe(true);
  expect(new TextEncoder().encode(page.text).byteLength).toBeLessThanOrEqual(DOC_READ_MAX_BYTES);
});

interface ToolFixture {
  readonly store: SqliteStore;
  readonly context: InvocationContext;
}

async function toolFixture(): Promise<ToolFixture> {
  const directory = await tempRoot('plasticwan-document-tools-');
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(directory, configPath, testConfigJsonc(directory));
  const loaded = await loadConfig(configPath);
  const configStore = await testConfigStore(loaded);
  const store = await SqliteStore.open(loaded.config);
  const ingestion = new TelegramIngestion(store, configStore, { id: 999 });
  const scheduler = new BucketScheduler(store, configStore, async () => ({ state: 'completed', reason: 'done' }));
  const received = new Date('2026-08-15T00:00:00.000Z');
  ingestion.ingest(
    {
      update_id: 1,
      message: {
        message_id: 10,
        date: 1_700_000_000,
        chat: { id: 123456789, type: 'private', first_name: 'Owner' },
        from: { id: 42, is_bot: false, first_name: 'Alice' },
        text: 'read the manual',
      },
    },
    received,
  );
  const [invocationId] = scheduler.processDue(new Date(received.getTime() + 15_000));
  if (invocationId === undefined) {
    throw new Error('Expected a due invocation');
  }
  const context = renderInvocationContext(store, loaded.config, invocationId, {
    contextWindow: 200_000,
    maxOutputTokens: 32_768,
  });
  return { store, context };
}

test('document tools list spaces, return indexes, read pages, and audit every call', async () => {
  const { store, context } = await toolFixture();
  try {
    const root = await tempRoot();
    await writePack(root, {
      'start/quick-start.md': '# Quick start\n\nSee [configuration](../configure/config.md).\n',
      'configure/config.md': '# Configuration\n',
    });
    const spaces = await FileSystemDocSpaces.load([bundledManualSpace(root)]);
    const [listTool, readTool] = createDocumentTools({ store, spaces, context });

    const listed = await listTool.execute('call-list', {});
    expect(resultText(listed)).toContain('manual: 塑料碗用户手册');
    expect(resultText(listed)).toContain('2 markdown documents');
    expect(listed.details).toEqual({ space: null, documents: 2 });

    const index = await listTool.execute('call-index', { space: 'manual' });
    expect(resultText(index)).toContain('# Fixture manual');
    expect(index.details).toEqual({ space: 'manual', documents: 2 });

    const page = await readTool.execute('call-read', { space: 'manual', path: 'start/quick-start.md' });
    expect(resultText(page)).toContain('# Quick start');
    expect(page.details).toEqual({ space: 'manual', path: 'start/quick-start.md', truncated: false });

    const linked = await readTool.execute('call-link', {
      space: 'manual',
      path: '../configure/config.md',
      base: 'start/quick-start.md',
    });
    expect(resultText(linked)).toContain('# Configuration');

    const audit = store.orm.select().from(toolCalls).where(eq(toolCalls.toolCallId, 'call-list')).get();
    expect(audit).toMatchObject({ toolName: 'list_documents', state: 'success', sideEffect: false });
    expect(audit?.resultText).toContain('manual: 塑料碗用户手册');
    const readAudit = store.orm.select().from(toolCalls).where(eq(toolCalls.toolCallId, 'call-read')).get();
    expect(readAudit).toMatchObject({ toolName: 'read_document', state: 'success', sideEffect: false });
    expect(readAudit?.resultText).toContain('# Quick start');
  } finally {
    store.close();
  }
});

test('document tools surface explicit path and space errors in the audit trail', async () => {
  const { store, context } = await toolFixture();
  try {
    const root = await tempRoot();
    await writePack(root, { 'start/quick-start.md': '# Quick start\n' });
    const spaces = await FileSystemDocSpaces.load([bundledManualSpace(root)]);
    const [listTool, readTool] = createDocumentTools({ store, spaces, context });

    await expect(listTool.execute('call-unknown-space', { space: 'wiki' })).rejects.toThrow(
      'list_documents failed: unknown_space',
    );
    await expect(readTool.execute('call-missing', { space: 'manual', path: 'nope.md' })).rejects.toThrow(
      'read_document failed: document_not_found',
    );
    await expect(readTool.execute('call-escape', { space: 'manual', path: '../secret.md' })).rejects.toThrow(
      'read_document failed: invalid_path',
    );
    await expect(readTool.execute('call-binary', { space: 'manual', path: 'logo.png' })).rejects.toThrow(
      'read_document failed: unsupported_document',
    );

    for (const [toolCallId, errorCode] of [
      ['call-unknown-space', 'unknown_space'],
      ['call-missing', 'document_not_found'],
      ['call-escape', 'invalid_path'],
      ['call-binary', 'unsupported_document'],
    ] as const) {
      const audit = store.orm.select().from(toolCalls).where(eq(toolCalls.toolCallId, toolCallId)).get();
      expect(audit).toMatchObject({ state: 'error', errorCode, sideEffect: false });
    }
  } finally {
    store.close();
  }
});

test('document capabilities are discoverable and callable through the execute registry', async () => {
  const { store, context } = await toolFixture();
  try {
    const root = await tempRoot();
    await writePack(root, { 'start/quick-start.md': '# Quick start\n' });
    const spaces = await FileSystemDocSpaces.load([bundledManualSpace(root)]);
    const execute = createExecuteTool({
      audit: createToolAudit(store, context.invocationId),
      capabilities: createDocumentTools({ store, spaces, context }).map((tool) => capability(tool, false)),
    });

    const found = await execute.execute('call-search', { action: 'search', query: 'documentation' });
    expect(resultText(found)).toContain('list_documents');
    const help = await execute.execute('call-help', { action: 'help', tool: 'read_document' });
    expect(resultText(help)).toContain('space-relative path');
    const called = await execute.execute('call-document', {
      action: 'call',
      tool: 'read_document',
      input: { space: 'manual', path: 'start/quick-start.md' },
    });
    expect(resultText(called)).toContain('# Quick start');
    // execute and the inner capability keep their own audit rows.
    const rows = store.orm.select().from(toolCalls).all();
    expect(rows.filter((row) => row.toolName === 'read_document')).toHaveLength(1);
    expect(
      rows
        .filter((row) => row.toolName === 'execute')
        .map((row) => row.toolCallId)
        .sort(),
    ).toEqual(['call-document', 'call-help', 'call-search']);
  } finally {
    store.close();
  }
});
