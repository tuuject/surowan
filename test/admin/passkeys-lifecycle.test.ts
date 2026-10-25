import { expect, test } from 'vitest';
import { adminPasskeys } from '../../src/store/schema/index.ts';
import {
  assertion,
  cookie,
  fixture,
  installAdminPasskeyHooks,
  key,
  password,
  register,
  req,
} from './passkeys-fixtures.ts';

installAdminPasskeyHooks();

test('real registration/assertion, multi-passkey lifecycle, password deletion and restoration', async () => {
  const f = await fixture();
  expect((await f.server.handle(req('password', 'DELETE', f.cookie))).status).toBe(409);
  const first = await register(f);
  await register(f, key(), 'Backup');
  const list: any = await (await f.server.handle(req('passkeys', 'GET', f.cookie))).json();
  expect(list.items).toHaveLength(2);
  expect(list.items.every((item: { usable: boolean }) => item.usable)).toBe(true);
  expect(JSON.stringify(list)).not.toContain('publicKey');
  const removed = await f.server.handle(req('password', 'DELETE', f.cookie));
  expect(removed.status).toBe(200);
  expect(f.auth.authenticate(f.token)).toBeNull();
  f.cookie = cookie(removed);
  await expect(f.auth.login({ username: 'owner', password })).rejects.toMatchObject({ code: 'invalid_credentials' });
  expect((await f.server.handle(req(`passkeys/${list.items[0].id}`, 'DELETE', f.cookie))).status).toBe(200);
  expect((await f.server.handle(req(`passkeys/${list.items[1].id}`, 'DELETE', f.cookie))).status).toBe(409);
  const restored = await f.server.handle(req('credentials', 'POST', f.cookie, { username: 'owner', password }));
  expect(restored.status).toBe(200);
  f.cookie = cookie(restored);
  expect((await f.server.handle(req(`passkeys/${list.items[1].id}`, 'DELETE', f.cookie))).status).toBe(200);
  expect(f.store.orm.select().from(adminPasskeys).all()).toHaveLength(0);
  // Register again, then sign in without a username or password.
  const active = await register(f, first.k);
  const options = await f.server.handle(req('passkeys/login/options'));
  const body: any = await options.json();
  expect(body.allowCredentials ?? []).toEqual([]);
  const verify = req('passkeys/login/verify', 'POST', cookie(options), {
    response: assertion(active.k, body.challenge, active.userHandle, 1),
  });
  const logged = await f.server.handle(verify.clone());
  expect(logged.status).toBe(200);
  expect(await (await f.server.handle(req('session', 'GET', cookie(logged)))).json()).toMatchObject({
    authenticated: true,
    username: 'owner',
  });
  expect((await f.server.handle(verify)).status).toBe(400);
  expect(f.store.orm.select().from(adminPasskeys).get()?.counter).toBe(1n);
});

test('passwordless accounts can sign in repeatedly with zero-counter synced keys; wrong-RP keys cannot remove password', async () => {
  const f = await fixture();
  const active = await register(f);
  f.cookie = cookie(await f.server.handle(req('password', 'DELETE', f.cookie)));
  for (let i = 0; i < 2; i++) {
    const options = await f.server.handle(req('passkeys/login/options'));
    const body: any = await options.json();
    expect(
      (
        await f.server.handle(
          req('passkeys/login/verify', 'POST', cookie(options), {
            response: assertion(active.k, body.challenge, active.userHandle, 0),
          }),
        )
      ).status,
    ).toBe(200);
  }
  f.cookie = cookie(await f.server.handle(req('credentials', 'POST', f.cookie, { username: 'owner', password })));
  f.store.orm.update(adminPasskeys).set({ rpId: 'old.example.com' }).run();
  const stale: any = await (await f.server.handle(req('passkeys', 'GET', f.cookie))).json();
  expect(stale.items).toHaveLength(1);
  expect(stale.items[0].usable).toBe(false);
  expect((await f.server.handle(req('password', 'DELETE', f.cookie))).status).toBe(409);
  expect(f.auth.hasPassword(f.session.userId)).toBe(true);
});
