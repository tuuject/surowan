import { expect, test } from 'vitest';
import { GROUP_MEMORY_DEFAULT_IDLE_MINUTES } from '../../src/context/group-memory/index.ts';
import { renderConfigFieldPages } from '../../scripts/docs/config-fields/index.ts';
import { DEPRECATED_CONFIG_FIELDS } from '../../src/platform/config/deprecated.ts';
import { AGENT_DEFAULTS, TELEGRAM_DEFAULTS, VISION_DEFAULTS } from '../../src/platform/config/resolve.ts';
import { DECISION_GATE_DEFAULTS } from '../../src/platform/decision-gate.ts';
import { DOC_READ_MAX_BYTES } from '../../src/platform/doc-spaces.ts';
import { MODELS_DEV_URL } from '../../src/platform/models-dev.ts';
import { DEFAULT_ATTENTION_WINDOW_SECONDS } from '../../src/platform/participation.ts';

/**
 * The generated field reference is the page an operator and the Bot both read
 * instead of the Schema. These tests pin the facts the generator is responsible
 * for — union-branch constraints, Schema-declared defaults, defaults imported
 * from the runtime constants, key patterns and the deprecated fields — in both
 * locales.
 */

const LOCALES = ['zh', 'en'] as const;

type Locale = (typeof LOCALES)[number];

function page(lang: Locale, name: string): string {
  return renderConfigFieldPages(lang).get(name) ?? '';
}

function allPages(lang: Locale): string {
  return [...renderConfigFieldPages(lang).values()].join('\n');
}

/** One field's block: from its heading up to the next heading of the same page. */
function entry(text: string, heading: string): string {
  const start = text.indexOf(heading);
  expect(start, heading).toBeGreaterThan(-1);
  const next = text.indexOf('\n#', start + heading.length);
  return text.slice(start, next === -1 ? undefined : next);
}

test('the field pages are imported from their own module, not re-exported', async () => {
  // `generated-pages.ts` is the registry for every generated page set; the field
  // reference lives in `config-fields/`. Callers import the names from where they
  // are defined, so the registry does not carry compatibility aliases.
  const registry = (await import('../../scripts/docs/generated-pages.ts')) as unknown as Record<string, unknown>;
  expect(typeof registry.renderGeneratedPages).toBe('function');
  expect('renderConfigFieldPages' in registry).toBe(false);
  expect('FIELDS_INDEX_PAGE' in registry).toBe(false);
  expect('isConfigFieldSectionPage' in registry).toBe(false);
});

test('union array branches publish their item and array constraints', () => {
  // `mcp.servers[].tools` is `"*"` or a string array, so `tools[]` and the
  // array's `uniqueItems` sit below the field instead of on it.
  const mcp = {
    zh: page('zh', 'configuration/fields-mcp.md'),
    en: page('en', 'configuration/fields-mcp.md'),
  };
  expect(mcp.zh).toContain('`mcp.servers[]（分支 1）.tools[]`');
  expect(mcp.en).toContain('`mcp.servers[] (branch 1).tools[]`');
  for (const text of [mcp.zh, mcp.en]) {
    expect(text).toContain('`minLength: 1`');
    expect(text).toContain('`uniqueItems: true`');
  }
  expect(mcp.zh).toContain('分支限制（分支 2）');
  expect(mcp.en).toContain('Branch limits (branch 2)');
  // The same shape below a Chat's MCP binding.
  expect(page('en', 'configuration/fields-telegram.md')).toContain('`telegram.chats[].mcp[].tools[]`');
});

test('every Schema keyword the ConfigSchema uses is rendered', () => {
  const en = allPages('en');
  // `maxLength`, `pattern` and `const` unions appear in the schema, but the old
  // generator printed only a fixed subset of the value keywords.
  expect(en).toContain('`maxLength: 80`');
  expect(en).toContain('`pattern: "^[a-zA-Z0-9_-]{1,80}$"`');
  expect(en).toContain('Type: `"off" / "minimal"');
  expect(en).toContain('`maxItems: 64`');
  // Closed objects are stated once per page rather than on every field, with the
  // one exception the loader really has.
  expect(en).toContain('Every object is closed (`additionalProperties: false`)');
  expect(en).toContain('The one exception is the `image` section');
  expect(page('zh', 'configuration/fields.md')).toContain('唯一例外是 `image` 段');
  // A Schema `description` is shown as the source note it is.
  expect(en).toContain('Schema note from the source: The probability at or above which');
});

test('a patternProperties key pattern is published with its entry', () => {
  // `image.credentials` is a record whose key names are constrained too; the
  // value shape alone would let a reader write a key that the loader rejects.
  for (const lang of LOCALES) {
    const image = page(lang, 'configuration/fields-image.md');
    const label = lang === 'zh' ? '键名必须匹配：' : 'Key names must match: ';
    expect(image, lang).toContain(`${label}\`^[a-zA-Z0-9_-]{1,80}$\``);
  }
});

test('schema defaults and runtime defaults are labelled apart', () => {
  for (const lang of LOCALES) {
    const schemaLabel = lang === 'zh' ? 'Schema 声明默认：' : 'Schema default: ';
    const runtimeLabel = lang === 'zh' ? '运行时默认' : 'Runtime default';
    // Declared by the Schema itself.
    expect(page(lang, 'configuration/fields-developer.md')).toContain(`${schemaLabel}\`false\``);
    // Taken from the runtime constants, never copied into the generator.
    const agent = page(lang, 'configuration/fields-agent.md');
    expect(agent).toContain(runtimeLabel);
    expect(agent).toContain(String(AGENT_DEFAULTS.daily_budget.max_tokens));
    expect(agent).toContain(`\`${AGENT_DEFAULTS.context.idle_grace_seconds}\``);
    expect(agent).toContain(`\`${AGENT_DEFAULTS.rate_limits.turns_per_injection}\``);
    expect(page(lang, 'configuration/fields-vision.md')).toContain(String(VISION_DEFAULTS.max_output_tokens));
    const telegram = page(lang, 'configuration/fields-telegram.md');
    expect(telegram).toContain(DECISION_GATE_DEFAULTS.model);
    expect(telegram).toContain(String(DECISION_GATE_DEFAULTS.threshold));
    expect(telegram).toContain(String(TELEGRAM_DEFAULTS.bucket_window_seconds));
    expect(telegram).toContain(String(DEFAULT_ATTENTION_WINDOW_SECONDS));
    expect(telegram).toContain(`\`${GROUP_MEMORY_DEFAULT_IDLE_MINUTES}\``);
    expect(page(lang, 'configuration/fields-models-dev.md')).toContain(MODELS_DEV_URL);
  }
});

test('a runtime default on a required field names the absent ancestor', () => {
  // `process_bot_messages` and `bucket_window_seconds` are required whenever
  // `telegram` is present; `TELEGRAM_DEFAULTS` only applies to a missing section.
  for (const lang of LOCALES) {
    const telegram = page(lang, 'configuration/fields-telegram.md');
    const absent = lang === 'zh' ? '整个 `telegram` 段缺失时' : 'when the whole `telegram` section is absent';
    expect(telegram, lang).toContain(absent);
    const omitted = lang === 'zh' ? '运行时默认（省略时实际生效）' : 'Runtime default (used when omitted)';
    const window = entry(telegram, '### `telegram.bucket_window_seconds`');
    expect(window, lang).toContain(absent);
    expect(window, lang).not.toContain(omitted);
    const botMessages = entry(telegram, '### `telegram.process_bot_messages`');
    expect(botMessages, lang).toContain(absent);
    expect(botMessages, lang).not.toContain(omitted);
  }
});

test('the field index lists every deprecated field with its replacement', () => {
  for (const lang of LOCALES) {
    const index = page(lang, 'configuration/fields.md');
    for (const field of DEPRECATED_CONFIG_FIELDS) {
      expect(index, field.path).toContain(`\`${field.path}\``);
      expect(index, field.path).toContain(`fields-${field.section}.md`);
    }
    // Accepted by the MCP schema for the same upgrade-compatibility reason.
    expect(index).toContain('`mcp.servers[].required`');
    expect(index).toContain('fields-mcp.md');
    // The one replacement that names a different configuration field.
    expect(index).toContain('send_empty_text_strategy');
    expect(index).toContain('random_text');
  }
});

test('section pages mark deprecated fields and repeat the migration note', () => {
  for (const lang of LOCALES) {
    const deprecated = lang === 'zh' ? '**已废弃**' : '**Deprecated**';
    const whatToDo = lang === 'zh' ? '现在怎么办：' : 'What to do now: ';
    // `mcp.servers[].required` has no `deprecated: true` in the Schema, so the
    // renderer has to know it from the deprecated list.
    const mcp = page(lang, 'configuration/fields-mcp.md');
    const required = entry(
      mcp,
      lang === 'zh' ? '#### `mcp.servers[]（分支 1）.required`' : '#### `mcp.servers[] (branch 1).required`',
    );
    expect(required, lang).toContain(deprecated);
    expect(required, lang).toContain(whatToDo);
    expect(required, lang).toContain('degraded');
    // The replacement text a deprecated field's Schema description carried must
    // still reach the section page.
    const agent = page(lang, 'configuration/fields-agent.md');
    const fallback = entry(
      agent,
      lang === 'zh'
        ? '#### `agent（分支 1）.send_empty_text_fallback_enabled`'
        : '#### `agent (branch 1).send_empty_text_fallback_enabled`',
    );
    expect(fallback, lang).toContain(whatToDo);
    expect(fallback, lang).toContain('send_empty_text_strategy');
    expect(fallback, lang).toContain('random_text');
  }
});

test('both locales publish the same sections and every page fits one document read', () => {
  const zh = renderConfigFieldPages('zh');
  const en = renderConfigFieldPages('en');
  expect([...zh.keys()]).toEqual([...en.keys()]);
  for (const pages of [zh, en]) {
    for (const [path, content] of pages) {
      expect(Buffer.byteLength(content), path).toBeLessThanOrEqual(DOC_READ_MAX_BYTES);
      expect(content, path).not.toContain('undefined');
      expect(content.startsWith('---\ntitle: '), path).toBe(true);
    }
  }
});
