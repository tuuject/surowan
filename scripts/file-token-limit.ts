import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

/**
 * Pre-commit guard: rejects staged files over 5,000 tokens (estimated as bytes / 4) so a coding agent can
 * always read a whole file at once. It measures the staged blob, never the working tree: unstaged edits and
 * untracked files cannot block a commit, while `git commit -a` and `git commit <path>` are still covered
 * because git points GIT_INDEX_FILE at the index it is about to commit while the hook runs.
 *
 * .githooks/pre-commit runs it; scripts/git-hooks.ts points core.hooksPath there.
 */

const MAX_TOKENS = 5_000;
const BYTES_PER_TOKEN = 4;
const MAX_BYTES = MAX_TOKENS * BYTES_PER_TOKEN;

/**
 * Git glob pathspecs exempt from the limit: files that tools write rather than agents, plus agent-doc/ and the
 * system prompt partitions. Binary
 * files need no entry: git's own detection (`binary` in .gitattributes, or NUL bytes) skips them. Never list a
 * hand-written file here to get it past the limit; split it.
 */
const IGNORED = [
  '**/*.lock',
  '**/*-lock.json',
  '**/*-lock.yaml',
  // TanStack Router's route tree (apps/admin-next/src/routeTree.gen.ts).
  '**/*.gen.ts',
  // `pnpm patch-commit` output.
  'patches/*.patch',
  // Components vendored by the shadcn CLI.
  'apps/admin-next/src/components/ui/**',
  // Maintainer decision: Markdown files has no size limit.
  '**/*.md',
];

type Kind = 'code' | 'test' | 'markdown' | 'other';

interface Oversized {
  path: string;
  bytes: number;
}

function git(args: string[], input = ''): string {
  const result = spawnSync('git', args, { encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`git ${args[0]} failed: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

/** Added, copied, modified and type-changed staged text files that are not ignored. */
function stagedTextFiles(): string[] {
  const common = ['--cached', '-z', '--no-renames', '--no-textconv', '--diff-filter=d'];
  const pathspecs = ['--', ':/', ...IGNORED.map((glob) => `:(top,glob,exclude)${glob}`)];
  const paths: string[] = [];
  for (const record of git(['diff', '--numstat', ...common, ...pathspecs]).split('\0')) {
    // `<added>\t<deleted>\t<path>`; git prints `-` counts for binary files.
    const [added, , ...path] = record.split('\t');
    if (added !== undefined && added !== '-' && path.length > 0) {
      paths.push(path.join('\t'));
    }
  }
  // Concluding a merge stages everything the other branch changed. Only paths whose staged content differs
  // from that branch too are this commit's own work (conflict resolutions and combined edits).
  if (paths.length > 0 && existsSync(git(['rev-parse', '--git-path', 'MERGE_HEAD']).trim())) {
    const changed = new Set(git(['diff', '--name-only', ...common, 'MERGE_HEAD', ...pathspecs]).split('\0'));
    return paths.filter((path) => changed.has(path));
  }
  return paths;
}

function oversizedFiles(paths: string[]): Oversized[] {
  if (paths.length === 0) {
    return [];
  }
  // `:0:<path>` is the stage-0 index entry, i.e. exactly what this commit records.
  const sizes = git(
    ['cat-file', '--batch-check=%(objecttype) %(objectsize)', '-z'],
    paths.map((path) => `:0:${path}\0`).join(''),
  ).split('\n');
  return paths.flatMap((path, index) => {
    // Gitlinks (submodules) resolve to commits or missing objects; only blobs are files.
    const [type, size] = (sizes[index] ?? '').split(' ');
    return type === 'blob' && Number(size) > MAX_BYTES ? [{ path, bytes: Number(size) }] : [];
  });
}

function kindOf(path: string): Kind {
  if (/\.(test|spec|e2e)\.[cm]?[jt]sx?$/.test(path)) {
    return 'test';
  }
  if (/\.mdx?$/.test(path)) {
    return 'markdown';
  }
  if (/\.[cm]?[jt]sx?$/.test(path)) {
    return 'code';
  }
  return 'other';
}

/** `dir/name.test.ts` → `dir/name-<topic>.test.ts`. */
function topicPath(path: string): string {
  return path.replace(/((?:\.(?:test|spec|e2e))?\.[^./]+)?$/, '-<topic>$1');
}

function count(value: number): string {
  return value.toLocaleString('en-US');
}

function instructions(kind: Kind, paths: string[]): string[] {
  const files = paths.join(', ');
  const [first = ''] = paths;
  switch (kind) {
    case 'code':
      return [
        `Source code (${files}):`,
        '  - List the top-level declarations and group the ones that call each other into topics.',
        `  - Move each topic verbatim into a sibling module named after it, e.g. ${topicPath(first)},`,
        '    or turn the file into a directory of modules once it needs more than two or three.',
        '  - Export only what other modules use and point every importer at the new module (keep the .ts',
        '    suffix on local imports). Do not leave a re-export shim behind.',
        '  - Run `pnpm run check` and the tests that cover the moved code.',
      ];
    case 'test':
      return [
        `Tests (${files}):`,
        `  - Split along describe() blocks: move each block into its own file, e.g. ${topicPath(first)}.`,
        '  - Move setup that several files need (fixtures, builders, fake servers) into a shared helper',
        '    module and import it; do not copy it into each file.',
        '  - Run every new file and confirm the total number of tests is unchanged.',
      ];
    case 'markdown':
      return [
        `Markdown (${files}):`,
        `  - Move each large \`##\` section into its own page in the same directory, e.g. ${topicPath(first)},`,
        '    and keep the original as a short overview that links to every page.',
        '  - Search the repository for links to the moved anchors (`<file>.md#`) and point them at the new pages.',
        '  - Register new pages where the directory is indexed: agent-doc/README.md, the sibling _meta.json',
        '    under apps/docs/content/docs/, or the "Where to Look" table in AGENTS.md.',
      ];
    case 'other':
      return [
        `Other files (${files}):`,
        '  - Split the content by topic or record group into several files and make the consumer read all of them.',
      ];
  }
}

function report(oversized: Oversized[]): string {
  const width = Math.max(...oversized.map(({ path }) => path.length));
  const byKind = Map.groupBy(oversized, ({ path }) => kindOf(path));
  return [
    `pre-commit: ${oversized.length} staged file(s) exceed the ${count(MAX_TOKENS)}-token limit ` +
      `(tokens = bytes / ${BYTES_PER_TOKEN}, so at most ${count(MAX_BYTES)} bytes per file):`,
    '',
    ...oversized.map(({ path, bytes }) => {
      const tokens = Math.ceil(bytes / BYTES_PER_TOKEN);
      return `  ${path.padEnd(width)}  ${count(tokens)} tokens (${count(bytes)} bytes, ${count(tokens - MAX_TOKENS)} over)`;
    }),
    '',
    'Split each file along its responsibilities into smaller files before committing. Aim for',
    '2,000-3,500 tokens (8-14 KB) per new file so the next edit does not hit the limit again.',
    'Do not shrink the text instead (minifying, deleting comments, joining lines), and do not',
    'bypass this check with `git commit --no-verify`.',
    '',
    ...[...byKind].flatMap(([kind, files]) => [
      ...instructions(
        kind,
        files.map(({ path }) => path),
      ),
      '',
    ]),
    'Then stage the new files and the shortened or removed originals (`git add -A <paths>`) and commit again.',
    'Only a file that a tool writes and nobody edits by hand (lockfile, codegen, captured output) may be',
    'exempted instead: add its glob to IGNORED in scripts/file-token-limit.ts.',
  ].join('\n');
}

const oversized = oversizedFiles(stagedTextFiles());
if (oversized.length > 0) {
  console.error(report(oversized));
  process.exitCode = 1;
}
