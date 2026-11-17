/**
 * The configuration fields kept for upgrade compatibility only: the schema
 * still accepts them, but nothing reads them for behaviour. This module is the
 * single definition; `validateFileConfig` names them in the load warning and
 * `assembleRawConfig` copies the present ones onto `RawConfig.deprecated_fields`,
 * where `standingWarnings` derives the `config_fields_deprecated` warning.
 */

export interface DeprecatedConfigField {
  /** The dotted path warnings and reload diffs name. */
  readonly path: string;
  readonly section: 'agent' | 'vision';
  readonly key: string;
  /** What replaces the field, when anything does; folded into the load warning. */
  readonly replacement?: string;
}

export const DEPRECATED_CONFIG_FIELDS: readonly DeprecatedConfigField[] = [
  { path: 'agent.memory_ttl_warning_days', section: 'agent', key: 'memory_ttl_warning_days' },
  {
    path: 'agent.send_empty_text_fallback_enabled',
    section: 'agent',
    key: 'send_empty_text_fallback_enabled',
    replacement: 'set agent.send_empty_text_strategy to "random_text" to keep the old fallback behaviour',
  },
  { path: 'vision.background_sticker_concurrency', section: 'vision', key: 'background_sticker_concurrency' },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The deprecated fields actually present in a parsed or file-level configuration. */
export function deprecatedConfigFields(file: unknown): readonly DeprecatedConfigField[] {
  const root = isRecord(file) ? file : {};
  return DEPRECATED_CONFIG_FIELDS.filter((field) => {
    const section = root[field.section];
    return isRecord(section) && Object.hasOwn(section, field.key);
  });
}
