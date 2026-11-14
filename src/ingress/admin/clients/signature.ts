import {
  SIGNATURE_MAX_CLOCK_SKEW_SECONDS,
  SIGNATURE_SCHEME,
  canonicalSignatureString,
  parseSignatureAuthorization,
} from '@surowan/admin-surface';
import type { Orm } from '../../../store/store.ts';
import { json, readBoundedBytes } from '../http.ts';
import { authenticateClient, type AuthenticatedClient, ensureInstanceId, recordNonce, touchClient } from './index.ts';
import { bodyDigest, verifyEd25519 } from './keys.ts';

/** The largest admin body is an MCP image upload; a signed request can carry any route's body. */
export const MAX_SIGNED_BODY_BYTES = 32 * 1024 * 1024;

export type ClientRequestAuthentication =
  | {
      readonly kind: 'authenticated';
      /** The request rebuilt over the buffered body, so the route handlers can still read it. */
      readonly request: Request;
      readonly client: AuthenticatedClient;
    }
  | { readonly kind: 'response'; readonly response: Response };

/**
 * Verifies one signed request: header shape, a live client, timestamp window,
 * body digest, Ed25519 signature — and only then records the nonce. A nonce is
 * never consumed by a request that failed any earlier step, so a replay attempt
 * makes no state change a failed signature did not already allow.
 *
 * The freshness and revocation checks are repeated after the body has arrived.
 * A request body may trickle for minutes, so a decision made when the request
 * line arrived would otherwise authenticate a timestamp that has since expired
 * or a client that has since been revoked. `clock` is injectable so a test can
 * prove that without waiting.
 */
export async function authenticateClientRequest(
  orm: Orm,
  request: Request,
  target: string,
  clock: () => Date = () => new Date(),
): Promise<ClientRequestAuthentication> {
  const received = clock();
  const header = request.headers.get('authorization') ?? '';
  const fields = parseSignatureAuthorization(header);
  if (fields === null) {
    return reject('unauthenticated', `A valid ${SIGNATURE_SCHEME} header is required`);
  }
  const client = authenticateClient(orm, BigInt(fields.clientId));
  if (client === null) {
    return reject('unauthenticated', 'The signing client is unknown or revoked');
  }
  const timestampSeconds = Number(fields.timestamp);
  const earlySkew = clockSkew(received, timestampSeconds);
  if (earlySkew > SIGNATURE_MAX_CLOCK_SKEW_SECONDS) {
    return clockSkewRejection(earlySkew);
  }
  const body = await readBoundedBytes(request, MAX_SIGNED_BODY_BYTES);
  const canonical = canonicalSignatureString({
    instanceId: ensureInstanceId(orm, received),
    clientId: fields.clientId,
    method: request.method,
    target,
    timestamp: fields.timestamp,
    nonce: fields.nonce,
    bodyDigest: await bodyDigest(body),
  });
  if (!(await verifyEd25519(client.publicKey, new TextEncoder().encode(canonical), fields.signature))) {
    return reject('unauthenticated', 'The request signature is invalid');
  }
  // The body is in; decide with the clock as it is now.
  const verified = clock();
  const skew = clockSkew(verified, timestampSeconds);
  if (skew > SIGNATURE_MAX_CLOCK_SKEW_SECONDS) {
    return clockSkewRejection(skew);
  }
  // Grants and revocation are re-read immediately before the nonce is spent:
  // a client revoked while its body streamed must not be dispatched at all.
  const current = authenticateClient(orm, client.id);
  if (current === null || current.publicKey !== client.publicKey) {
    return reject('unauthenticated', 'The signing client is unknown or revoked');
  }
  if (!recordNonce(orm, current.id, fields.nonce, timestampSeconds, verified)) {
    return reject('signature_replayed', 'This request nonce was already used');
  }
  touchClient(orm, current.id, verified);
  return {
    kind: 'authenticated',
    request: rebuild(request, body),
    client: current,
  };
}

function clockSkew(now: Date, timestampSeconds: number): number {
  return Math.abs(Math.floor(now.getTime() / 1_000) - timestampSeconds);
}

function clockSkewRejection(skew: number): { readonly kind: 'response'; readonly response: Response } {
  return reject(
    'signature_clock_skew',
    `The request timestamp is ${skew}s away from the server clock; allow at most ${SIGNATURE_MAX_CLOCK_SKEW_SECONDS}s`,
  );
}

/** A consumed body cannot be read twice, so the verified bytes replace the stream. */
function rebuild(request: Request, body: Buffer): Request {
  // A DOM-lib `BodyInit` rejects Node's `Buffer` type, and the copy is bounded
  // by the same 32 MiB cap the bytes were read under.
  const payload = body.byteLength === 0 ? null : new Uint8Array(body);
  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: payload,
    signal: request.signal,
  });
}

function reject(error: string, message: string): { readonly kind: 'response'; readonly response: Response } {
  return { kind: 'response', response: json({ error, message }, 401) };
}
