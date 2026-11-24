import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { defineConfig, normalizeHref } from '@rspress/core';
import { loadLocaleNavigation } from '../../scripts/docs/navigation.ts';
import buildInfo from './content/public/build-info.json';

const contentRoot = resolve(import.meta.dirname, 'content');
const repository = 'https://github.com/tuuject/surowan';
const commitUrl = `${repository}/commit/${buildInfo.commit}`;

/**
 * Per-locale site text is generated from `scripts/docs/locales.ts` into
 * `build-info.json`, so the theme, `llms.txt` and `docs:verify` cannot drift
 * apart. The default locale (`zh`) is served at the site root, `en` under `/en/`.
 */
function localeText(lang: string): (typeof buildInfo.locale)['zh'] {
  if (lang === 'zh') {
    return buildInfo.locale.zh;
  }
  if (lang === 'en') {
    return buildInfo.locale.en;
  }
  throw new Error(`Documentation locale has no site text: ${lang}`);
}

// The sentence is rendered once by `provenanceText` in `scripts/docs/locales.ts`
// and arrives here through `build-info.json`; the theme prints the same string.
const provenance = (lang: string): string => localeText(lang).provenance;

export default defineConfig({
  root: contentRoot,
  outDir: 'dist',
  // No site-wide `title`: Rspress then uses each locale's own title for the
  // document title and the navbar wordmark (塑料碗 / Surowan).
  lang: 'zh',
  description: buildInfo.locale.zh.description,
  icon: '/favicon.svg',
  base: buildInfo.base,
  siteOrigin: buildInfo.siteOrigin,
  ssg: true,
  builderConfig: {
    // Dev has no per-route HTML, so deep links need the SPA shell. Preview serves
    // the SSG output and must 404 missing pages instead of returning the home page.
    // The Rspress CLI sets NODE_ENV before loading this file (dev → development).
    server: { htmlFallback: process.env.NODE_ENV === 'development' ? 'index' : false },
    resolve: {
      alias: {
        // Rspress uses Document without workers or persistence. The compact build
        // omits the unused worker fallback that embeds import.meta.url as a local path.
        flexsearch$: resolve(
          dirname(createRequire(import.meta.resolve('@rspress/core')).resolve('flexsearch')),
          'flexsearch.compact.module.min.js',
        ),
      },
    },
  },
  // SSG-MD preserves public links verbatim, including when pages become llms-full.txt.
  // Resolve the explicit public-resource prefix before either output is rendered.
  replaceRules: [{ search: /__DOCS_BASE__\//g, replace: buildInfo.base }],
  llms: {
    llmsTxt: ({ lang, sections }) => {
      const text = localeText(lang);
      // `/docs/index.md` sits above the three top-nav sections, so Rspress puts it in
      // `Others`; place it first under a localized overview heading instead.
      const overviewTitle = lang === 'en' ? 'Overview' : '总览';
      const ordered = [
        ...sections
          .filter((section) => section.title === 'Others')
          .map((section) => ({ ...section, title: overviewTitle })),
        ...sections.filter((section) => section.title !== 'Others'),
      ];
      return [
        `# ${text.title}`,
        '',
        `> ${text.description}`,
        '',
        provenance(lang),
        `${text.llmsSourceLabel}${commitUrl}`,
        '',
        ...text.llmsNotes,
        '',
        ...ordered.flatMap((section) => [
          `## ${section.title}`,
          '',
          ...section.pages.map((page) => `- [${page.title}](${page.link}): ${page.description ?? ''}`),
          '',
        ]),
      ].join('\n');
    },
  },
  // `.md` and `.html` stay explicit: the site is served as static files, and
  // llms.txt, every page's Markdown source and the redirects depend on the names.
  route: { extensions: ['.md', '.mdx'], cleanUrls: false, localeRedirect: 'never' },
  plugins: [
    {
      name: 'static-search-links',
      modifySearchIndexData(pages) {
        // Rspress 2.0.22 leaves leaf search routes extensionless. Directory routes
        // must keep their slash: this hook also feeds the runtime page-data lookup.
        for (const page of pages) {
          if (!page.routePath.endsWith('/')) {
            page.routePath = normalizeHref(page.routePath, false);
          }
        }
      },
    },
  ],
  markdown: {
    link: {
      checkDeadLinks: {
        excludes: [
          'llms.txt',
          'llms-full.txt',
          'config.schema.json',
          'examples/config.minimal.example.jsonc',
          'examples/config.example.jsonc',
          'examples/system-prompt.example.md',
          'examples/docker-compose.yml',
        ].map((path) => `${buildInfo.base}${path}`),
      },
      checkAnchors: true,
    },
    image: {
      // At `/` Rspress resolves `__DOCS_BASE__/screenshots/...` below
      // `content/public`, so production keeps the exact native check. A subpath
      // base (used by `docs:verify`, never by production) cannot be resolved
      // there; for that base `docs:verify` checks every rendered `src` instead.
      checkDeadImages:
        buildInfo.base === '/' ? true : { excludes: (url: string) => url.startsWith(`${buildInfo.base}screenshots/`) },
    },
  },
  themeConfig: {
    locales: (['zh', 'en'] as const).map((lang) => ({
      lang,
      label: buildInfo.locale[lang].label,
      title: buildInfo.locale[lang].title,
      description: buildInfo.locale[lang].description,
      ...loadLocaleNavigation(contentRoot, lang),
    })),
    lastUpdated: true,
    editLink: { docRepoBaseUrl: `${repository}/tree/main/apps/docs/content` },
    llmsUI: { placement: 'title', viewOptions: ['markdownLink'] },
  },
});
