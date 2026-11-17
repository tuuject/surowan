import { checkbox, input, password, search, select } from '@inquirer/prompts';
import type { ProviderApi, SecretRef } from '../platform/config/index.ts';
import { KEYCHAIN_NAME_PATTERN, nextEntryName, readKeychain, updateKeychain } from '../platform/keychain.ts';

export type ApiAdapter = ProviderApi;

const API_ADAPTER_LABELS: Record<ApiAdapter, string> = {
  'openai-responses': 'OpenAI Responses API',
  'openai-completions': 'OpenAI Chat Completions API',
  'anthropic-messages': 'Anthropic Messages API',
  'google-generative-ai': 'Google Generative AI API (base URL must include the version path)',
};

/**
 * A typed value goes into the keychain right away, so fetching models can
 * resolve it before the configuration is saved; an entry left behind by a
 * discarded session is cleaned up through the panel's keychain manager.
 *
 * The entry name defaults to where the secret is used and stays editable; a
 * name that already exists is rejected instead of silently suffixed.
 */
export async function promptSecretRef(
  message: string,
  keychainFile: string,
  options: { readonly suggestedName?: string } = {},
): Promise<SecretRef> {
  const entries = await readKeychain(keychainFile);
  const taken = new Set(Object.keys(entries ?? {}));
  type SecretKind = 'new' | 'entry' | 'env' | 'command';
  const choices: { value: SecretKind; name: string; description?: string }[] = [
    { value: 'new', name: 'New key (stored in key.json)' },
    ...(taken.size > 0 ? [{ value: 'entry' as const, name: 'Use an existing entry' }] : []),
    {
      value: 'env',
      name: 'Environment variable',
      description: 'Recommended: reads from an environment variable at runtime',
    },
    { value: 'command', name: 'External command', description: 'Runs a fixed argv and uses stdout as the secret' },
  ];
  const kind = await select<SecretKind>({
    message: `${message}: source`,
    choices,
  });
  switch (kind) {
    case 'entry': {
      const name = await search({
        message: `${message}: entry`,
        source: (term) =>
          Promise.resolve(
            [...taken]
              .filter((candidate) => term === undefined || term.length === 0 || candidate.includes(term))
              .map((candidate) => ({ value: candidate, name: candidate })),
          ),
      });
      return { jar: name };
    }
    case 'env': {
      const env = await input({
        message: `${message}: environment variable name`,
        validate: (value) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(value) || 'Invalid environment variable name',
      });
      return { env };
    }
    case 'command': {
      const commandString = await input({
        message: `${message}: command (space-separated argv)`,
        validate: (value) => value.trim().length > 0 || 'Command cannot be empty',
      });
      return { command: commandString.trim().split(/\s+/) };
    }
    default: {
      const value = await password({
        message: `${message}: value`,
        mask: true,
        validate: (candidate) => candidate.length > 0 || 'Secret cannot be empty',
      });
      const name = await input({
        message: 'Entry name in key.json',
        ...(options.suggestedName === undefined ? {} : { default: nextEntryName(options.suggestedName, taken) }),
        validate: (candidate) => {
          if (!KEYCHAIN_NAME_PATTERN.test(candidate)) {
            return 'Use 1-64 letters, digits, "_" or "-"';
          }
          return !taken.has(candidate) || `Keychain already has an entry named ${candidate}`;
        },
      });
      await updateKeychain(keychainFile, { add: { [name]: value } });
      return { jar: name };
    }
  }
}

export async function promptApiAdapter(message = 'API adapter'): Promise<ApiAdapter> {
  return select<ApiAdapter>({
    message,
    choices: (Object.keys(API_ADAPTER_LABELS) as ApiAdapter[]).map((value) => ({
      value,
      name: API_ADAPTER_LABELS[value],
    })),
  });
}

export async function promptInputCapabilities(
  initial: Array<'text' | 'image'> = ['text'],
): Promise<Array<'text' | 'image'>> {
  const selected = await checkbox<'text' | 'image'>({
    message: 'Input capabilities',
    choices: [
      { value: 'text', name: 'Text', checked: initial.includes('text') },
      { value: 'image', name: 'Image', checked: initial.includes('image') },
    ],
    required: true,
  });
  return selected;
}

export async function promptPositiveInteger(message: string, initial?: number): Promise<number> {
  const value = await input({
    message,
    default: initial !== undefined ? String(initial) : undefined,
    validate: (raw) => {
      const number = Number(raw);
      if (!Number.isInteger(number) || number < 1) {
        return 'Must be a positive integer';
      }
      return true;
    },
  });
  return Number(value);
}

export async function promptNonNegativeNumber(message: string, initial?: number): Promise<number> {
  const value = await input({
    message,
    default: initial !== undefined ? String(initial) : undefined,
    validate: (raw) => {
      const number = Number(raw);
      if (Number.isNaN(number) || number < 0) {
        return 'Must be a non-negative number';
      }
      return true;
    },
  });
  return Number(value);
}

export async function promptString(message: string, initial?: string, required = true): Promise<string> {
  return input({
    message,
    default: initial,
    validate: (value) => {
      if (!required) {
        return true;
      }
      return value.trim().length > 0 || 'Required';
    },
  });
}
