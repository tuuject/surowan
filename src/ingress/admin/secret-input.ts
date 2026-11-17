import type { JSONPath } from 'jsonc-parser';
import type { SecretRef } from '../../platform/config/index.ts';
import { KEYCHAIN_NAME_PATTERN, nextEntryName, sanitizeEntryName } from '../../platform/keychain.ts';
import { AdminQueryError } from './audit/shared.ts';

/**
 * The one shape every secret-accepting write endpoint takes:
 *
 * - a plaintext string — a new key, named after where it is used;
 * - `{ value, name? }` — a new key with an explicitly chosen entry name;
 * - `{ entry }` — reuse an existing keychain entry at this use.
 *
 * A panel session may pick any existing entry; a programmatic credential (API
 * key or paired client) may only submit new plaintext, because an injected
 * prompt must not be able to walk an existing secret somewhere else.
 */
export type SecretInput = string | { readonly value: string; readonly name?: string } | { readonly entry: string };

/** Who is writing: a panel session, or a programmatic credential. */
export type CallerClass = 'session' | 'programmatic';

/** One secret-accepting field of a write body. */
export interface SecretSlot {
  /** Dot-joined configuration path of the field, as the usage report names it. */
  readonly path: string;
  /**
   * The same field as a JSON path, for edits that write the field directly.
   * A dot-joined string cannot be split back: header names may contain dots.
   */
  readonly editPath: JSONPath;
  /** The SecretRef the file carries at this path right now, if any. */
  readonly current: SecretRef | undefined;
  /** Entry name a fresh secret defaults to; sanitized before use. */
  readonly suggestedName: string;
}

/**
 * What one slot's input turns into. The kinds separate where the caller files
 * each outcome: a `new` secret moves the file's reference (its entry travels
 * with the edit's keys), a `repair` fills in an entry the file already names
 * but the keychain lacks, a `rotate` changes the value under the same name.
 */
export type ResolvedSecret =
  | { readonly kind: 'reuse'; readonly ref: SecretRef }
  | { readonly kind: 'new'; readonly ref: SecretRef; readonly name: string; readonly plaintext: string }
  | { readonly kind: 'repair'; readonly ref: SecretRef; readonly name: string; readonly plaintext: string }
  | { readonly kind: 'rotate'; readonly ref: SecretRef; readonly name: string; readonly plaintext: string };

/** The keychain facts one write request resolves against. */
export interface KeychainUsageForInput {
  /** Names that already exist in the keychain. */
  readonly entries: ReadonlySet<string>;
  /** Entry name → configuration paths referencing it, from the raw file. */
  readonly usage: Readonly<Record<string, readonly string[]>>;
}

/**
 * Request-local name bookkeeping. Every slot of one request resolves against
 * the same allocator, so a name handed out once is reserved for the rest of
 * the request: two slots asking for one explicit name conflict instead of
 * silently sharing an entry, and two derived names cannot collide.
 */
export class SecretAllocator {
  readonly #taken: Set<string>;
  readonly #usage: Readonly<Record<string, readonly string[]>>;

  constructor(entries: ReadonlySet<string>, usage: Readonly<Record<string, readonly string[]>>) {
    this.#taken = new Set(entries);
    this.#usage = usage;
  }

  has(name: string): boolean {
    return this.#taken.has(name);
  }

  /**
   * Whether `name`'s only reference in the raw configuration file is `path`.
   * Own-property lookup: entry names may be `Object.prototype` keys.
   */
  usedOnlyHere(name: string, path: string): boolean {
    if (!Object.hasOwn(this.#usage, name)) {
      return false;
    }
    const paths = this.#usage[name];
    return paths !== undefined && paths.length === 1 && paths[0] === path;
  }

  /** Reserves an explicitly chosen name; a duplicate — in the keychain or in this request — is a conflict. */
  reserveExplicit(name: string): void {
    if (this.#taken.has(name)) {
      throw new AdminQueryError('keychain_exists', `Keychain already has an entry named ${name}`, 409);
    }
    this.#taken.add(name);
  }

  /** The next free derived name for `base` (sanitized), reserved. */
  next(base: string): string {
    const name = nextEntryName(sanitizeEntryName(base), this.#taken);
    this.#taken.add(name);
    return name;
  }
}

/**
 * Turns one submitted secret into the reference and keychain change it needs.
 *
 * A fresh plaintext reuses the slot's *current* entry — whatever its name —
 * when that entry is used nowhere else: the value rotates in place and every
 * other use is untouched. When the current entry is missing from the keychain
 * (a dangling reference, e.g. left by an earlier failure) the submitted value
 * repairs it under the same name. Otherwise a new entry is allocated from the
 * sanitized suggested name, with suffixes for collisions; an explicitly chosen
 * name must be free and is a conflict otherwise.
 */
export function resolveSecretInput(
  input: SecretInput,
  slot: SecretSlot,
  caller: CallerClass,
  allocator: SecretAllocator,
): ResolvedSecret {
  if (typeof input === 'object' && input !== null && 'entry' in input) {
    if (caller === 'programmatic') {
      throw new AdminQueryError(
        'entry_not_allowed',
        'A programmatic credential cannot reference an existing keychain entry; submit the key itself',
        403,
      );
    }
    if (!allocator.has(input.entry)) {
      throw new AdminQueryError('keychain_missing', `Keychain has no entry named ${input.entry}`, 400);
    }
    return { kind: 'reuse', ref: { jar: input.entry } };
  }
  const value = typeof input === 'string' ? input : input.value;
  if (value.length === 0) {
    throw new AdminQueryError('invalid_body', 'The secret must not be empty', 400);
  }
  if (typeof input === 'object' && input.name !== undefined) {
    if (!KEYCHAIN_NAME_PATTERN.test(input.name)) {
      throw new AdminQueryError('invalid_body', 'The entry name must use 1-64 letters, digits, "_" or "-"', 400);
    }
    allocator.reserveExplicit(input.name);
    return { kind: 'new', ref: { jar: input.name }, name: input.name, plaintext: value };
  }
  const currentName = slot.current !== undefined && 'jar' in slot.current ? slot.current.jar : undefined;
  if (currentName !== undefined && allocator.has(currentName)) {
    if (allocator.usedOnlyHere(currentName, slot.path)) {
      // The entry exists for this use alone: rotate its value in place. The
      // file keeps pointing at the same name, so this is not a change.
      return { kind: 'rotate', ref: { jar: currentName }, name: currentName, plaintext: value };
    }
  } else if (currentName !== undefined) {
    // The file names an entry the keychain lacks: the submitted value repairs it.
    return { kind: 'repair', ref: { jar: currentName }, name: currentName, plaintext: value };
  }
  const name = allocator.next(slot.suggestedName);
  return { kind: 'new', ref: { jar: name }, name, plaintext: value };
}

/** Whether two SecretRefs name the same source; values are never compared. */
export function sameSecretRef(left: SecretRef | undefined, right: SecretRef | undefined): boolean {
  if (left === undefined || right === undefined) {
    return left === right;
  }
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Where a configured secret comes from, as a panel session may see it. */
export type SecretSourceView =
  | { readonly kind: 'entry'; readonly name: string }
  | { readonly kind: 'env'; readonly env: string }
  | { readonly kind: 'command' }
  | null;

export function secretSourceOf(reference: SecretRef | undefined): SecretSourceView {
  if (reference === undefined) {
    return null;
  }
  if ('jar' in reference) {
    return { kind: 'entry', name: reference.jar };
  }
  if ('env' in reference) {
    return { kind: 'env', env: reference.env };
  }
  return { kind: 'command' };
}

/** Whether a submitted header value is a fresh plaintext rather than a reuse. */
export function isSubmittedPlaintext(value: SecretInput | null | undefined): boolean {
  if (typeof value === 'string') {
    return true;
  }
  return typeof value === 'object' && value !== null && 'value' in value;
}
