import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { describe, expect, it } from 'vitest';
import { credentialsPath, writeCredentials } from '../packages/cli/src/credentials.ts';
import { KEY, cli, home, json, server } from './cli-login-fixtures.ts';

describe('surowan-utils login and doctor', () => {
  it('saves a complete pair without networking, then doctor and list use the saved login', async () => {
    const homeDir = await home();
    const http = await server((response) =>
      json(response, 200, {
        items: [{ id: '42', private_message: 'not for the diagnostic output', echoed_key: KEY }],
        next_cursor: null,
      }),
    );
    const login = await cli(['login', '--endpoint', http.endpoint, '--json'], homeDir, { SUROWAN_API_KEY: KEY });
    expect(login.code).toBe(0);
    expect(login.stderr).toBe('');
    expect(JSON.parse(login.stdout)).toEqual({
      status: 'saved',
      endpoint: `${http.endpoint}/`,
      credentials_file: credentialsPath(homeDir),
    });
    expect(login.stdout).not.toContain(KEY);
    expect(http.requests).toHaveLength(0);
    expect(JSON.parse(await readFile(credentialsPath(homeDir), 'utf8'))).toEqual({
      endpoint: `${http.endpoint}/`,
      apiKey: KEY,
    });

    const doctor = await cli(['doctor', '--json'], homeDir);
    expect(doctor.code).toBe(0);
    expect(doctor.stderr).toBe('');
    expect(JSON.parse(doctor.stdout)).toEqual({
      status: 'ok',
      endpoint: `${http.endpoint}/`,
      credential_sources: { endpoint: 'file', api_key: 'file' },
    });
    expect(doctor.stdout).not.toContain('private_message');
    expect(doctor.stdout).not.toContain(KEY);
    expect(http.requests).toEqual([{ method: 'GET', url: '/api/invocations?limit=1', authorization: `Bearer ${KEY}` }]);

    const list = await cli(['invocation', 'list', '--json'], homeDir);
    expect(list.code).toBe(0);
    expect(list.stdout).not.toContain(KEY);
    expect(http.requests).toHaveLength(2);
    expect(http.requests[1]?.url).toBe('/api/invocations');
  });

  it('honors argument, environment and file priority without modifying the saved pair', async () => {
    const homeDir = await home();
    const http = await server((response) => json(response, 200, { items: [], next_cursor: null }));
    await writeCredentials(credentialsPath(homeDir), { endpoint: http.endpoint, apiKey: KEY });
    const before = await readFile(credentialsPath(homeDir), 'utf8');
    const fromEnv = await cli(['doctor', '--json'], homeDir, { SUROWAN_API_KEY: 'synthetic-environment-key' });
    expect(fromEnv.code).toBe(0);
    expect(JSON.parse(fromEnv.stdout).credential_sources).toEqual({ endpoint: 'file', api_key: 'environment' });
    const fromArgs = await cli(
      ['doctor', '--endpoint', http.endpoint, '--api-key', 'synthetic-argument-key', '--json'],
      homeDir,
      {
        SUROWAN_ENDPOINT: 'https://unused.example.com',
        SUROWAN_API_KEY: 'synthetic-environment-key',
      },
    );
    expect(fromArgs.code).toBe(0);
    expect(JSON.parse(fromArgs.stdout).credential_sources).toEqual({ endpoint: 'argument', api_key: 'argument' });
    expect(http.requests.map((request) => request.authorization)).toEqual([
      'Bearer synthetic-environment-key',
      'Bearer synthetic-argument-key',
    ]);
    expect(await readFile(credentialsPath(homeDir), 'utf8')).toBe(before);
  });

  it('bypasses a malformed saved file for an explicit pair but fails safely when fallback is needed', async () => {
    const homeDir = await home();
    const http = await server((response) => json(response, 200, { items: [], next_cursor: null }));
    const path = credentialsPath(homeDir);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const corrupted = `{"apiKey":"${KEY}",`;
    await writeFile(path, corrupted, { mode: 0o600 });
    const explicit = await cli(['doctor', '--endpoint', http.endpoint, '--api-key', KEY, '--json'], homeDir);
    expect(explicit.code).toBe(0);
    expect(http.requests).toHaveLength(1);
    const fromEnvironment = await cli(['doctor', '--json'], homeDir, {
      SUROWAN_ENDPOINT: http.endpoint,
      SUROWAN_API_KEY: KEY,
    });
    expect(fromEnvironment.code).toBe(0);
    expect(http.requests).toHaveLength(2);
    const fallback = await cli(['doctor', '--json'], homeDir);
    expect(fallback.code).toBe(1);
    expect(JSON.parse(fallback.stderr).error).toBe('invalid_credentials');
    expect(fallback.stderr).not.toContain(KEY);
    expect(http.requests).toHaveLength(2);
    expect(await readFile(path, 'utf8')).toBe(corrupted);

    const repaired = await cli(['login', '--endpoint', http.endpoint, '--json'], homeDir, {
      SUROWAN_API_KEY: KEY,
    });
    expect(repaired.code).toBe(0);
    expect(repaired.stderr).toBe('');
    expect(repaired.stdout).not.toContain(KEY);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ endpoint: `${http.endpoint}/`, apiKey: KEY });
    expect(http.requests).toHaveLength(2);
    expect((await cli(['doctor', '--json'], homeDir)).code).toBe(0);
    expect(http.requests).toHaveLength(3);
  });

  it('treats empty explicit values as invalid instead of silently falling back', async () => {
    const homeDir = await home();
    const http = await server((response) => json(response, 200, { items: [], next_cursor: null }));
    await writeCredentials(credentialsPath(homeDir), { endpoint: http.endpoint, apiKey: KEY });
    for (const env of [{ SUROWAN_API_KEY: '' }, { SUROWAN_ENDPOINT: '' }]) {
      const result = await cli(['doctor', '--json'], homeDir, env);
      expect(result.code).toBe(2);
      expect(result.stdout).toBe('');
    }
    expect(http.requests).toHaveLength(0);
  });
});
