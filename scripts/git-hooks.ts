import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Enables the committed git hooks in .githooks/ by pointing core.hooksPath at it.
 *
 * The path stays relative, and git resolves it against the root of the worktree running the hook, so every
 * worktree runs the hooks of the branch it has checked out and a branch without .githooks/ runs none. It
 * refuses to replace another hooksPath or to hide hooks already installed in the default hooks directory.
 *
 * As the root postinstall (--postinstall) it skips copies without a .git (the Docker build context, source
 * archives) and problems only warn; `pnpm run hooks:install` exits non-zero on any problem.
 */

const HOOKS_PATH = '.githooks';
const root = resolve(import.meta.dirname, '..');
const postinstall = process.argv.includes('--postinstall');

function git(args: string[]): { status: number | null; stdout: string; stderr: string } {
  return spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
}

function install(): string | undefined {
  const current = git(['config', '--get', 'core.hooksPath']);
  const hooksPath = current.stdout.trim();
  if (hooksPath === HOOKS_PATH) {
    return undefined;
  }
  if (hooksPath !== '') {
    return `core.hooksPath is already ${hooksPath}; run the hooks in ${HOOKS_PATH}/ from there`;
  }
  const defaultDir = resolve(root, git(['rev-parse', '--git-path', 'hooks']).stdout.trim());
  const installed = existsSync(defaultDir) ? readdirSync(defaultDir).filter((name) => !name.endsWith('.sample')) : [];
  if (installed.length > 0) {
    return `${defaultDir} has hooks (${installed.join(', ')}) that core.hooksPath would disable; move them into ${HOOKS_PATH}/ or remove them`;
  }
  const set = git(['config', 'core.hooksPath', HOOKS_PATH]);
  return set.status === 0 ? undefined : `git config core.hooksPath failed: ${set.stderr.trim()}`;
}

if (postinstall && !existsSync(join(root, '.git'))) {
  console.log('git-hooks: skipped outside a local git checkout; run `pnpm run hooks:install` to enable git hooks');
} else {
  const problem = install();
  if (problem === undefined) {
    console.log(`git-hooks: core.hooksPath is ${HOOKS_PATH}`);
  } else if (postinstall) {
    console.warn(`git-hooks: ${problem}`);
    console.warn('git-hooks: install continues; fix the above and run `pnpm run hooks:install`');
  } else {
    console.error(`git-hooks: ${problem}`);
    process.exitCode = 1;
  }
}
