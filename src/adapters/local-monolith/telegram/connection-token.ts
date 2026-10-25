/**
 * What the running process knows about its Telegram Bot Token.
 *
 * A configuration may name a token through any SecretRef, so whether Telegram
 * can run is only decided after resolving it. The three outcomes are different
 * states, not different errors: no token (absent, or a SecretRef that resolves
 * to an empty value) means the user disabled Telegram, a token that cannot be
 * read is a configuration problem, and anything else is a token the connection
 * manager may try.
 */

import { createHash } from 'node:crypto';
import type { RawConfig } from '../../../platform/config/index.ts';
import { EmptySecretError, SecretResolutionError, type SecretStore } from '../../../platform/secrets.ts';

export type TelegramTokenSource =
  /** No `telegram.token`, or one whose value is empty: Telegram is disabled by choice. */
  | { readonly kind: 'disabled' }
  /** A configured SecretRef that cannot be turned into a value. */
  | { readonly kind: 'unreadable'; readonly message: string }
  /** A usable Bot Token. Callers must never log this value. */
  | { readonly kind: 'token'; readonly token: string };

/**
 * Resolves the configured token. Every secret failure is a state the process
 * runs with (`token_unreadable`), not a startup error; only an unexpected
 * resolver fault escapes.
 */
export async function resolveTelegramTokenSource(
  config: RawConfig,
  secrets: SecretStore,
): Promise<TelegramTokenSource> {
  const reference = config.telegram.token;
  if (reference === undefined) {
    return { kind: 'disabled' };
  }
  try {
    const token = await secrets.resolve(reference);
    return { kind: 'token', token };
  } catch (error) {
    // An empty variable or jar entry is the same "Bot Token is empty" as not
    // writing one; only a reference that cannot be read at all is broken.
    if (error instanceof EmptySecretError) {
      return { kind: 'disabled' };
    }
    if (error instanceof SecretResolutionError) {
      return { kind: 'unreadable', message: secrets.redact(error.message) };
    }
    throw error;
  }
}

/**
 * A comparable identity for one source. A reload compares this instead of the
 * SecretRef so rotating a key-jar entry (the file itself did not change) is
 * also noticed; the plaintext never leaves this function in a loggable form.
 */
export function telegramTokenIdentity(source: TelegramTokenSource): string {
  switch (source.kind) {
    case 'disabled':
      return 'disabled';
    case 'unreadable':
      return 'unreadable';
    case 'token':
      return `token:${createHash('sha256').update(source.token).digest('hex').slice(0, 32)}`;
  }
}
