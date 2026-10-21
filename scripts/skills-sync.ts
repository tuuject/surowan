import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, symlinkSync, unlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';

/**
 * Installs this checkout's Coding Agent skills.
 *
 * The repository's own skills live in skills/<name>/, the layout that
 * `npx skills add tuuject/surowan` discovers. They are symlinked into the agent
 * skill directories, so edits apply without reinstalling. External skills are
 * pinned in package.json's "skills" field and installed by the `skills` CLI,
 * which records their content hashes in skills-lock.json.
 *
 * As the root postinstall (--postinstall) it skips CI and copies without a .git
 * (the Docker build context, source archives), and problems only warn: agent
 * skills must not fail `pnpm install` when GitHub is unreachable.
 * `pnpm run skills:sync` always runs and exits non-zero on any problem.
 */

const root = resolve(import.meta.dirname, '..');
const sourceDir = join(root, 'skills');
/** The universal directory (Codex and others) and Claude Code's own. */
const agentDirs = [join(root, '.agents', 'skills'), join(root, '.claude', 'skills')];
const postinstall = process.argv.includes('--postinstall');

/** Where `link` points when it is a link this script owns: a directory directly under skills/. */
function ownedTarget(link: string): string | undefined {
  if (!lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink()) {
    return undefined;
  }
  const target = resolve(dirname(link), readlinkSync(link));
  return dirname(target) === sourceDir ? target : undefined;
}

function linkLocalSkills(problems: string[]): void {
  const names = readdirSync(sourceDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(sourceDir, entry.name, 'SKILL.md')))
    .map((entry) => entry.name)
    .sort();
  for (const dir of agentDirs) {
    try {
      mkdirSync(dir, { recursive: true });
      // Drop links to skills that were removed or renamed; never touch other entries.
      for (const name of readdirSync(dir)) {
        const link = join(dir, name);
        const target = ownedTarget(link);
        if (target !== undefined && (!names.includes(name) || target !== join(sourceDir, name))) {
          unlinkSync(link);
        }
      }
      for (const name of names) {
        const link = join(dir, name);
        const target = join(sourceDir, name);
        if (ownedTarget(link) === target) {
          continue;
        }
        if (lstatSync(link, { throwIfNoEntry: false })) {
          problems.push(`${relative(root, link)} exists and is not a link to skills/${name}; left untouched`);
          continue;
        }
        // 'junction' only matters on Windows, where it needs no symlink privilege.
        symlinkSync(relative(dir, target), link, 'junction');
      }
    } catch (error) {
      problems.push(`cannot link skills into ${relative(root, dir)}: ${String(error)}`);
    }
  }
  console.log(`skills-sync: linked ${names.join(', ')} into .agents/skills and .claude/skills`);
}

function syncExternalSkills(problems: string[]): void {
  let cli: string;
  try {
    cli = join(dirname(createRequire(import.meta.url).resolve('skills/package.json')), 'bin', 'cli.mjs');
  } catch {
    problems.push('the skills CLI is not installed (production install?); external skills were not synced');
    return;
  }
  // --include . limits the sync to package.json's own "skills" field: skills shipped
  // inside npm dependencies are not linked. Telemetry stays off for an automated hook.
  const result = spawnSync(
    process.execPath,
    [cli, 'experimental_sync', '--yes', '--agent', 'claude-code', '--include', '.'],
    { cwd: root, stdio: 'inherit', env: { ...process.env, DISABLE_TELEMETRY: '1' } },
  );
  if (result.error) {
    problems.push(`external skills were not synced: ${result.error.message}`);
  } else if (result.status !== 0) {
    problems.push(`external skills were not synced: skills CLI exited with ${result.status ?? result.signal}`);
  }
}

const inCi = !['', '0', 'false'].includes(process.env.CI ?? '');
if (postinstall && (inCi || !existsSync(join(root, '.git')))) {
  console.log('skills-sync: skipped outside a local git checkout; run `pnpm run skills:sync` to install agent skills');
} else {
  const problems: string[] = [];
  linkLocalSkills(problems);
  syncExternalSkills(problems);
  for (const problem of problems) {
    console.warn(`skills-sync: ${problem}`);
  }
  if (problems.length > 0) {
    if (postinstall) {
      console.warn('skills-sync: install continues; fix the above and rerun `pnpm run skills:sync`');
    } else {
      process.exitCode = 1;
    }
  }
}
