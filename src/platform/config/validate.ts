import type { JSONPath } from 'jsonc-parser';
import Compile from 'typebox/compile';
import type { TLocalizedValidationError } from 'typebox/error';
import type { FileConfig } from './index.ts';
import { activeVisionModel, completeAgentSettings, resolveAgentSettings } from './resolve.ts';
import { ConfigSchema, ImageSectionSchema } from './schema.ts';
import { validateSemantics } from './semantics.ts';
import type { SearchProviderRule } from '../web-search.ts';

/**
 * File-shape validation: refuses plaintext secrets, soft-disables an invalid
 * `image` section with a warning, and hands a schema-valid file to
 * `validateSemantics` for the rules the schema cannot express.
 */

/** File name of the key jar; kept here so validation messages name it without file I/O imports. */
export const KEY_JAR_FILE = 'key.json';

/** Validate a parsed configuration independently of its source or location. */
export function validateFileConfig(
  parsed: unknown,
  options: ValidateFileConfigOptions = {},
): { fileConfig: FileConfig; warnings: readonly string[] } {
  const plaintext = plaintextSecrets(parsed);
  if (plaintext.length > 0) {
    // The schema would only report a failed union at each of these paths.
    throw new Error(
      `Invalid config: plaintext secrets are not accepted; move them into ${KEY_JAR_FILE} and reference them as { "jar": "<name>" }: ${plaintext.map((secret) => secret.path.join('.')).join(', ')}`,
    );
  }
  // Invalid image configuration is intentionally disabled with a warning,
  // while all other sections fail validation.
  const warnings: string[] = [];
  const root = asRecord(parsed);
  if (root.image !== undefined && !imageValidator.Check(root.image)) {
    const details = imageValidator
      .Errors(root.image)
      .slice(0, 5)
      .map((error) => `${error.instancePath || '/image'}: ${formatValidationError(error)}`)
      .join('; ');
    warnings.push(
      `image generation disabled: the "image" section is invalid and was ignored (${details}); fix or remove it to enable image generation`,
    );
    delete root.image;
  }
  if (!validator.Check(parsed)) {
    const details = validator
      .Errors(parsed)
      .slice(0, 10)
      .map((error) => `${error.instancePath || '/'}: ${formatValidationError(error)}`)
      .join('; ');
    throw new Error(`Invalid config: ${details}`);
  }
  validateSemantics(parsed, options);
  if (completeAgentSettings(resolveAgentSettings(parsed)) === undefined) {
    warnings.push(
      'agent.provider, agent.model and agent.thinking_level are not all set: the bot will run without starting any invocation',
    );
  }
  if (activeVisionModel(parsed.vision) === undefined) {
    warnings.push(
      'vision.provider and vision.model are not both set: read_image and background sticker indexing are unavailable',
    );
  }
  return { fileConfig: parsed, warnings };
}

export interface ValidateFileConfigOptions {
  /**
   * The search providers the loaded plugins register. Omitted falls back to the
   * bundled provider set, which is what every path without plugin context uses.
   */
  readonly searchProviders?: readonly SearchProviderRule[];
}

const validator = Compile(ConfigSchema);
const imageValidator = Compile(ImageSectionSchema);

/**
 * The SecretRef fields of a parsed configuration that still hold a plain
 * string, as written before the key jar existed. Only the error message depends
 * on this list, so a field missing from it degrades to the schema's own error
 * rather than to anything unsafe.
 */
export function plaintextSecrets(parsed: unknown): { readonly path: JSONPath; readonly value: string }[] {
  const found: { path: JSONPath; value: string }[] = [];
  const check = (value: unknown, path: JSONPath): void => {
    if (typeof value === 'string') {
      found.push({ path, value });
    }
  };
  const checkEach = (record: unknown, path: JSONPath): void => {
    for (const [name, value] of Object.entries(asRecord(record))) {
      check(value, [...path, name]);
    }
  };
  const root = asRecord(parsed);
  check(asRecord(root.telegram).token, ['telegram', 'token']);
  for (const [alias, provider] of Object.entries(asRecord(root.providers))) {
    check(asRecord(provider).api_key, ['providers', alias, 'api_key']);
    checkEach(asRecord(provider).headers, ['providers', alias, 'headers']);
  }
  const servers = asRecord(root.mcp).servers;
  for (const [index, server] of (Array.isArray(servers) ? servers : []).entries()) {
    checkEach(asRecord(server).env, ['mcp', 'servers', index, 'env']);
    checkEach(asRecord(server).headers, ['mcp', 'servers', index, 'headers']);
  }
  const engines = asRecord(root.web_search).engines;
  for (const [index, engine] of (Array.isArray(engines) ? engines : []).entries()) {
    check(asRecord(engine).api_key, ['web_search', 'engines', index, 'api_key']);
  }
  return found;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * TypeBox reports an unexpected key as a bare "must not have additional properties", which forces
 * callers to diff their file against the schema by hand. The offending names live in `params`.
 */
function formatValidationError(error: TLocalizedValidationError): string {
  if (error.keyword === 'additionalProperties') {
    return `${error.message}: ${error.params.additionalProperties.join(', ')}`;
  }
  return error.message;
}
