import type { ApiKeyMode } from './ingress/admin/api-keys.ts';
import {
  DEFAULT_PAIRING_TTL_SECONDS,
  DEFAULT_WEB_PAIRING_NAME,
  MAX_PAIRING_TTL_SECONDS,
  MIN_PAIRING_TTL_SECONDS,
} from './ingress/admin/clients/index.ts';
import { isValidPublicKey } from './ingress/admin/clients/keys.ts';

type Command = 'serve' | 'check-config' | 'doctor' | 'backup' | 'configure' | 'admin-account' | 'pairing' | 'clients';

/**
 * The `pairing` / `clients` family, which manages paired clients and one-time
 * pairing tickets. Unlike `admin-account`, these run against a live `serve` and
 * therefore never take the data directory lock.
 */
export type AdminCredentialCommand =
  | {
      readonly kind: 'pairing-create';
      readonly name: string;
      readonly mode: ApiKeyMode;
      readonly ttlSeconds: number;
      /** Pre-bound key: only this exact key may claim the ticket. */
      readonly publicKey: string | null;
    }
  /** A ticket the Admin Panel login page exchanges for a session. */
  | { readonly kind: 'pairing-create-web'; readonly name: string; readonly ttlSeconds: number }
  | { readonly kind: 'pairing-list' }
  | { readonly kind: 'pairing-cancel'; readonly pairingId: string }
  | { readonly kind: 'clients-list' }
  | { readonly kind: 'clients-revoke'; readonly clientId: string };

export interface CliOptions {
  readonly command: Command;
  readonly configPath: string;
  readonly outputAgentPrompt: boolean;
  readonly takeover: boolean;
  readonly username: string | undefined;
  readonly passwordStdin: boolean;
  readonly revokePasskeys: boolean;
  /** Set only for `pairing` / `clients`; every other command leaves it undefined. */
  readonly adminCredentials: AdminCredentialCommand | undefined;
}

const COMMANDS: readonly string[] = [
  'serve',
  'check-config',
  'doctor',
  'backup',
  'configure',
  'admin-account',
  'pairing',
  'clients',
];

const MODES: readonly ApiKeyMode[] = ['read', 'read_write', 'read_paid', 'all'];
const MAX_NAME_LENGTH = 80;

export function parseCli(argv: readonly string[]): CliOptions {
  const [commandValue, ...argumentsList] = argv;
  if (commandValue === undefined || !isCommand(commandValue)) {
    throw new Error(usage());
  }
  const positionals: string[] = [];
  let configPath: string | undefined;
  let outputAgentPrompt = false;
  let takeover = false;
  let username: string | undefined;
  let passwordStdin = false;
  let revokePasskeys = false;
  let name: string | undefined;
  let mode: string | undefined;
  let ttlSeconds: string | undefined;
  let publicKey: string | undefined;
  let web = false;
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === undefined) {
      continue;
    }
    if (!argument.startsWith('--')) {
      positionals.push(argument);
      continue;
    }
    // Each flag names the one command that accepts it; anything else is a
    // usage error rather than a silently ignored option.
    const takeValue = (): string => {
      const found = argumentsList[index + 1];
      if (found === undefined || found.startsWith('--')) {
        throw new Error(usage());
      }
      index += 1;
      return found;
    };
    if (argument === '--output-agent-prompt' && commandValue === 'doctor' && !outputAgentPrompt) {
      outputAgentPrompt = true;
      continue;
    }
    if (argument === '--takeover' && commandValue === 'serve' && !takeover) {
      takeover = true;
      continue;
    }
    if (argument === '--password-stdin' && commandValue === 'admin-account' && !passwordStdin) {
      passwordStdin = true;
      continue;
    }
    if (argument === '--revoke-passkeys' && commandValue === 'admin-account' && !revokePasskeys) {
      revokePasskeys = true;
      continue;
    }
    if (argument === '--username' && commandValue === 'admin-account' && username === undefined) {
      username = takeValue();
      continue;
    }
    if (argument === '--name' && commandValue === 'pairing' && name === undefined) {
      name = takeValue();
      continue;
    }
    if (argument === '--mode' && commandValue === 'pairing' && mode === undefined) {
      mode = takeValue();
      continue;
    }
    if (argument === '--ttl-seconds' && commandValue === 'pairing' && ttlSeconds === undefined) {
      ttlSeconds = takeValue();
      continue;
    }
    if (argument === '--public-key' && commandValue === 'pairing' && publicKey === undefined) {
      publicKey = takeValue();
      continue;
    }
    if (argument === '--web' && commandValue === 'pairing' && !web) {
      web = true;
      continue;
    }
    if (argument !== '--config' || configPath !== undefined) {
      throw new Error(usage());
    }
    configPath = takeValue();
  }
  if (configPath === undefined) {
    throw new Error(usage());
  }
  if (commandValue === 'pairing' || commandValue === 'clients') {
    const adminCredentials = parseAdminCredentials(commandValue, positionals, {
      name,
      mode,
      ttlSeconds,
      publicKey,
      web,
    });
    return {
      command: commandValue,
      configPath,
      outputAgentPrompt,
      takeover,
      username,
      passwordStdin,
      revokePasskeys,
      adminCredentials,
    };
  }
  if (positionals.length > 0) {
    throw new Error(usage());
  }
  if (commandValue === 'admin-account' && username === undefined) {
    throw new Error(usage());
  }
  return {
    command: commandValue,
    configPath,
    outputAgentPrompt,
    takeover,
    username,
    passwordStdin,
    revokePasskeys,
    adminCredentials: undefined,
  };
}

interface PairingFlagValues {
  readonly name: string | undefined;
  readonly mode: string | undefined;
  readonly ttlSeconds: string | undefined;
  readonly publicKey: string | undefined;
  readonly web: boolean;
}

/**
 * `--mode` is required so a missing flag can never silently grant the widest
 * default, and a pre-bound `--public-key` must be a well-formed key before the
 * ticket is created. `--web` mints a panel sign-in ticket instead, which has no
 * mode or key of its own: a panel session is always the whole panel.
 */
function parseAdminCredentials(
  command: 'pairing' | 'clients',
  positionals: readonly string[],
  values: PairingFlagValues,
): AdminCredentialCommand {
  const [action, target, ...rest] = positionals;
  if (rest.length > 0 || action === undefined) {
    throw new Error(usage());
  }
  if (command === 'pairing' && action === 'create') {
    if (target !== undefined) {
      throw new Error(usage());
    }
    if (values.web) {
      if (values.mode !== undefined || values.publicKey !== undefined) {
        throw new Error('pairing create --web takes no --mode or --public-key: a panel session is the whole panel');
      }
      const name = values.name ?? DEFAULT_WEB_PAIRING_NAME;
      if (name.length < 1 || name.length > MAX_NAME_LENGTH) {
        throw new Error(`--name must be 1-${MAX_NAME_LENGTH} characters`);
      }
      return { kind: 'pairing-create-web', name, ttlSeconds: parseTtl(values.ttlSeconds) };
    }
    const name = values.name;
    if (name === undefined || name.length < 1 || name.length > MAX_NAME_LENGTH) {
      throw new Error(`pairing create requires --name of 1-${MAX_NAME_LENGTH} characters`);
    }
    const mode = values.mode;
    if (mode === undefined || !isMode(mode)) {
      throw new Error('pairing create requires --mode of read, read_write, read_paid or all');
    }
    const publicKey = values.publicKey ?? null;
    if (publicKey !== null && !isValidPublicKey(publicKey)) {
      throw new Error('--public-key must be 32 base64url-encoded bytes (43 characters, unpadded)');
    }
    return { kind: 'pairing-create', name, mode, ttlSeconds: parseTtl(values.ttlSeconds), publicKey };
  }
  rejectPairingFlags(values);
  if (command === 'pairing' && action === 'list') {
    requireNoTarget(target);
    return { kind: 'pairing-list' };
  }
  if (command === 'pairing' && action === 'cancel') {
    return { kind: 'pairing-cancel', pairingId: requireDecimalId(target, 'pairing cancel') };
  }
  if (command === 'clients' && action === 'list') {
    requireNoTarget(target);
    return { kind: 'clients-list' };
  }
  if (command === 'clients' && action === 'revoke') {
    return { kind: 'clients-revoke', clientId: requireDecimalId(target, 'clients revoke') };
  }
  throw new Error(usage());
}

function rejectPairingFlags(values: PairingFlagValues): void {
  if (
    values.name !== undefined ||
    values.mode !== undefined ||
    values.ttlSeconds !== undefined ||
    values.publicKey !== undefined ||
    values.web
  ) {
    throw new Error(usage());
  }
}

function requireNoTarget(target: string | undefined): void {
  if (target !== undefined) {
    throw new Error(usage());
  }
}

function requireDecimalId(target: string | undefined, command: string): string {
  if (target === undefined || !/^\d{1,19}$/.test(target)) {
    throw new Error(`${command} requires a decimal id`);
  }
  return target;
}

function parseTtl(raw: string | undefined): number {
  if (raw === undefined) {
    return DEFAULT_PAIRING_TTL_SECONDS;
  }
  if (!/^\d{1,4}$/.test(raw)) {
    throw new Error(
      `--ttl-seconds must be an integer between ${MIN_PAIRING_TTL_SECONDS} and ${MAX_PAIRING_TTL_SECONDS}`,
    );
  }
  const seconds = Number.parseInt(raw, 10);
  if (seconds < MIN_PAIRING_TTL_SECONDS || seconds > MAX_PAIRING_TTL_SECONDS) {
    throw new Error(
      `--ttl-seconds must be an integer between ${MIN_PAIRING_TTL_SECONDS} and ${MAX_PAIRING_TTL_SECONDS}`,
    );
  }
  return seconds;
}

function isCommand(value: string): value is Command {
  return COMMANDS.includes(value);
}

function isMode(value: string): value is ApiKeyMode {
  return (MODES as readonly string[]).includes(value);
}

function usage(): string {
  return [
    'Usage: surowan <serve|check-config|doctor|backup|configure|admin-account> --config <path> [--output-agent-prompt] [--takeover] [--username <name>] [--password-stdin] [--revoke-passkeys]',
    '       surowan pairing create --config <path> --name <name> --mode <read|read_write|read_paid|all> [--ttl-seconds <60..3600>] [--public-key <base64url>]',
    '       surowan pairing create --config <path> --web [--name <name>] [--ttl-seconds <60..3600>]',
    '       surowan pairing list --config <path>',
    '       surowan pairing cancel <pairing-id> --config <path>',
    '       surowan clients list --config <path>',
    '       surowan clients revoke <client-id> --config <path>',
  ].join('\n');
}
