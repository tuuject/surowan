import type { DocsLocale } from '../locales.ts';

/**
 * Every string the generated configuration field reference prints. The pages are
 * generated for both locales from the same schema, so the wording lives here and
 * the renderer never branches on the locale.
 */
export interface FieldsText {
  readonly indexTitle: string;
  readonly indexDescription: string;
  readonly indexIntro: string;
  readonly sectionTitle: (section: string) => string;
  readonly sectionDescription: (section: string) => string;
  readonly sectionIntro: string;
  /** Preamble of the index and of every section page. */
  readonly notice: readonly string[];
  readonly typeLine: (type: string, required: boolean) => string;
  /** A `default` the Schema itself declares. */
  readonly schemaDefault: (value: string) => string;
  /** A value the running process uses when the field is absent, taken from the code. */
  readonly runtimeDefault: (value: string) => string;
  /** The same, for a default that is a rule rather than one value. */
  readonly runtimeDefaultRule: (value: string) => string;
  /** A default that only exists while the whole section is absent, e.g. `telegram`. */
  readonly runtimeDefaultWithoutSection: (value: string, section: string) => string;
  /** A `description` written on the Schema node; quoted as the source text it is. */
  readonly description: (value: string) => string;
  readonly deprecated: string;
  /** What to do instead of a deprecated field; the same text the index table shows. */
  readonly deprecatedAction: (note: string) => string;
  /** A `patternProperties` key pattern, which constrains the key names of a record. */
  readonly keyPattern: (pattern: string) => string;
  readonly limits: (limits: readonly string[]) => string;
  /** Limits that belong to one non-object union branch rather than to the field. */
  readonly branchLimits: (branch: string, limits: readonly string[]) => string;
  readonly sectionLink: (section: string, file: string) => string;
  readonly schemaLine: string;
  readonly patternKey: string;
  readonly unionBranch: (index: number) => string;
  /** `telegram.bucket_max_seconds` follows the configured window, not a constant. */
  readonly bucketMaxDefault: string;
  readonly decisionInstructionsDefault: string;
  readonly deprecatedTitle: string;
  readonly deprecatedIntro: string;
  readonly deprecatedHeader: readonly [string, string, string];
  readonly noReplacement: string;
  /** Locale wording for a deprecated field's replacement, where the source text is English prose. */
  readonly deprecatedNotes: Readonly<Record<string, string>>;
  readonly mcpRequiredNote: string;
  readonly sectionPageLink: (section: string, file: string) => string;
}

export const FIELDS_TEXT: Record<DocsLocale, FieldsText> = {
  zh: {
    indexTitle: '配置字段参考',
    indexDescription: '从当前源码 ConfigSchema 生成的字段类型、必填性、取值限制与默认值，按配置段分页。',
    indexIntro: '本页与各配置段的分页由同一提交的 ConfigSchema 自动生成。',
    sectionTitle: (section) => `配置字段参考：${section}`,
    sectionDescription: (section) => `从当前源码 ConfigSchema 生成的 ${section} 段字段类型、必填性、取值限制与默认值。`,
    sectionIntro: '本页由同一提交的 ConfigSchema 自动生成，属于[配置字段参考](fields.md)。',
    notice: [
      '**必填是相对于所在对象而言**；可选对象未启用时不要求它的子字段。',
      '可选不等于有默认值。**Schema 声明默认**是 Schema 上标注的 `default`：它只是给人和工具看的约定，加载器不会把缺省值填进文件，各消费方自己按缺省处理。**运行时默认**是省略该字段时解析代码实际使用的值，是否生效取决于解析范围：`agent.context.ref_ttl_hours` 在 `agent.context` 存在、只省略这一项时也会被补齐；`telegram.bucket_window_seconds` 只有整个 `telegram` 段缺失时才有默认值，段存在时它必填。类型合法也不等于通过跨字段语义校验，默认行为、热更新与覆盖关系请读[配置生命周期](lifecycle.md)。',
      '所有对象都是闭合的（`additionalProperties: false`）：写到 Schema 之外的键会被直接拒绝，而不是忽略。唯一例外是 `image` 段：结构不合法时它会被整段剥离、降级为「图片生成禁用」，并留下一条警告，进程照常启动，见[配置文件入门](index.md)。',
      '类型里的「（分支 n）」是 Schema 联合类型（`anyOf`）的其中一个分支；某个分支自己的限制标在「分支限制」里。',
    ],
    typeLine: (type, required) => `类型：\`${type}\`；${required ? '必填' : '可选'}。`,
    schemaDefault: (value) => `Schema 声明默认：\`${value}\`。`,
    runtimeDefault: (value) => `运行时默认（省略时实际生效）：\`${value}\`。`,
    runtimeDefaultRule: (value) => `运行时默认（省略时实际生效）：${value}。`,
    runtimeDefaultWithoutSection: (value, section) =>
      `整个 \`${section}\` 段缺失时的默认值：\`${value}\`（段存在时该字段必填）。`,
    deprecatedAction: (note) => `现在怎么办：${note}。`,
    keyPattern: (pattern) => `键名必须匹配：\`${pattern}\`。`,
    description: (value) => `源码里的 Schema 说明（英文原文）：${value}`,
    deprecated: '**已废弃**：字段仍被接受但无任何效果，请删除。',
    limits: (limits) => `限制：${limits.map((limit) => `\`${limit}\``).join('，')}。`,
    branchLimits: (branch, limits) => `分支限制${branch}：${limits.map((limit) => `\`${limit}\``).join('，')}。`,
    sectionLink: (section, file) => `字段见[\`${section}\` 段字段参考](${file})。`,
    schemaLine: '[下载 JSON Schema](__DOCS_BASE__/config.schema.json)。日常配置优先从[配置文件入门](index.md)开始。',
    patternKey: '名称',
    unionBranch: (index) => `（分支 ${index + 1}）`,
    bucketMaxDefault: '与 `telegram.bucket_window_seconds` 相同',
    decisionInstructionsDefault: '内置的是非问句（`DECISION_GATE_DEFAULT_INSTRUCTIONS`），改写后需重新观察',
    deprecatedTitle: '已废弃但仍被接受的字段',
    deprecatedIntro:
      '这些字段只为升级兼容而保留：Schema 仍接受它们，运行时完全不读取，所以写与不写行为一样。出现时会有一条加载警告（`check-config` 的 `warnings` 与 `serve` 的 `config_warnings` 日志），并在面板「警告」页作为常态警告持续列出，直到从文件里删除。增删改这些字段按热应用处理，不需要重启，唯一变化是警告随之出现或消失。',
    deprecatedHeader: ['字段', '现在怎么办', '字段参考'],
    noReplacement: '没有替代字段，直接删除',
    deprecatedNotes: {
      'agent.send_empty_text_fallback_enabled':
        '改设 `agent.send_empty_text_strategy` 为 `"random_text"` 可保留旧的兜底行为',
    },
    mcpRequiredNote: '没有效果：启动不再等待 MCP 服务器，连不上时服务器会在后台重试并记为 `degraded`，请删除',
    sectionPageLink: (section, file) => `[\`${section}\` 段](${file})`,
  },
  en: {
    indexTitle: 'Configuration field reference',
    indexDescription:
      'Field types, required fields, value limits and defaults generated from the ConfigSchema in this commit, split by configuration section.',
    indexIntro: 'This page and the per-section pages are generated from the ConfigSchema of the same commit.',
    sectionTitle: (section) => `Configuration field reference: ${section}`,
    sectionDescription: (section) =>
      `Field types, required fields, value limits and defaults of the ${section} section, generated from the ConfigSchema in this commit.`,
    sectionIntro:
      'This page is generated from the ConfigSchema of the same commit and belongs to the [configuration field reference](fields.md).',
    notice: [
      '**"Required" is relative to the enclosing object**: when an optional object is absent, its child fields are not required.',
      'Optional does not mean "has a default". A **schema default** is the `default` annotated on the Schema: it is a convention for people and tools, the loader never writes it into the file, and each consumer applies its own fallback. A **runtime default** is the value the resolving code uses when the field is absent, and whether it applies depends on how far that resolver reaches: `agent.context.ref_ttl_hours` is filled in as soon as `agent.context` exists, while `telegram.bucket_window_seconds` only has a default when the whole `telegram` section is absent — inside a present section it is required. Passing the type check does not mean the cross-field rules pass — read [configuration lifecycle](lifecycle.md) for defaults, hot application and overrides.',
      'Every object is closed (`additionalProperties: false`): a key the Schema does not declare is rejected, not ignored. The one exception is the `image` section: when it is structurally invalid it is stripped, image generation is treated as disabled and a warning is recorded, while the rest of the process starts — see [configuration file basics](index.md).',
      'A "branch n" in a type is one branch of a Schema union (`anyOf`); limits that belong to that branch alone are printed as branch limits.',
    ],
    typeLine: (type, required) => `Type: \`${type}\`; ${required ? 'required' : 'optional'}.`,
    schemaDefault: (value) => `Schema default: \`${value}\`.`,
    runtimeDefault: (value) => `Runtime default (used when omitted): \`${value}\`.`,
    runtimeDefaultRule: (value) => `Runtime default (used when omitted): ${value}.`,
    runtimeDefaultWithoutSection: (value, section) =>
      `Default when the whole \`${section}\` section is absent: \`${value}\` (required inside a present section).`,
    deprecatedAction: (note) => `What to do now: ${note}.`,
    keyPattern: (pattern) => `Key names must match: \`${pattern}\`.`,
    description: (value) => `Schema note from the source: ${value}`,
    deprecated: '**Deprecated**: the field is still accepted but has no effect; remove it.',
    limits: (limits) => `Limits: ${limits.map((limit) => `\`${limit}\``).join(', ')}.`,
    branchLimits: (branch, limits) => `Branch limits${branch}: ${limits.map((limit) => `\`${limit}\``).join(', ')}.`,
    sectionLink: (section, file) => `See [the \`${section}\` field reference](${file}).`,
    schemaLine:
      '[Download the JSON Schema](__DOCS_BASE__/config.schema.json). For everyday configuration start from [configuration file basics](index.md).',
    patternKey: 'name',
    unionBranch: (index) => ` (branch ${index + 1})`,
    bucketMaxDefault: 'the value of `telegram.bucket_window_seconds`',
    decisionInstructionsDefault:
      'the built-in yes/no question (`DECISION_GATE_DEFAULT_INSTRUCTIONS`); changing it needs a fresh shadow run',
    deprecatedTitle: 'Deprecated fields the Schema still accepts',
    deprecatedIntro:
      'These fields exist for upgrade compatibility only: the Schema still accepts them, nothing reads them at runtime, so writing them changes nothing. While one is present you get a load warning (`warnings` from `check-config`, the `config_warnings` log event from `serve`) and a standing entry on the panel Warnings page until you delete it. Adding, removing or editing them counts as a hot change: no restart, and the only visible difference is the warning.',
    deprecatedHeader: ['Field', 'What to do now', 'Field reference'],
    noReplacement: 'no replacement; delete it',
    // The replacement text `deprecated.ts` carries is English prose already.
    deprecatedNotes: {},
    mcpRequiredNote:
      'no effect: startup never waits for an MCP server, an unreachable one retries in the background and is reported as `degraded` — delete it',
    sectionPageLink: (section, file) => `[\`${section}\` section](${file})`,
  },
};
