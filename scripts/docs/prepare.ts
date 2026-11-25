import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, readdir, rm, rmdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ConfigSchema } from '../../src/platform/config/schema.ts';
import { isGeneratedPage, renderGeneratedPages } from './generated-pages.ts';
import { docsLocales, localeText, provenanceText } from './locales.ts';
import { renderRedirects } from './redirects.ts';

export const repositoryRoot = resolve(import.meta.dirname, '..', '..');
export const docsRoot = resolve(repositoryRoot, 'apps/docs');
/** Shared by both locales; the smallest runnable configuration leads. */
export const exampleNames = [
  'config.minimal.example.jsonc',
  'config.example.jsonc',
  'system-prompt.example.md',
  'docker-compose.yml',
] as const;

// The Compose template lives at the repository root so README and the docs site
// share a single deployment file; every other example lives in apps/docs/examples.
export function exampleSource(name: (typeof exampleNames)[number]): string {
  return name === 'docker-compose.yml' ? resolve(repositoryRoot, name) : resolve(docsRoot, 'examples', name);
}

/** Hand-written and generated pages of one locale live under `content/<lang>/docs`. */
function localeDocsRoot(lang: (typeof docsLocales)[number]): string {
  return resolve(docsRoot, 'content', lang, 'docs');
}

export function deploymentSettings(env: NodeJS.ProcessEnv): { siteOrigin: string; base: string } {
  const siteOrigin = env.DOCS_SITE_ORIGIN ?? '';
  const base = env.DOCS_BASE_PATH ?? '/';
  if (!/^\/(?:[A-Za-z0-9_-]+\/)*$/.test(base)) {
    throw new Error('DOCS_BASE_PATH must be / or slash-delimited URL segments ending in /');
  }
  if (siteOrigin) {
    const url = new URL(siteOrigin);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== siteOrigin) {
      throw new Error('DOCS_SITE_ORIGIN must be an HTTP(S) origin without credentials, path, query or fragment');
    }
  }
  return { siteOrigin, base };
}

/**
 * The pre-reorganization prepare wrote its field reference to
 * `content/docs/reference/fields*.md`. Those files are untracked, so an upgraded
 * checkout would otherwise report a dirty tree (and a local-preview provenance)
 * forever; delete them, then the old tree's directories if nothing else is left.
 */
async function removeLegacyGeneratedPages(): Promise<void> {
  const legacyTree = resolve(docsRoot, 'content/docs');
  const reference = join(legacyTree, 'reference');
  const names = await readdir(reference).catch(() => [] as string[]);
  for (const name of names) {
    if (name === 'fields.md' || /^fields-[a-z0-9-]+\.md$/.test(name)) {
      await rm(join(reference, name), { force: true });
    }
  }
  // `rmdir` refuses a non-empty directory, which is exactly the case we must keep.
  await rmdir(reference).catch(() => undefined);
  await rmdir(legacyTree).catch(() => undefined);
}

/** Removes generated pages a previous run left behind, so a removed section cannot stay published. */
async function removeStaleGeneratedPages(root: string): Promise<void> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) {
      continue;
    }
    const path = relative(root, resolve(entry.parentPath, entry.name)).split(sep).join('/');
    if (isGeneratedPage(path)) {
      await rm(resolve(entry.parentPath, entry.name));
    }
  }
}

export async function prepareDocs(): Promise<void> {
  // Before `git status`: a stale legacy reference must not keep the build marked dirty.
  await removeLegacyGeneratedPages();
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: repositoryRoot, encoding: 'utf8' }).trim();
  const commit = git('rev-parse', 'HEAD');
  const dirty = git('status', '--porcelain', '--untracked-files=normal').length > 0;
  if (!/^[a-f0-9]{40}$/.test(commit)) {
    throw new Error('A full Git commit is required for documentation provenance');
  }
  const publicRoot = resolve(docsRoot, 'content/public');
  await mkdir(resolve(publicRoot, 'examples'), { recursive: true });
  await writeFile(
    resolve(publicRoot, 'build-info.json'),
    `${JSON.stringify(
      {
        commit,
        dirty,
        ...deploymentSettings(process.env),
        // Each locale's site text plus the one provenance sentence every output prints.
        locale: Object.fromEntries(
          docsLocales.map((lang) => [lang, { ...localeText[lang], provenance: provenanceText(lang, commit, dirty) }]),
        ),
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(resolve(publicRoot, 'config.schema.json'), `${JSON.stringify(ConfigSchema, null, 2)}\n`);
  for (const lang of docsLocales) {
    const root = localeDocsRoot(lang);
    await removeStaleGeneratedPages(root);
    for (const [path, content] of renderGeneratedPages(lang)) {
      await mkdir(dirname(resolve(root, path)), { recursive: true });
      await writeFile(resolve(root, path), content);
    }
  }
  // Redirects are the only user-facing compatibility the reorganized site keeps.
  await writeFile(resolve(publicRoot, '_redirects'), renderRedirects(deploymentSettings(process.env).base));
  for (const name of exampleNames) {
    await copyFile(exampleSource(name), resolve(publicRoot, 'examples', name));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await prepareDocs();
}
