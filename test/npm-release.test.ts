import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { npmRelease } from '../scripts/npm-release.ts';

const env: NodeJS.ProcessEnv = {
  GITHUB_EVENT_NAME: 'push',
  GITHUB_REPOSITORY: 'tuuject/surowan',
  GITHUB_REF: 'refs/heads/main',
  GITHUB_RUN_NUMBER: '123',
  GITHUB_RUN_ATTEMPT: '1',
  GITHUB_SHA: `${'0123456789abcdef'.repeat(2)}01234567`,
};

const packagePath = new URL('../packages/cli/package.json', import.meta.url);
const releaseScript = fileURLToPath(new URL('../scripts/npm-release.ts', import.meta.url));

describe('npm release selection', () => {
  it('publishes main to canary with unique versions for different runs, retries and commits', () => {
    expect(npmRelease(env)).toEqual({ version: '0.0.0-canary.123.1.g0123456789ab', tag: 'canary' });
    const releases = [
      env,
      { ...env, GITHUB_RUN_NUMBER: '124' },
      { ...env, GITHUB_RUN_ATTEMPT: '2' },
      { ...env, GITHUB_SHA: 'a'.repeat(40) },
    ].map((input) => npmRelease(input).version);
    expect(new Set(releases).size).toBe(4);
  });

  it('uses tag vMAJOR.MINOR.PATCH as the exact latest version', () => {
    expect(npmRelease({ ...env, GITHUB_REF: 'refs/tags/v10.20.30' })).toEqual({ version: '10.20.30', tag: 'latest' });
  });

  it.each([
    'refs/pull/1/merge',
    'refs/tags/v1.0',
    'refs/tags/v01.0.0',
    'refs/tags/v1.0.0-rc.1',
    'refs/tags/v9007199254740992.0.0',
    'refs/tags/v1.0.0\ntag=canary',
    '',
  ])('rejects unsupported or malformed ref %j', (ref) => {
    expect(() => npmRelease({ ...env, GITHUB_REF: ref })).toThrow('exact vMAJOR.MINOR.PATCH');
  });

  it.each([
    { GITHUB_EVENT_NAME: 'pull_request' },
    { GITHUB_REPOSITORY: 'someone/surowan' },
    { GITHUB_RUN_NUMBER: '0' },
    { GITHUB_RUN_NUMBER: '123\ntag=latest' },
    { GITHUB_RUN_ATTEMPT: '01' },
    { GITHUB_SHA: 'short' },
    { GITHUB_SHA: '' },
  ])('rejects untrusted or incomplete workflow inputs %j', (override) => {
    expect(() => npmRelease({ ...env, ...override })).toThrow();
  });

  it('writes validated GitHub outputs without changing the package manifest', () => {
    const dir = mkdtempSync(join(tmpdir(), 'surowan-npm-release-'));
    try {
      const output = join(dir, 'output');
      const before = readFileSync(packagePath, 'utf8');
      const result = spawnSync(process.execPath, [releaseScript], {
        env: { ...env, GITHUB_OUTPUT: output },
        encoding: 'utf8',
      });
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(output, 'utf8')).toBe('version=0.0.0-canary.123.1.g0123456789ab\ntag=canary\n');
      expect(readFileSync(packagePath, 'utf8')).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('publishes only the standalone CLI package without bundling a Skill', () => {
    const manifest = JSON.parse(readFileSync(packagePath, 'utf8'));
    expect(manifest.name).toBe('@tuuject/surowan-utils');
    expect(manifest.private).not.toBe(true);
    expect(manifest.publishConfig).toEqual({ access: 'public', registry: 'https://registry.npmjs.org/' });
    expect(manifest.repository).toEqual({
      type: 'git',
      url: 'git+https://github.com/tuuject/surowan.git',
      directory: 'packages/cli',
    });
    expect(manifest.bin).toEqual({ 'surowan-utils': './dist/bin.js' });
    expect(manifest.files).toEqual(['dist', 'README.md']);
    // admin-surface is compiled into dist/bin.js by build.ts; any dependency field
    // naming it makes bun/yarn resolve it from the registry and fail with 404.
    expect(manifest.dependencies).toBeUndefined();
    expect(manifest.bundledDependencies).toBeUndefined();
    expect(manifest.devDependencies['@surowan/admin-surface']).toBe('workspace:^');
    expect(existsSync(new URL('../packages/cli/skills/', import.meta.url))).toBe(false);
    const root = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const image = JSON.parse(readFileSync(new URL('../packages/image-service/package.json', import.meta.url), 'utf8'));
    expect(root.private).toBe(true);
    expect(root.bin).toEqual({ surowan: './src/cli.ts' });
    expect(image.private).toBe(true);
  });
});
