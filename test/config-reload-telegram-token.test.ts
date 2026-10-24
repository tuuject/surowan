/**
 * The reload path's Telegram token gateway.
 *
 * Publishing a token must never block on `getMe` and must never fail an apply
 * because a SecretRef cannot be read: both are connection states the manager
 * reports, not configuration write errors. The gateway also has to notice a
 * key-jar rotation even though the configuration file itself did not change.
 */
import { expect, test } from 'vitest';
import {
  resolveTelegramTokenSource,
  type TelegramTokenSource,
} from '../src/adapters/local-monolith/telegram-connection-token.ts';
import { SecretStore } from '../src/platform/secrets.ts';
import { setup } from './config-reload-fixtures.ts';
import { writeTestKeyJar } from './helpers.ts';

function gatewayFixture() {
  const published: TelegramTokenSource[] = [];
  let prepared = 0;
  let secrets!: SecretStore;
  const fixturePromise = setup({
    secrets: (keyJar) => {
      secrets = new SecretStore(keyJar);
      return secrets;
    },
    telegramConfig: {
      prepare: async (candidate) => {
        prepared += 1;
        return await resolveTelegramTokenSource(candidate, secrets);
      },
      publish: (source) => {
        published.push(source);
      },
    },
  });
  return {
    fixturePromise,
    published,
    prepared: () => prepared,
  };
}

test('publishing a new token hands it to the connection manager without failing the apply', async () => {
  const { fixturePromise, published, prepared } = gatewayFixture();
  const fixture = await fixturePromise;
  try {
    // The first apply publishes the startup source even when nothing changed:
    // the manager deduplicates it, and this keeps the reloader stateless.
    expect((await fixture.reloader.reloadFromFile()).ok).toBe(true);
    expect(published.at(-1)).toEqual({ kind: 'token', token: 'telegram-secret' });

    await fixture.patch((config) => {
      config.telegram.token = { jar: 'agent-rotated' };
    });
    expect((await fixture.reloader.reloadFromFile()).ok).toBe(true);
    expect(published.at(-1)).toEqual({ kind: 'token', token: 'agent-rotated' });

    // Clearing the token is a hot change that reaches the manager as disabled.
    await fixture.patch((config) => {
      delete (config.telegram as { token?: unknown }).token;
    });
    expect((await fixture.reloader.reloadFromFile()).ok).toBe(true);
    expect(published.at(-1)).toEqual({ kind: 'disabled' });

    // A SecretRef that cannot be resolved is a configuration state, not a
    // failed apply: the file is valid and the panel must be able to show why.
    await fixture.patch((config) => {
      config.telegram.token = { env: 'SUROWAN_TEST_MISSING_TELEGRAM_TOKEN' };
    });
    const result = await fixture.reloader.reloadFromFile();
    expect(result.ok).toBe(true);
    expect(published.at(-1)).toMatchObject({ kind: 'unreadable' });
    expect(prepared()).toBeGreaterThanOrEqual(4);
  } finally {
    fixture.store.close();
  }
});

test('a key-jar rotation republishes the token although the file did not change', async () => {
  const { fixturePromise, published } = gatewayFixture();
  const fixture = await fixturePromise;
  try {
    expect((await fixture.reloader.reloadFromFile()).ok).toBe(true);
    expect(published.at(-1)).toEqual({ kind: 'token', token: 'telegram-secret' });

    // Only the jar entry behind the same SecretRef moves.
    await writeTestKeyJar(fixture.directory, { telegram: 'rotated-telegram-secret' });
    expect((await fixture.reloader.reloadFromFile()).ok).toBe(true);
    expect(published.at(-1)).toEqual({ kind: 'token', token: 'rotated-telegram-secret' });

    // And an apply with neither file nor jar movement does not republish.
    const count = published.length;
    expect((await fixture.reloader.reloadFromFile()).ok).toBe(true);
    expect(published).toHaveLength(count);
  } finally {
    fixture.store.close();
  }
});
