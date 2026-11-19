/**
 * Header secrets of an HTTP MCP server write: the submitted `SecretInput` per
 * header name, resolved against what the file already carries into SecretRefs
 * plus the keychain entries to create, repair or rotate.
 */
import type { SecretRef } from '../../../platform/config/index.ts';
import type { KeychainReplacement } from '../../../platform/config/write.ts';
import type { CallerClass } from '../secret-input.ts';
import { resolveSecretInput, type SecretAllocator } from '../secret-input.ts';
import { invalid, readSecretInput } from './shared.ts';

/** Resolves one submitted header against what the file already carries. */
export function resolveHeaders(
  alias: string,
  fileIndex: number,
  submitted: Readonly<Record<string, ReturnType<typeof readSecretInput>>>,
  existing: Readonly<Record<string, SecretRef>> | undefined,
  caller: CallerClass,
  allocator: SecretAllocator,
  keys: Record<string, string>,
  repairs: Record<string, string>,
  replacements: KeychainReplacement[],
): Readonly<Record<string, SecretRef>> {
  const resolved: Record<string, SecretRef> = Object.create(null);
  for (const [name, input] of Object.entries(submitted)) {
    if (input === null) {
      continue;
    }
    const slot = {
      path: `mcp.servers.${fileIndex}.headers.${name}`,
      editPath: ['mcp', 'servers', fileIndex, 'headers', name],
      current: existing?.[name],
      suggestedName: `mcp-${alias}-${name}`,
    };
    const outcome = resolveSecretInput(input, slot, caller, allocator);
    if (outcome.kind === 'new') {
      keys[outcome.name] = outcome.plaintext;
    } else if (outcome.kind === 'repair') {
      repairs[outcome.name] = outcome.plaintext;
    } else if (outcome.kind === 'rotate') {
      replacements.push({ name: outcome.name, value: outcome.plaintext, requestedBy: slot.path });
    }
    resolved[name] = outcome.ref;
  }
  return resolved;
}

export function readHeaderInputs(
  value: unknown,
  label: string,
  allowNull = false,
): Readonly<Record<string, ReturnType<typeof readSecretInput>>> {
  if (value === undefined) {
    return {};
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalid(`${label} must be an object of header names to secrets`);
  }
  // Null prototype: header names are arbitrary strings, and the accumulators
  // must keep even awkward ones (e.g. `constructor`) as own properties
  // instead of hitting anything inherited from Object.prototype.
  const inputs: Record<string, ReturnType<typeof readSecretInput>> = Object.create(null);
  for (const [name, entry] of Object.entries(value as Record<string, unknown>)) {
    if (name === '__proto__') {
      // The configuration loader parses JSONC with plain objects, and that one
      // name is lost on every read — a written `__proto__` header would be dead
      // config the runtime never sees. Refusing it is the honest answer.
      throw invalid(
        "a header cannot be named '__proto__': the configuration parser drops that name; rename the header",
      );
    }
    const input = readSecretInput(entry, `${label}.${name}`);
    if (input === null && !allowNull) {
      throw invalid(`${label}.${name} must carry a secret`);
    }
    inputs[name] = input;
  }
  return inputs;
}
