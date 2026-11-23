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
    description:
      '塑料碗 Harness（Surowan Harness）的公开文档：一套人设无关的 Harness 服务端，你选模型、写人格、划定边界；今天接上的真实平台只有 Telegram。',
    provenanceLabel: '文档对应源码提交：',
    dirtyNote: '（含未提交修改，仅供本地预览）',
    cleanNote: '。请先与自己的部署版本核对。',
    llmsNotes: [
      '这是 Harness 服务端的文档，不是某个人设；先核实用户的代码或镜像版本，再读安装与具体任务页。不要读取或转发真实密钥；重启、迁移与覆盖配置前须获得确认。',
      '这是部署文档，不是 Bot 的 System Skills；不保证 Agent 自动发现此索引。',
    ],
    llmsSourceLabel: '源码：',
  },
  en: {
    label: 'English',
    title: 'Surowan',
    description:
      'Public documentation for Surowan Harness: a persona-agnostic harness server where you pick the models, write the persona and set the boundaries. Telegram is the only real platform it connects to today.',
    provenanceLabel: 'Source commit:',
    dirtyNote: ' (uncommitted changes, local preview only)',
    cleanNote: '. Compare it with the version you run.',
    llmsNotes: [
      'These are docs for the harness server, not for one persona: check the source commit the user runs, then read the install and task pages. Never read or forward real secrets; ask before restarting, migrating or overwriting configuration.',
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
