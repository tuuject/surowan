import { CLIENT_ID_PATTERN, INSTANCE_ID_PATTERN, pairingProofString } from '@surowan/admin-surface';
import { type ResolvedConnection, parseTimeout, resolveConnection } from './args/index.ts';
import type { AuthCommand, ParsedCli } from './args/types.ts';
import { AdminClient, isRecord, parseEndpoint } from './client.ts';
import type { CliIo } from './commands.ts';
import { type ClientCredentials, credentialsPath, readCredentials, writeCredentials } from './credentials.ts';
import { CliError, usageError } from './errors.ts';
import {
  type ClientIdentity,
  clientKeyExists,
  clientKeyPath,
  ensureClientIdentity,
  readClientIdentity,
  removeClientKey,
  sha256Base64Url,
  signWithIdentity,
} from './identity.ts';
import { removePrivateFile } from './private-file.ts';
import { redactingIo } from './redact.ts';

/**
 * `surowan-utils auth …`: the local half of paired-client authentication.
 *
 * Nothing here prints, exports or accepts the private key. `auth init` and
 * `auth pair` are safe for an agent to run because a pairing code is
 * short-lived and single-use; `auth logout` only deletes local files and does
 * not revoke the server-side client.
 */
/** A client wired with the resolved credential, plus the local identity when one was used. */
export interface WiredClient {
  readonly client: AdminClient;
  readonly endpoint: URL;
  readonly identity: ClientIdentity | undefined;
}

export interface CreateCredentialClientOptions {
  readonly connection: ResolvedConnection;
  readonly timeoutMs: number;
  readonly homeDir: string | undefined;
  readonly secrets: Array<string | undefined>;
}

/**
 * Turns an already resolved credential into a client. A saved client credential
 * without its key file is a credential failure, not a usage error: the pair is
 * incomplete and only `auth logout` or a fresh `auth pair` fixes it.
 */
export async function createCredentialClient(options: CreateCredentialClientOptions): Promise<WiredClient> {
  const { connection, secrets } = options;
  if (connection.credential.kind === 'api_key') {
    secrets.push(connection.credential.apiKey);
    return {
      client: new AdminClient({
        baseUrl: connection.endpoint,
        apiKey: connection.credential.apiKey,
        defaultTimeoutMs: options.timeoutMs,
      }),
      endpoint: connection.endpoint,
      identity: undefined,
    };
  }
  const keyPath = clientKeyPath(options.homeDir);
  const identity = await readClientIdentity(keyPath);
  if (identity === undefined) {
    throw new CliError('missing_client_key', `saved client credentials need the paired key file: ${keyPath}`);
  }
  const pem = identity.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  secrets.push(pem);
  return {
    client: new AdminClient({
      baseUrl: connection.endpoint,
      signer: {
        clientId: connection.credential.clientId,
        instanceId: connection.credential.instanceId,
        privateKey: identity.privateKey,
      },
      defaultTimeoutMs: options.timeoutMs,
    }),
    endpoint: connection.endpoint,
    identity,
  };
}

export interface AuthRunContext {
  readonly command: AuthCommand;
  readonly parsed: ParsedCli;
  readonly homeDir: string | undefined;
  readonly env: Record<string, string | undefined>;
  readonly json: boolean;
  readonly io: CliIo;
  readonly secrets: Array<string | undefined>;
}

export async function runAuthCommand(context: AuthRunContext): Promise<number> {
  switch (context.command.action) {
    case 'init':
      return await authInit(context);
    case 'pair':
      return await authPair(context);
    case 'status':
      return await authStatus(context);
    case 'permissions':
      return await authPermissions(context);
    case 'logout':
      return await authLogout(context);
  }
}

async function authInit(context: AuthRunContext): Promise<number> {
  const keyPath = clientKeyPath(context.homeDir);
  const { identity, created } = await ensureClientIdentity(keyPath);
  const io = redactingIo(context.io, context.secrets, context.json);
  const document = {
    status: 'ok',
    created,
    public_key: identity.publicKey,
    fingerprint: identity.fingerprint,
    key_file: keyPath,
  };
  io.stdout(
    context.json
      ? `${JSON.stringify(document)}\n`
      : `${created ? 'Client key created' : 'Client key already present'}: ${identity.fingerprint}\n`,
  );
  return 0;
}

async function authPair(context: AuthRunContext): Promise<number> {
  const endpointRaw = context.parsed.endpointRaw ?? context.env.SUROWAN_ENDPOINT;
  if (endpointRaw === undefined || endpointRaw.trim().length === 0) {
    throw usageError('missing_endpoint', 'auth pair requires --endpoint <url> or SUROWAN_ENDPOINT');
  }
  const endpoint = parseEndpoint(endpointRaw);
  const timeoutMs = parseTimeout(context.parsed.timeoutRaw, false);
  const code = context.command.code;
  if (code === undefined || !/^pwp_[A-Za-z0-9_-]{32}$/.test(code)) {
    throw usageError('invalid_pairing_code', '--code must be a pwp_ pairing code created by surowan pairing create');
  }
  const credentialsFile = credentialsPath(context.homeDir);
  if (!context.command.force && (await hasStoredCredential(credentialsFile))) {
    throw usageError(
      'already_configured',
      'a credential is already saved; pass --force to replace it or run surowan-utils auth logout first',
    );
  }
  const keyPath = clientKeyPath(context.homeDir);
  const { identity } = await ensureClientIdentity(keyPath);
  // The proof is signed by the very key being registered, so holding the code
  // is not enough to bind someone else's key to this instance.
  const proof = signWithIdentity(identity, pairingProofString(sha256Base64Url(code), identity.publicKey));
  const client = new AdminClient({ baseUrl: endpoint, defaultTimeoutMs: timeoutMs });
  const claimed = await client.postUnauthenticated('api/pairing/claim', {
    code,
    public_key: identity.publicKey,
    proof,
  });
  const claimedClient = parseClaimResponse(claimed);
  const stored: ClientCredentials = {
    endpoint: endpoint.href,
    client_id: claimedClient.id,
    instance_id: claimedClient.instanceId,
  };
  await writeCredentials(credentialsFile, stored);
  const io = redactingIo(context.io, context.secrets, context.json);
  const document = {
    status: 'paired',
    endpoint: endpoint.href,
    client_id: claimedClient.id,
    instance_id: claimedClient.instanceId,
    name: claimedClient.name,
    mode: claimedClient.mode,
    permissions: claimedClient.permissions,
    fingerprint: identity.fingerprint,
  };
  io.stdout(
    context.json ? `${JSON.stringify(document)}\n` : `Paired as ${claimedClient.name} (${claimedClient.mode}).\n`,
  );
  return 0;
}

/**
 * Applies exactly the precedence `runCli` uses: an explicit endpoint and an
 * explicit credential together bypass the saved file entirely, so a damaged
 * file or a different server never blocks an explicit invocation. `undefined`
 * means no credential resolves at all — the only state `auth status` reports
 * as `not_configured`.
 */
async function resolveAuthConnection(context: AuthRunContext): Promise<ResolvedConnection | undefined> {
  const explicitEndpoint = context.parsed.endpointRaw ?? context.env.SUROWAN_ENDPOINT;
  const explicitCredential = context.parsed.apiKeyRaw ?? context.env.SUROWAN_API_KEY;
  const saved =
    explicitEndpoint !== undefined && explicitCredential !== undefined
      ? undefined
      : await readCredentials(credentialsPath(context.homeDir));
  if (saved === undefined && explicitCredential === undefined) {
    return undefined;
  }
  return resolveConnection(context.parsed, context.env, saved);
}

async function authStatus(context: AuthRunContext): Promise<number> {
  const io = redactingIo(context.io, context.secrets, context.json);
  const connection = await resolveAuthConnection(context);
  if (connection === undefined) {
    const keyPresent = await clientKeyExists(clientKeyPath(context.homeDir));
    const identity = keyPresent ? await readClientIdentitySafe(clientKeyPath(context.homeDir)) : undefined;
    const document = {
      status: 'not_configured',
      key_file_present: keyPresent,
      fingerprint: identity?.fingerprint ?? null,
    };
    io.stdout(
      context.json
        ? `${JSON.stringify(document)}\n`
        : 'No credential is saved. Run surowan-utils auth pair (or login) first.\n',
    );
    return 0;
  }
  const wired = await createCredentialClient({
    connection,
    timeoutMs: parseTimeout(context.parsed.timeoutRaw, false),
    homeDir: context.homeDir,
    secrets: context.secrets,
  });
  const identityDocument = await readIdentityDocument(wired.client);
  const document = {
    status: 'ok',
    credential: wired.client.credentialKind,
    endpoint: wired.endpoint.href,
    ...(connection.credential.kind === 'client_signature'
      ? {
          client_id: connection.credential.clientId,
          instance_id: connection.credential.instanceId,
          fingerprint: wired.identity?.fingerprint ?? null,
        }
      : {}),
    mode: identityDocument.mode,
    permissions: identityDocument.permissions,
  };
  io.stdout(
    context.json
      ? `${JSON.stringify(document)}\n`
      : `Credential is valid (${wired.client.credentialKind}, ${identityDocument.mode}).\n`,
  );
  return 0;
}

async function authPermissions(context: AuthRunContext): Promise<number> {
  const connection = await resolveAuthConnection(context);
  if (connection === undefined) {
    throw usageError(
      'missing_credential',
      'no credential resolves; pass --api-key or run surowan-utils auth pair / login first',
    );
  }
  const wired = await createCredentialClient({
    connection,
    timeoutMs: parseTimeout(context.parsed.timeoutRaw, false),
    homeDir: context.homeDir,
    secrets: context.secrets,
  });
  const identityDocument = await readIdentityDocument(wired.client);
  const io = redactingIo(context.io, context.secrets, context.json);
  const document = {
    credential: wired.client.credentialKind,
    mode: identityDocument.mode,
    permissions: identityDocument.permissions,
  };
  io.stdout(context.json ? `${JSON.stringify(document)}\n` : `${identityDocument.mode}\n`);
  return 0;
}

async function authLogout(context: AuthRunContext): Promise<number> {
  const credentialsFile = credentialsPath(context.homeDir);
  const saved = await readCredentials(credentialsFile).catch(() => undefined);
  const removedCredentials = await removePrivateFile(credentialsFile);
  const removedKey = await removeClientKey(clientKeyPath(context.homeDir));
  const io = redactingIo(context.io, context.secrets, context.json);
  const document = { status: 'logged_out', removed_credentials: removedCredentials, removed_key: removedKey };
  const revokeHint =
    saved !== undefined && 'client_id' in saved
      ? ` The server-side client still exists; revoke it with surowan clients revoke ${saved.client_id}.`
      : '';
  io.stdout(context.json ? `${JSON.stringify(document)}\n` : `Local credentials removed.${revokeHint}\n`);
  return 0;
}

/** `GET api/key` identity, already validated to the shape the CLI prints. */
async function readIdentityDocument(
  client: AdminClient,
): Promise<{ readonly mode: string; readonly permissions: Record<string, unknown> }> {
  const identity = await client.get('api/key');
  if (!isRecord(identity) || typeof identity.mode !== 'string' || !isRecord(identity.permissions)) {
    throw new CliError('invalid_response', 'the Admin API did not return a credential permission document');
  }
  return { mode: identity.mode, permissions: identity.permissions };
}

/**
 * Confirms the saved credential still has its key file. Status must not throw a
 * second, different error after the key was already proven unreadable.
 */
async function readClientIdentitySafe(path: string): Promise<ClientIdentity | undefined> {
  return await readClientIdentity(path).catch(() => undefined);
}

async function hasStoredCredential(path: string): Promise<boolean> {
  try {
    return (await readCredentials(path)) !== undefined;
  } catch (error) {
    // A damaged file is still an existing credential: overwriting it silently
    // would be the same surprise as replacing a valid one.
    if (error instanceof CliError) {
      return true;
    }
    throw error;
  }
}

function parseClaimResponse(value: unknown): {
  readonly id: string;
  readonly instanceId: string;
  readonly name: string;
  readonly mode: string;
  readonly permissions: Record<string, unknown>;
} {
  if (!isRecord(value) || !isRecord(value.client)) {
    throw new CliError('invalid_response', 'the pairing claim did not return a client document');
  }
  const client = value.client;
  const id = client.id;
  const name = client.name;
  const mode = client.mode;
  const permissions = client.permissions;
  const instanceId = value.instance_id;
  if (
    typeof id !== 'string' ||
    !CLIENT_ID_PATTERN.test(id) ||
    typeof name !== 'string' ||
    typeof mode !== 'string' ||
    !isRecord(permissions) ||
    typeof instanceId !== 'string' ||
    !INSTANCE_ID_PATTERN.test(instanceId)
  ) {
    throw new CliError('invalid_response', 'the pairing claim returned an unexpected document');
  }
  return { id, instanceId, name, mode, permissions };
}
