import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { expect, test, vi } from 'vitest';
import { adminPasskeys, adminUsers } from '../../src/store/schema/index.ts';
import {
  assertion,
  cookie,
  fixture,
  installAdminPasskeyHooks,
  key,
  password,
  register,
  registration,
  req,
} from './passkeys-fixtures.ts';

installAdminPasskeyHooks();

test('rejects forged, wrong-origin/RP/UV, expired, mismatched-session and reused challenges', async () => {
  const f = await fixture();
  const active = await register(f);
  for (const overrides of [{ origin: 'https://evil.test' }, { rp: 'evil.test' }, { flags: 1 }]) {
    const options = await f.server.handle(req('passkeys/login/options'));
    const body: any = await options.json();
    const result = await f.server.handle(
      req('passkeys/login/verify', 'POST', cookie(options), {
        response: assertion(active.k, body.challenge, active.userHandle, 1, overrides),
      }),
    );
    expect(result.status).toBe(401);
  }
  const options = await f.server.handle(req('passkeys/login/options'));
  const body: any = await options.json();
  const forged = assertion(active.k, body.challenge, active.userHandle, 1);
  forged.response.signature = randomBytes(70).toString('base64url');
  expect(
    (await f.server.handle(req('passkeys/login/verify', 'POST', cookie(options), { response: forged }))).status,
  ).toBe(401);
  const missingCookie = await f.server.handle(
    req('passkeys/login/verify', 'POST', '', { response: assertion(active.k, body.challenge, active.userHandle, 1) }),
  );
  expect(missingCookie.status).toBe(400);
  const expired = await f.server.handle(req('passkeys/login/options'));
  const expiredBody: any = await expired.json();
  const now = Date.now();
  vi.spyOn(Date, 'now').mockReturnValue(now + 300_001);
  expect(
    (
      await f.server.handle(
        req('passkeys/login/verify', 'POST', cookie(expired), {
          response: assertion(active.k, expiredBody.challenge, active.userHandle, 1),
        }),
      )
    ).status,
  ).toBe(400);
  vi.restoreAllMocks();
  const registrationOptions = await f.server.handle(req('passkeys/register/options', 'POST', f.cookie));
  const ro: any = await registrationOptions.json();
  const otherToken = await f.auth.login({ username: 'owner', password });
  expect(
    (
      await f.server.handle(
        req('passkeys/register/verify', 'POST', `plasticwan_admin=${otherToken}; ${cookie(registrationOptions)}`, {
          name: 'wrong-session',
          response: registration(key(), ro.challenge),
        }),
      )
    ).status,
  ).toBe(400);
});

test('rejects stale signature counters, deleted keys, ownership violations and throttles options', async () => {
  const f = await fixture();
  const active = await register(f);
  for (const expected of [200, 401]) {
    const options = await f.server.handle(req('passkeys/login/options'));
    const body: any = await options.json();
    expect(
      (
        await f.server.handle(
          req('passkeys/login/verify', 'POST', cookie(options), {
            response: assertion(active.k, body.challenge, active.userHandle, 1),
          }),
        )
      ).status,
    ).toBe(expected);
  }
  const other = f.store.orm
    .insert(adminUsers)
    .values({
      username: 'other',
      passwordHash: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .returning()
    .get()!;
  const foreign = f.store.orm
    .insert(adminPasskeys)
    .values({
      userId: other.id,
      name: 'foreign',
      credentialId: 'foreign',
      publicKey: 'unused',
      counter: 0n,
      rpId: 'example.com',
      createdAt: new Date().toISOString(),
    })
    .returning()
    .get()!;
  expect((await f.server.handle(req(`passkeys/${foreign.id}`, 'DELETE', f.cookie))).status).toBe(404);
  const options = await f.server.handle(req('passkeys/login/options'));
  const body: any = await options.json();
  f.store.orm.delete(adminPasskeys).where(eq(adminPasskeys.credentialId, active.k.id)).run();
  expect(
    (
      await f.server.handle(
        req('passkeys/login/verify', 'POST', cookie(options), {
          response: assertion(active.k, body.challenge, active.userHandle, 2),
        }),
      )
    ).status,
  ).toBe(401);
  let response: Response | undefined;
  for (let i = 0; i < 61; i++) {
    response = await f.server.handle(req('passkeys/login/options'), 'throttle-fixture');
  }
  expect(response?.status).toBe(429);
});
