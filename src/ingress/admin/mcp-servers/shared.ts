/**
 * Body shapes shared by the MCP server writes and the per-Chat binding write.
 *
 * The configuration's own schemas are the contract: request fields reuse them
 * (via `@platform/config/schema-model`) instead of a second drifting copy, and
 * whatever they cannot express — secret inputs, the stdio refusal — is spelled
 * out here with the same limits the file accepts.
 */
import Type, { type Static } from 'typebox';
import {
  DefaultToolPolicySchema,
  MCP_SERVER_ALIAS_PATTERN,
  McpExposureSchema,
  McpServerDescriptionSchema,
  ToolPolicySchema,
} from '../../../platform/config/schema-model.ts';
import { AdminQueryError } from '../audit/shared.ts';
import type { SecretInput } from '../secret-input.ts';

/** `tools` as the file writes it: the wildcard or an explicit, unique list (which may be empty). */
export const McpToolsBodySchema = Type.Union([
  Type.Literal('*'),
  Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true }),
]);
export type McpToolsBody = Static<typeof McpToolsBodySchema>;

export type ToolPoliciesBody = Static<typeof ToolPolicySchema>[];
export type DefaultToolPolicyBody = Static<typeof DefaultToolPolicySchema>;
export { DefaultToolPolicySchema, McpExposureSchema, McpServerDescriptionSchema, ToolPolicySchema };

/** Header names the panel may write; values go through `readSecretInput`. */
export const HEADER_NAME_MAX_LENGTH = 128;

/** URL length bound, mirroring what an operator would reasonably write. */
export const URL_MAX_LENGTH = 2_048;

export const AliasBodySchema = Type.String({ pattern: MCP_SERVER_ALIAS_PATTERN });

/** A secret input exactly as `secret-input.ts` defines it, or `null` (delete). */
export function readSecretInput(value: unknown, label: string): SecretInput | null {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  if (typeof value === 'string') {
    return value.length > 4_096 ? invalidString(label) : value;
  }
  if (typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.length === 1 && keys[0] === 'entry' && typeof record.entry === 'string') {
      return { entry: record.entry };
    }
    if (
      keys.length >= 1 &&
      keys.length <= 2 &&
      keys.includes('value') &&
      typeof record.value === 'string' &&
      (record.name === undefined || (keys.includes('name') && typeof record.name === 'string'))
    ) {
      return record.name === undefined ? { value: record.value } : { value: record.value, name: record.name };
    }
  }
  return invalidString(label);
}

function invalidString(label: string): never {
  throw invalid(`${label} must be a string of 1-4096 characters, { value, name? } or { entry }`);
}

/** The MCP page's validation error: one code, a message the operator can act on. */
export function invalid(message: string): AdminQueryError {
  return new AdminQueryError('mcp_invalid', message, 400);
}
