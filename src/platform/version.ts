import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { compare, parse, type SemVer } from 'semver';

/**
 * Runtime version awareness.
 *
 * A packaged image carries a `version` file written by the Docker build. A
 * source checkout falls back to the exact tag on HEAD, then to a Develop
 * version carrying the commit hash, and finally to a fixed Develop version.
 * `package.json` is deliberately not consulted: a development checkout must
 * never look newer than a release.
 */

export type VersionChannel = 'Release' | 'Staging' | 'Develop';

export interface SurowanVersion {
  readonly version: string;
  readonly channel: VersionChannel;
}

const PROJECT_ROOT = join(import.meta.dirname, '..', '..');
const FALLBACK_VERSION: SurowanVersion = { version: 'v0.0.0-develop', channel: 'Develop' };
const CHANNEL_PRIORITY: Readonly<Record<VersionChannel, number>> = {
  Release: 0,
  Staging: 1,
  Develop: 2,
};

interface ParsedVersion {
  readonly version: string;
  readonly channel: VersionChannel;
  readonly semver: SemVer;
  readonly stagingTimestamp: string | undefined;
  readonly developHash: string | undefined;
}

function parseVersionParts(raw: string): ParsedVersion | undefined {
  const trimmed = raw.trim();
  const withoutPrefix = /^[vV]/.test(trimmed) ? trimmed.slice(1) : trimmed;
  // semver.parse would otherwise accept a second `v` prefix or whitespace after ours.
  if (!/^\d/.test(withoutPrefix)) {
    return undefined;
  }
  const parsed = parse(withoutPrefix);
  if (parsed === null) {
    return undefined;
  }
  const prereleaseText = parsed.prerelease.join('.');
  let channel: VersionChannel = 'Release';
  let stagingTimestamp: string | undefined;
  let developHash: string | undefined;
  const staging = /^next-(\d{14})$/.exec(prereleaseText);
  if (staging !== null) {
    channel = 'Staging';
    stagingTimestamp = staging[1];
  } else {
    const develop = /^develop(?:-([0-9a-fA-F]{7,40}))?$/.exec(prereleaseText);
    if (develop !== null) {
      if (parsed.major !== 0 || parsed.minor !== 0 || parsed.patch !== 0) {
        return undefined;
      }
      channel = 'Develop';
      developHash = develop[1];
    } else if (prereleaseText.startsWith('next-') || prereleaseText.startsWith('develop-')) {
      return undefined;
    }
  }
  return {
    version: `v${withoutPrefix}`,
    channel,
    semver: parsed,
    stagingTimestamp,
    developHash,
  };
}

/** Parses a complete version string, returning its canonical `v`-prefixed form and channel. */
export function parseVersion(raw: string): SurowanVersion | undefined {
  const parsed = parseVersionParts(raw);
  return parsed === undefined ? undefined : { version: parsed.version, channel: parsed.channel };
}

function compareBase(left: SemVer, right: SemVer): number {
  if (left.major !== right.major) {
    return left.major - right.major;
  }
  if (left.minor !== right.minor) {
    return left.minor - right.minor;
  }
  return left.patch - right.patch;
}

function compareParsed(left: ParsedVersion, right: ParsedVersion): number {
  const base = compareBase(left.semver, right.semver);
  if (base !== 0) {
    return base;
  }
  if (left.channel !== right.channel) {
    return CHANNEL_PRIORITY[right.channel] - CHANNEL_PRIORITY[left.channel];
  }
  switch (left.channel) {
    case 'Staging': {
      const timestamp = (left.stagingTimestamp ?? '').localeCompare(right.stagingTimestamp ?? '');
      return timestamp === 0 ? left.version.localeCompare(right.version) : timestamp;
    }
    case 'Develop': {
      const hash = (left.developHash ?? '').localeCompare(right.developHash ?? '');
      return hash === 0 ? left.version.localeCompare(right.version) : hash;
    }
    case 'Release':
      return compare(left.semver, right.semver);
  }
}

/**
 * Compares two complete versions. A positive result means `left` is newer.
 * Release beats Staging beats Develop at the same base version; Staging orders
 * by timestamp and Develop has no update ordering beyond its hash.
 */
export function compareVersions(left: string, right: string): number {
  const leftParsed = parseVersionParts(left);
  const rightParsed = parseVersionParts(right);
  if (leftParsed === undefined || rightParsed === undefined) {
    throw new Error(`Cannot compare invalid versions: ${left} / ${right}`);
  }
  return compareParsed(leftParsed, rightParsed);
}

function parseVersionFile(contents: string): SurowanVersion | undefined {
  let version: string | undefined;
  let declaredChannel: string | undefined;
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#') || line.startsWith('//')) {
      continue;
    }
    const versionField = /(?:^|[\s/,])version\s*[:=]\s*([^\s/,]+)/i.exec(line);
    const channelField = /(?:^|[\s/,])channel\s*[:=]\s*([^\s/,]+)/i.exec(line);
    if (versionField !== null) {
      version = versionField[1];
    }
    if (channelField !== null) {
      declaredChannel = channelField[1];
    }
    // A bare version line is accepted; anything after it is ignored.
    if (versionField === null && channelField === null && version === undefined) {
      version = line;
    }
  }
  if (version === undefined) {
    return undefined;
  }
  const parsed = parseVersion(version);
  if (parsed === undefined) {
    return undefined;
  }
  if (declaredChannel !== undefined && declaredChannel.toLowerCase() !== parsed.channel.toLowerCase()) {
    return undefined;
  }
  return parsed;
}

function readVersionFile(root: string): SurowanVersion | undefined {
  const file = join(root, 'version');
  try {
    if (!statSync(file).isFile()) {
      return undefined;
    }
    return parseVersionFile(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

function gitOutput(root: string, args: readonly string[]): string | undefined {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined;
  }
}

function selectTag(tags: readonly string[]): SurowanVersion | undefined {
  const parsed = tags.flatMap((tag) => {
    const value = parseVersionParts(tag);
    return value === undefined ? [] : [value];
  });
  parsed.sort((left, right) => {
    const channel = CHANNEL_PRIORITY[left.channel] - CHANNEL_PRIORITY[right.channel];
    return channel === 0 ? compareParsed(right, left) : channel;
  });
  const first = parsed[0];
  return first === undefined ? undefined : { version: first.version, channel: first.channel };
}

/**
 * Resolves the running version for a code root. The `version` file always wins;
 * Git is only consulted for an exact tag on HEAD, never a tag from history.
 */
export function resolveVersion(root = PROJECT_ROOT): SurowanVersion {
  const packaged = readVersionFile(root);
  if (packaged !== undefined) {
    return packaged;
  }
  if (existsSync(join(root, '.git'))) {
    const tags = gitOutput(root, ['tag', '--points-at', 'HEAD']);
    if (tags !== undefined) {
      const tagged = selectTag(tags.split(/\r?\n/).filter((tag) => tag.length > 0));
      if (tagged !== undefined) {
        return tagged;
      }
      const hash = gitOutput(root, ['rev-parse', '--short=8', 'HEAD']);
      if (hash !== undefined && /^[0-9a-fA-F]{7,40}$/.test(hash)) {
        return { version: `v0.0.0-develop-${hash}`, channel: 'Develop' };
      }
    }
  }
  return FALLBACK_VERSION;
}

let cachedVersion: SurowanVersion | undefined;

/** The process-wide resolved version; resolution is repeated only for explicit roots. */
export function currentVersion(): SurowanVersion {
  cachedVersion ??= resolveVersion();
  return cachedVersion;
}

/** `Surowan/<version>` for ordinary outbound HTTP requests. */
export function versionUserAgent(): string {
  return `Surowan/${currentVersion().version}`;
}

/** `Mozilla/5.0 Surowan/<version>` for `web_fetch`, which must look like a browser. */
export function webFetchUserAgent(): string {
  return `Mozilla/5.0 ${versionUserAgent()}`;
}
