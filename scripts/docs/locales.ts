/**
 * The public documentation site exists in two locales over one tree: `zh` is the
 * default and is served at the site root, `en` is served under `/en/`.
 *
 * Text that must read the same in the site config, the theme, the build artifact
 * and the verifier lives here and nowhere else. `prepareDocs` writes this table
 * into `public/build-info.json`; `apps/docs/rspress.config.ts` and the theme read
 * it back from there; `scripts/docs/verify.ts` compares the artifact with this
 * table, so a theme that drifts from it fails verification.
 */

export const docsLocales = ['zh', 'en'] as const;

export type DocsLocale = (typeof docsLocales)[number];

export interface DocsLocaleText {
  /** The language's own name, as the locale switcher shows it. */
  readonly label: string;
  readonly title: string;
  readonly description: string;
  /** Prefix of the commit-provenance notice on every page and in `llms.txt`. */
  readonly provenanceLabel: string;
  /** Suffix of the same notice when the checkout has uncommitted changes. */
  readonly dirtyNote: string;
  /** Suffix of the same notice for a clean checkout. */
  readonly cleanNote: string;
  /** Standing cautions that follow the provenance in `llms.txt`. */
  readonly llmsNotes: readonly string[];
  /** Label of the source link in `llms.txt`, followed by the commit URL. */
  readonly llmsSourceLabel: string;
}

export const localeText: Record<DocsLocale, DocsLocaleText> = {
  zh: {
    label: '简体中文',
    title: '塑料碗',
    description: '自行部署的 Telegram Agent Bot。部署、配置，以及把碗配置成自己的使用指南。',
    provenanceLabel: '文档对应源码提交：',
    dirtyNote: '（含未提交修改，仅供本地预览）',
    cleanNote: '。请先与自己的部署版本核对。',
    llmsNotes: [
      '先核实用户的代码或镜像版本，再读快速开始与具体任务页。不要读取或转发真实密钥；重启、迁移与覆盖配置前须获得确认。',
      '这是部署文档，不是 Bot 的 System Skills；不保证 Agent 自动发现此索引。',
    ],
    llmsSourceLabel: '源码：',
  },
  en: {
    label: 'English',
    title: 'Surowan',
    description: 'A self-hosted Telegram agent bot. How to deploy it, configure it, and tune it into your own.',
    provenanceLabel: 'Source commit:',
    dirtyNote: ' (uncommitted changes, local preview only)',
    cleanNote: '. Compare it with the version you run.',
    llmsNotes: [
      'Check the source commit the user runs before reading the quick start or any task page. Never read or forward real secrets; ask before restarting, migrating or overwriting configuration.',
      'These are deployment docs, not the Bot system skills; nothing guarantees an agent discovers this index.',
    ],
    llmsSourceLabel: 'Source: ',
  },
};

/** Characters of the commit shown in the provenance sentence; the link carries the full SHA. */
const PROVENANCE_SHA_LENGTH = 12;

/**
 * The one provenance sentence shared by pages, `llms.txt` and `llms-full.txt`.
 * `prepareDocs` renders it into `build-info.json`, the theme and `llms.txt` print
 * it, and `verify.ts` builds the same sentence to check the built output.
 */
export function provenanceText(lang: DocsLocale, commit: string, dirty: boolean): string {
  const text = localeText[lang];
  return `${text.provenanceLabel} ${commit.slice(0, PROVENANCE_SHA_LENGTH)}${dirty ? text.dirtyNote : text.cleanNote}`;
}
