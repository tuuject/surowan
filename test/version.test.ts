import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, test } from 'vitest';
import {
  compareVersions,
  currentVersion,
  parseVersion,
  resolveVersion,
  versionUserAgent,
  webFetchUserAgent,
} from '../src/platform/version.ts';

const directories: string[] = [];

afterAll(async () => {
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'surowan-version-'));
  directories.push(directory);
  return directory;
}

function git(root: string, ...args: string[]): void {
  execFileSync('git', args, { cwd: root, stdio: 'ignore' });
}

async function repository(): Promise<string> {
  const root = await temporaryRoot();
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'version-test@example.com');
  git(root, 'config', 'user.name', 'Version Test');
  await writeFile(join(root, 'tracked.txt'), 'initial\n');
  git(root, 'add', 'tracked.txt');
  git(root, 'commit', '-q', '-m', 'initial');
  return root;
}

test('parses release, staging and develop versions and rejects malformed channel suffixes', () => {
  expect(parseVersion('v1.2.3')).toEqual({ version: 'v1.2.3', channel: 'Release' });
  expect(parseVersion('1.2.3')).toEqual({ version: 'v1.2.3', channel: 'Release' });
  expect(parseVersion('v0.0.0-next-20261102190940')).toEqual({
    version: 'v0.0.0-next-20261102190940',
    channel: 'Staging',
  });
  expect(parseVersion('v0.0.0-develop-deadbeef')).toEqual({
    version: 'v0.0.0-develop-deadbeef',
    channel: 'Develop',
  });
  expect(parseVersion('v0.0.0-develop')).toEqual({ version: 'v0.0.0-develop', channel: 'Develop' });
  expect(parseVersion('v1.0.0-develop-deadbeef')).toBeUndefined();
  expect(parseVersion('v0.0.0-next-tomorrow')).toBeUndefined();
  expect(parseVersion('v0.0.0-develop-')).toBeUndefined();
  expect(parseVersion('v1.2')).toBeUndefined();
});

test('orders releases by SemVer and non-release channels by their own rules', () => {
  expect(compareVersions('v1.2.3', 'v1.2.2')).toBeGreaterThan(0);
  expect(compareVersions('v1.0.0', 'v1.0.0-rc.1')).toBeGreaterThan(0);
  expect(compareVersions('v1.0.0-rc.2', 'v1.0.0-rc.10')).toBeLessThan(0);
  expect(compareVersions('v1.0.0', 'v0.0.0-next-20261102190940')).toBeGreaterThan(0);
  expect(compareVersions('v0.0.0-next-20261102190940', 'v0.0.0-next-20261101171852')).toBeGreaterThan(0);
  expect(compareVersions('v0.0.0-develop-deadbeef', 'v0.0.0-develop-cafebabe')).toBeGreaterThan(0);
});

test('a version file wins over Git state and accepts the documented key/value format', async () => {
  const root = await repository();
  git(root, 'tag', 'v9.9.9');
  await writeFile(join(root, 'version'), 'Version: v1.4.0\nChannel: Release\n');
  expect(resolveVersion(root)).toEqual({ version: 'v1.4.0', channel: 'Release' });
  await writeFile(join(root, 'version'), 'Version: v0.0.0-next-20261102190940 / Channel: Staging\n');
  expect(resolveVersion(root)).toEqual({
    version: 'v0.0.0-next-20261102190940',
    channel: 'Staging',
  });
});

test('selects the newest exact tag on HEAD with Release above Staging above Develop', async () => {
  const root = await repository();
  for (const tag of ['v0.0.0-develop-deadbeef', 'v0.0.0-next-20261101171852', 'v0.0.0-next-20261102190940', 'v1.2.0']) {
    git(root, 'tag', tag);
  }
  expect(resolveVersion(root)).toEqual({ version: 'v1.2.0', channel: 'Release' });

  const stagingOnly = await repository();
  git(stagingOnly, 'tag', 'v0.0.0-develop-deadbeef');
  git(stagingOnly, 'tag', 'v0.0.0-next-20261101171852');
  git(stagingOnly, 'tag', 'v0.0.0-next-20261102190940');
  expect(resolveVersion(stagingOnly)).toEqual({
    version: 'v0.0.0-next-20261102190940',
    channel: 'Staging',
  });
});

test('an untagged checkout reports the current commit as Develop', async () => {
  const root = await repository();
  const hash = execFileSync('git', ['rev-parse', '--short=8', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  expect(resolveVersion(root)).toEqual({ version: `v0.0.0-develop-${hash}`, channel: 'Develop' });
});

test('a directory without Git or a version file falls back to the fixed Develop version', async () => {
  const root = await temporaryRoot();
  expect(resolveVersion(root)).toEqual({ version: 'v0.0.0-develop', channel: 'Develop' });
});

test('the process-wide version feeds both user-agent forms', () => {
  const version = currentVersion();
  expect(versionUserAgent()).toBe(`Surowan/${version.version}`);
  expect(webFetchUserAgent()).toBe(`Mozilla/5.0 Surowan/${version.version}`);
});
