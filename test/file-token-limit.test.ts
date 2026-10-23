import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Real commits in a scratch repository whose core.hooksPath is this checkout's .githooks/.
const hooksPath = fileURLToPath(new URL('../.githooks', import.meta.url));
const LIMIT_BYTES = 20_000;

let dir: string;
let repo: string;

function git(...args: string[]) {
  const settings = {
    'core.hooksPath': hooksPath,
    'user.name': 'Test',
    'user.email': 'test@example.com',
    'commit.gpgsign': 'false',
    'init.defaultBranch': 'main',
    'merge.conflictStyle': 'merge',
  };
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(dir, 'no-global-config'),
    GIT_CONFIG_COUNT: String(Object.keys(settings).length),
  };
  Object.entries(settings).forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  return spawnSync('git', args, { cwd: repo, encoding: 'utf8', env });
}

function write(path: string, content: string | Buffer): void {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), content);
}

function stage(files: Record<string, string | Buffer>): void {
  for (const [path, content] of Object.entries(files)) {
    write(path, content);
  }
  expect(git('add', '--', ...Object.keys(files)).status).toBe(0);
}

function commits(): number {
  return Number(git('rev-list', '--count', 'HEAD').stdout.trim() || 0);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'plasticwan-token-limit-'));
  repo = join(dir, 'repo');
  mkdirSync(repo);
  expect(git('init', '-q').status).toBe(0);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('pre-commit file token limit', () => {
  it('accepts files at exactly 5,000 tokens and rejects the commit when any file is one byte over', () => {
    stage({ 'src/exact.ts': 'a'.repeat(LIMIT_BYTES) });
    expect(git('commit', '-qm', 'exact').status).toBe(0);

    stage({ 'src/big.test.ts': 'a'.repeat(LIMIT_BYTES + 1), 'docs/guide.md': 'b'.repeat(LIMIT_BYTES * 2) });
    const rejected = git('commit', '-qm', 'too big');
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toMatch(/src\/big\.test\.ts +5,001 tokens \(20,001 bytes, 1 over\)/);
    expect(rejected.stderr).toMatch(/docs\/guide\.md +10,000 tokens/);
    expect(rejected.stderr).toContain('src/big-<topic>.test.ts');
    expect(rejected.stderr).toContain('docs/guide-<topic>.md');
    expect(commits()).toBe(1);
  });

  it('measures the staged content, not the working tree', () => {
    write('untracked.ts', 'a'.repeat(LIMIT_BYTES * 2));
    stage({ 'src/a.ts': 'small' });
    write('src/a.ts', 'a'.repeat(LIMIT_BYTES * 2));
    expect(git('commit', '-qm', 'staged small, unstaged big', '--', 'src/a.ts').status).toBe(1);
    expect(git('commit', '-qm', 'staged small, unstaged big').status).toBe(0);

    stage({ 'src/a.ts': 'a'.repeat(LIMIT_BYTES * 2) });
    write('src/a.ts', 'small');
    const rejected = git('commit', '-qm', 'staged big, unstaged small');
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain('src/a.ts');
    expect(rejected.stderr).not.toContain('untracked.ts');
    expect(commits()).toBe(1);
  });

  it('skips generated, vendored, binary and agent-doc files, and allows deleting an oversized file', () => {
    const big = 'a'.repeat(LIMIT_BYTES * 2);
    stage({
      'pnpm-lock.yaml': big,
      'apps/admin-next/src/routeTree.gen.ts': big,
      'apps/admin-next/src/components/ui/sidebar.tsx': big,
      'agent-doc/admin-panel.md': big,
      'agent-doc/research/im-gif/measurements.json': big,
      'assets/cover.bin': Buffer.alloc(LIMIT_BYTES * 2),
    });
    expect(git('commit', '-qm', 'generated').status).toBe(0);

    stage({ 'src/legacy.ts': big });
    expect(git('commit', '-qm', 'legacy', '--no-verify').status).toBe(0);
    stage({ 'src/legacy.ts': `${big}// edit\n` });
    expect(git('commit', '-qm', 'edit legacy').status).toBe(1);
    expect(git('rm', '-qf', 'src/legacy.ts').status).toBe(0);
    expect(git('commit', '-qm', 'delete legacy').status).toBe(0);
  });

  it('concluding a merge checks only the paths the resolution changed', () => {
    stage({ 'shared.txt': 'base\n' });
    expect(git('commit', '-qm', 'base').status).toBe(0);
    expect(git('switch', '-qc', 'other').status).toBe(0);
    stage({ 'shared.txt': 'other\n', 'src/theirs.ts': 'a'.repeat(LIMIT_BYTES * 2) });
    expect(git('commit', '-qm', 'other', '--no-verify').status).toBe(0);
    expect(git('switch', '-q', 'main').status).toBe(0);
    stage({ 'shared.txt': 'main\n' });
    expect(git('commit', '-qm', 'main').status).toBe(0);
    expect(git('merge', '-q', 'other').status).toBe(1);

    stage({ 'shared.txt': 'a'.repeat(LIMIT_BYTES * 2) });
    const rejected = git('commit', '-qm', 'merge');
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain('shared.txt');
    expect(rejected.stderr).not.toContain('src/theirs.ts');

    stage({ 'shared.txt': 'main and other\n' });
    expect(git('commit', '-qm', 'merge').status).toBe(0);
    expect(git('rev-parse', '-q', '--verify', 'HEAD^2').status).toBe(0);
  });
});
