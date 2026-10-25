import { expect, test } from 'vitest';
import { AdminPasskeys } from '../../src/ingress/admin/passkeys.ts';
import { adminPasskeys } from '../../src/store/schema/index.ts';
import {
  assertion,
  fixture,
  installAdminPasskeyHooks,
  key,
  origin,
  register,
  registration,
} from './passkeys-fixtures.ts';

installAdminPasskeyHooks();

test('registration rejects wrong challenge/origin/RP/UV, duplicate keys and revoked authorization', async () => {
  const f = await fixture();
  const active = await register(f);
  const passkeys = new AdminPasskeys(f.store.orm, f.auth, origin);
  for (const overrides of [{ origin: 'https://evil.test' }, { rp: 'evil.test' }, { flags: 0x41 }]) {
    const pending = await passkeys.registrationOptions(f.token, '');
    await expect(
      passkeys.register(
        { name: 'invalid', response: registration(key(), pending.options.challenge, overrides) },
        pending.token,
        f.token,
      ),
    ).rejects.toMatchObject({ code: 'invalid_passkey' });
  }
  const wrong = await passkeys.registrationOptions(f.token, '');
  await expect(
    passkeys.register({ name: 'invalid', response: registration(key(), 'wrong-challenge') }, wrong.token, f.token),
  ).rejects.toMatchObject({ code: 'invalid_passkey' });
  const duplicate = await passkeys.registrationOptions(f.token, '');
  await expect(
    passkeys.register(
      { name: 'duplicate', response: registration(active.k, duplicate.options.challenge) },
      duplicate.token,
      f.token,
    ),
  ).rejects.toMatchObject({ code: 'passkey_exists' });
  const pending = await passkeys.registrationOptions(f.token, '');
  const inFlight = passkeys.register(
    { name: 'revoked', response: registration(key(), pending.options.challenge) },
    pending.token,
    f.token,
  );
  f.auth.logout(f.token);
  await expect(inFlight).rejects.toMatchObject({ code: 'unauthenticated' });
  expect(f.store.orm.select().from(adminPasskeys).all()).toHaveLength(1);
});

test('in-flight assertions cannot revive deleted keys or bypass recovery; concurrent counters commit once', async () => {
  const f = await fixture();
  const active = await register(f);
  const passkeys = new AdminPasskeys(f.store.orm, f.auth, origin);
  const one = await passkeys.loginOptions('');
  const two = await passkeys.loginOptions('');
  const results = await Promise.allSettled([
    passkeys.login({ response: assertion(active.k, one.options.challenge, active.userHandle, 1) }, one.token),
    passkeys.login({ response: assertion(active.k, two.options.challenge, active.userHandle, 1) }, two.token),
  ]);
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  const wrongUser = await passkeys.loginOptions('');
  await expect(
    passkeys.login({ response: assertion(active.k, wrongUser.options.challenge, 'wrong-user', 2) }, wrongUser.token),
  ).rejects.toMatchObject({ code: 'invalid_passkey' });
  const wrongChallenge = await passkeys.loginOptions('');
  await expect(
    passkeys.login({ response: assertion(active.k, 'wrong-challenge', active.userHandle, 2) }, wrongChallenge.token),
  ).rejects.toMatchObject({ code: 'invalid_passkey' });
  const pending = await passkeys.loginOptions('');
  const inFlight = passkeys.login(
    { response: assertion(active.k, pending.options.challenge, active.userHandle, 2) },
    pending.token,
  );
  passkeys.remove(f.session.userId, f.store.orm.select().from(adminPasskeys).get()!.id);
  await expect(inFlight).rejects.toMatchObject({ code: 'invalid_passkey' });
  await register(f);
  await f.auth.createOrResetAccount(
    { username: 'owner', password: 'fixture-reset-password' },
    { revokePasskeys: true },
  );
  expect(f.store.orm.select().from(adminPasskeys).all()).toHaveLength(0);
  expect(f.auth.authenticate(f.token)).toBeNull();
  expect(f.auth.setupRequired()).toBe(false);
});
