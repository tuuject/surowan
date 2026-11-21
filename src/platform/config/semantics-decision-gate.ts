import type { FileChat, TelegramSectionConfig } from './index.ts';

/**
 * Cross-field rules of the Decisions entry gate: an enabled gate must name a
 * credential, and its endpoint must be a plain HTTPS prefix.
 *
 * Split out of `semantics.ts` (which keeps every other rule) so neither file
 * drifts toward the repository's per-file size ceiling; these rules share
 * nothing with the provider, chat and MCP rules kept there.
 */
export function validateDecisionGate(telegram: Pick<TelegramSectionConfig, 'decision_gate' | 'chats'>): void {
  const gate = telegram.decision_gate;
  if (gate?.base_url !== undefined) {
    validateDecisionGateUrl(gate.base_url);
  }
  // Presence only: resolving the reference here would run a `command` SecretRef
  // during `check-config`. A dangling keychain entry is the runtime's problem
  // and admits the batch, which is why `doctor` probes the reference.
  if (gate?.api_key !== undefined) {
    return;
  }
  if (gate?.enabled === true) {
    throw new Error('telegram.decision_gate.api_key is required when telegram.decision_gate.enabled is true');
  }
  // A Chat's own `enabled` wins over the global one, and the credential is
  // global only: a Chat that turns the gate on without it would fail open on
  // every batch, with nothing but `secret_unresolved` rows to show for it.
  // Private chats are left to `validateDecisionGateChat`, whose message names
  // the actual mistake.
  const enabling = telegram.chats.find((chat) => chat.id < 0 && chat.decision_gate?.enabled === true);
  if (enabling !== undefined) {
    throw new Error(
      `telegram.decision_gate.api_key is required when chat ${enabling.id} sets decision_gate.enabled to true`,
    );
  }
}

/**
 * The per-Chat rule: a private chat is a direct conversation, never a batch the
 * gate should decide about.
 */
export function validateDecisionGateChat(chat: Pick<FileChat, 'id' | 'decision_gate'>): void {
  if (chat.decision_gate !== undefined && chat.id > 0) {
    throw new Error(`Chat ${chat.id} is a private chat and cannot configure decision_gate`);
  }
}

/**
 * The client appends `/decisions` (and nothing else) to this value, so it has
 * to be a plain prefix: a query, a fragment or surrounding whitespace would
 * silently build a different URL than the operator wrote.
 */
function validateDecisionGateUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('telegram.decision_gate.base_url must be an absolute HTTPS URL');
  }
  if (value !== value.trim() || url.protocol !== 'https:' || url.username !== '' || url.password !== '') {
    throw new Error('telegram.decision_gate.base_url must be an HTTPS URL without credentials');
  }
  // The literal delimiters, not `url.search` / `url.hash`: both are empty for a
  // bare trailing `?` or `#`, which would still swallow the appended path.
  if (value.includes('?') || value.includes('#')) {
    throw new Error(
      'telegram.decision_gate.base_url must not carry a query or fragment: the client appends /decisions to it',
    );
  }
}
