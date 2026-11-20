import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { loadConfig } from '../../src/adapters/local-monolith/config/index.ts';
import { probeDoctorDecisionGate } from '../../src/doctor-decisions.ts';
import { keychainPath } from '../../src/platform/keychain.ts';
import { SecretStore } from '../../src/platform/secrets.ts';
import { type FixtureConfig, testConfigJsonc, writeTestConfig, writeTestKeychain } from '../helpers.ts';

/**
 * The doctor probe is the only place a dangling `api_key` shows up: at runtime
 * the gate admits every batch and goes quiet. The network is injected, so
 * nothing here reaches the real Decisions API.
 */

const directories: string[] = [];
const KEYCHAIN_ENTRY = 'decision-gate';
const API_KEY = '{{SECRET_8pj2vn7t}}';

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
  );
});

async function fixture(transform: (config: FixtureConfig) => void, keychain: Readonly<Record<string, string>> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'surowan-doctor-decision-gate-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(directory, configPath, testConfigJsonc(directory, transform));
  await writeTestKeychain(directory, keychain);
  const loaded = await loadConfig(configPath);
  return { loaded, secrets: new SecretStore(keychainPath(configPath)) };
}

function answerGate(): Response {
  return new Response(
    JSON.stringify({ answers: { gate: { type: 'noul', noul: 0.9 } }, usage: { input_tokens: 9, output_tokens: 1 } }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

describe('the doctor decision gate probe', () => {
  test('a disabled gate is skipped without resolving anything', async () => {
    const { loaded, secrets } = await fixture((config) => {
      config.telegram.decision_gate = { enabled: false, mode: 'enforce', api_key: { jar: 'missing-entry' } };
    });
    const fetchImpl = vi.fn();
    await expect(probeDoctorDecisionGate(loaded.config, secrets, { fetchImpl })).resolves.toEqual({
      status: 'disabled',
      model: null,
      base_url: null,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('a gate enabled on one Chat alone is still probed', async () => {
    const { loaded, secrets } = await fixture(
      (config) => {
        config.telegram.decision_gate = { api_key: { jar: KEYCHAIN_ENTRY } };
        config.telegram.chats = [
          {
            id: -1_001_234_567_890,
            instructions_file: 'chat-instructions.md',
            decision_gate: { enabled: true },
          },
        ];
      },
      { [KEYCHAIN_ENTRY]: API_KEY },
    );
    const fetchImpl = vi.fn(async () => answerGate());
    await expect(
      probeDoctorDecisionGate(loaded.config, secrets, { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).resolves.toEqual({
      status: 'connected',
      model: 'typesafe/jev-1.14',
      base_url: 'https://openrouter.ai/api/alpha',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://openrouter.ai/api/alpha/decisions');
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${API_KEY}`);
  });

  test('a dangling keychain reference is a doctor failure', async () => {
    const { loaded, secrets } = await fixture((config) => {
      config.telegram.decision_gate = { enabled: true, mode: 'shadow', api_key: { jar: 'not-there' } };
    });
    await expect(probeDoctorDecisionGate(loaded.config, secrets, { fetchImpl: vi.fn() })).rejects.toThrow(
      /Decision gate api_key cannot be read: .*not-there/,
    );
  });

  test('an auth failure is a doctor failure with the status', async () => {
    const { loaded, secrets } = await fixture(
      (config) => {
        config.telegram.decision_gate = { enabled: true, mode: 'shadow', api_key: { jar: KEYCHAIN_ENTRY } };
      },
      { [KEYCHAIN_ENTRY]: API_KEY },
    );
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { message: 'No auth credentials found' } }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        }),
    );
    await expect(
      probeDoctorDecisionGate(loaded.config, secrets, { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toThrow(
      /Decision gate probe failed: http_error \(HTTP 401\): The Decisions API answered with HTTP 401: No auth credentials found/,
    );
  });

  test('a failure that echoes the key reports it redacted', async () => {
    const { loaded, secrets } = await fixture(
      (config) => {
        config.telegram.decision_gate = { enabled: true, mode: 'shadow', api_key: { jar: KEYCHAIN_ENTRY } };
      },
      { [KEYCHAIN_ENTRY]: API_KEY },
    );
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { message: `Incorrect API key ${API_KEY}` } }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const failure = await probeDoctorDecisionGate(loaded.config, secrets, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('[redacted]');
    expect((failure as Error).message).not.toContain(API_KEY);
    expect(secrets.redact((failure as Error).message)).not.toContain(API_KEY);
  });

  test('a malformed answer is a doctor failure', async () => {
    const { loaded, secrets } = await fixture(
      (config) => {
        config.telegram.decision_gate = { enabled: true, mode: 'shadow', api_key: { jar: KEYCHAIN_ENTRY } };
      },
      { [KEYCHAIN_ENTRY]: API_KEY },
    );
    const fetchImpl = vi.fn(async () => new Response('not json', { status: 200 }));
    await expect(
      probeDoctorDecisionGate(loaded.config, secrets, { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toThrow(/Decision gate probe failed: invalid_response/);
  });
});
