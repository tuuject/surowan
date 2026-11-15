import { expect, test } from 'vitest';
import {
  allRowsText,
  countRows,
  installPairingHooks,
  json,
  newIdentity,
  pairingFixture,
  pairingProof,
  pairingRow,
  parseCliDocument,
  runServerCli,
} from './fixtures.ts';

/**
 * Web sign-in with a one-time pairing code (`surowan pairing create --web`,
 * claimed by `POST /api/auth/pairing`). The ways it can go wrong, each pinned
 * below:
 *
 * 1. A client ticket entered on the login page opens a full panel session, or
 *    a web ticket claimed by `auth pair` becomes a full-permission client.
 * 2. A rejected attempt burns the ticket it named, so the right caller can no
 *    longer use it.
 * 3. A code works twice, or two simultaneous claims both get a session.
 * 4. An expired or cancelled code still signs in.
 * 5. A malformed body reaches the lookup, or leaks whether a code exists.
 * 6. The plaintext code is stored, or the session cookie loses HttpOnly /
 *    SameSite=Strict.
 * 7. A ticket is minted with no administrator to sign in as, or mixed with the
 *    client-only flags (`--mode`, `--public-key`).
 * 8. The login page shows the official image's `docker compose` command to a
 *    deployment that is not the official image, whose service name, paths and
 *    user may differ.
 */
installPairingHooks();

type Fixture = Awaited<ReturnType<typeof pairingFixture>>;

const USERNAME = 'web-admin';
const PASSWORD = 'correct-horse-battery';

async function createAdministrator(fixture: Fixture): Promise<void> {
  const setup = await fetch(`${fixture.baseUrl}/api/auth/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
  });
  expect(setup.status).toBe(200);
}

async function createWebCode(fixture: Fixture, extra: readonly string[] = []): Promise<Record<string, unknown>> {
  const created = await runServerCli(fixture.configPath, ['pairing', 'create', '--web', ...extra]);
  expect(created.code, created.stderr).toBe(0);
  return parseCliDocument(created);
}

async function createClientCode(fixture: Fixture): Promise<Record<string, unknown>> {
  const created = await runServerCli(fixture.configPath, [
    'pairing',
    'create',
    '--name',
    'coding-agent',
    '--mode',
    'read',
  ]);
  expect(created.code, created.stderr).toBe(0);
  return parseCliDocument(created);
}

async function signIn(fixture: Fixture, body: unknown): Promise<Response> {
  return await fetch(`${fixture.baseUrl}/api/auth/pairing`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function claimAsClient(fixture: Fixture, code: string): Promise<Response> {
  const identity = newIdentity();
  return await fetch(`${fixture.baseUrl}/api/pairing/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, public_key: identity.publicKey, proof: pairingProof(code, identity) }),
  });
}

function sessionCount(fixture: Fixture): number {
  const row = fixture.store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM admin_sessions').get();
  return Number(row?.count ?? 0n);
}

function pairingId(created: Record<string, unknown>): string {
  return String((created.pairing as { id: string }).id);
}

test('a web code from the server CLI opens one panel session', async () => {
  const fixture = await pairingFixture();
  try {
    await createAdministrator(fixture);
    const sessionsBefore = sessionCount(fixture);
    const created = await createWebCode(fixture);
    const code = String(created.code);
    expect(code).toMatch(/^pwp_[A-Za-z0-9_-]{32}$/);
    expect(created.pairing).toMatchObject({
      purpose: 'web',
      name: 'Admin Panel sign-in',
      public_key_fingerprint: null,
    });
    expect(String(created.next)).toContain('http://127.0.0.1:8899/');
    expect(allRowsText(fixture.store)).not.toContain(code);

    const response = await signIn(fixture, { code });
    expect(response.status, await response.clone().text()).toBe(200);
    const cookie = response.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(/^plasticwan_admin=[^;]+;/);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');

    const session = await fetch(`${fixture.baseUrl}/api/auth/session`, {
      headers: { cookie: cookie.split(';')[0] ?? '' },
    });
    expect(await json(session)).toMatchObject({ authenticated: true, username: USERNAME });
    expect(sessionCount(fixture)).toBe(sessionsBefore + 1);
    const row = pairingRow(fixture.store, pairingId(created));
    expect(row?.consumed_at).toEqual(expect.any(String));
    expect(row?.client_id).toBeNull();
    expect(countRows(fixture.store, 'admin_clients')).toBe(0);

    const replay = await signIn(fixture, { code });
    expect(replay.status).toBe(409);
    expect(await json(replay)).toMatchObject({ error: 'pairing_code_used' });
    expect(sessionCount(fixture)).toBe(sessionsBefore + 1);
  } finally {
    await fixture.close();
  }
}, 60_000);

test('client and web tickets never cross, and a refused attempt does not burn either', async () => {
  const fixture = await pairingFixture();
  try {
    await createAdministrator(fixture);
    const sessionsBefore = sessionCount(fixture);
    const client = await createClientCode(fixture);
    const web = await createWebCode(fixture);

    const clientOnWeb = await signIn(fixture, { code: client.code });
    expect(clientOnWeb.status).toBe(400);
    expect(await json(clientOnWeb)).toMatchObject({ error: 'pairing_code_invalid' });
    expect(pairingRow(fixture.store, pairingId(client))?.consumed_at).toBeNull();

    const webAsClient = await claimAsClient(fixture, String(web.code));
    expect(webAsClient.status).toBe(400);
    expect(await json(webAsClient)).toMatchObject({ error: 'pairing_code_invalid' });
    expect(pairingRow(fixture.store, pairingId(web))?.consumed_at).toBeNull();
    expect(countRows(fixture.store, 'admin_clients')).toBe(0);
    expect(sessionCount(fixture)).toBe(sessionsBefore);

    // Both are still good for the purpose they were minted for.
    expect((await claimAsClient(fixture, String(client.code))).status).toBe(201);
    expect((await signIn(fixture, { code: web.code })).status).toBe(200);

    const listed = parseCliDocument(await runServerCli(fixture.configPath, ['pairing', 'list']));
    expect(listed.items).toEqual([]);
  } finally {
    await fixture.close();
  }
}, 60_000);

test('two simultaneous claims of one web code yield exactly one session', async () => {
  const fixture = await pairingFixture();
  try {
    await createAdministrator(fixture);
    const sessionsBefore = sessionCount(fixture);
    const { code } = await createWebCode(fixture);
    const results = await Promise.all([signIn(fixture, { code }), signIn(fixture, { code })]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    expect(sessionCount(fixture)).toBe(sessionsBefore + 1);
  } finally {
    await fixture.close();
  }
}, 60_000);

test('expired, cancelled and malformed web codes open no session', async () => {
  const fixture = await pairingFixture();
  try {
    await createAdministrator(fixture);
    const sessionsBefore = sessionCount(fixture);

    const expired = await createWebCode(fixture, ['--ttl-seconds', '60']);
    fixture.store.db
      .prepare('UPDATE admin_pairings SET expires_at = ? WHERE id = ?')
      .run('2000-01-01T00:00:00.000Z', BigInt(pairingId(expired)));
    const late = await signIn(fixture, { code: expired.code });
    expect(late.status).toBe(400);
    expect(await json(late)).toMatchObject({ error: 'pairing_code_expired' });

    const canceled = await createWebCode(fixture, ['--name', 'laptop browser']);
    expect(canceled.pairing).toMatchObject({ purpose: 'web', name: 'laptop browser' });
    const listed = parseCliDocument(await runServerCli(fixture.configPath, ['pairing', 'list']));
    expect(listed.items).toEqual([expect.objectContaining({ id: pairingId(canceled), purpose: 'web' })]);
    expect((await runServerCli(fixture.configPath, ['pairing', 'cancel', pairingId(canceled)])).code).toBe(0);
    const afterCancel = await signIn(fixture, { code: canceled.code });
    expect(afterCancel.status).toBe(400);
    expect(await json(afterCancel)).toMatchObject({ error: 'pairing_code_invalid' });

    // Shape errors never reach the lookup: a code-shaped unknown string is
    // `pairing_code_invalid`, anything else is `invalid_body`.
    const unknown = await signIn(fixture, { code: `pwp_${'A'.repeat(32)}` });
    expect(await json(unknown)).toMatchObject({ error: 'pairing_code_invalid' });
    for (const body of [{ code: 'pwp_short' }, { code: 42 }, {}, { code: canceled.code, extra: true }, []]) {
      const refused = await signIn(fixture, body);
      expect(refused.status, JSON.stringify(body)).toBe(400);
      expect(await json(refused), JSON.stringify(body)).toMatchObject({ error: 'invalid_body' });
    }
    expect(sessionCount(fixture)).toBe(sessionsBefore);
  } finally {
    await fixture.close();
  }
}, 60_000);

test('pairing create --web needs the administrator account and refuses client-only flags', async () => {
  const fixture = await pairingFixture();
  try {
    const noAccount = await runServerCli(fixture.configPath, ['pairing', 'create', '--web']);
    expect(noAccount.code).toBe(1);
    expect(JSON.parse(noAccount.stderr).error).toContain('administrator account');
    expect(countRows(fixture.store, 'admin_pairings')).toBe(0);

    await createAdministrator(fixture);
    const { publicKey } = newIdentity();
    for (const args of [
      ['pairing', 'create', '--web', '--mode', 'all'],
      ['pairing', 'create', '--web', '--public-key', publicKey],
      ['pairing', 'create', '--web', '--web'],
      ['pairing', 'create', '--web', '--ttl-seconds', '30'],
      ['pairing', 'list', '--web'],
      ['clients', 'list', '--web'],
    ]) {
      const result = await runServerCli(fixture.configPath, args);
      expect(result.code, args.join(' ')).toBe(1);
      expect(JSON.parse(result.stderr), args.join(' ')).toMatchObject({ status: 'error' });
    }
    expect(countRows(fixture.store, 'admin_pairings')).toBe(0);
  } finally {
    await fixture.close();
  }
}, 60_000);

test('the session reports the official Docker image only when the image marks itself', async () => {
  const fixture = await pairingFixture();
  const saved = process.env.SUROWAN_OFFICIAL_IMAGE;
  const official = async (): Promise<unknown> =>
    (await json(await fetch(`${fixture.baseUrl}/api/auth/session`))).official_docker_image;
  try {
    delete process.env.SUROWAN_OFFICIAL_IMAGE;
    expect(await official()).toBe(false);
    // Anything but the exact marker is a self-built image.
    process.env.SUROWAN_OFFICIAL_IMAGE = 'true';
    expect(await official()).toBe(false);
    process.env.SUROWAN_OFFICIAL_IMAGE = '1';
    expect(await official()).toBe(true);
  } finally {
    if (saved === undefined) {
      delete process.env.SUROWAN_OFFICIAL_IMAGE;
    } else {
      process.env.SUROWAN_OFFICIAL_IMAGE = saved;
    }
    await fixture.close();
  }
}, 60_000);
