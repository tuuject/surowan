import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { credentialsPath, writeCredentials } from '../../packages/cli/src/credentials.ts';
import { KEY, child, cli, home, json, server } from './login-fixtures.ts';

describe('surowan-utils login and doctor', () => {
  it('never sends a saved key to a different endpoint override', async () => {
    const homeDir = await home();
    const first = await server((response) => json(response, 200, { items: [], next_cursor: null }));
    const other = await server((response) => json(response, 200, { items: [], next_cursor: null }));
    await writeCredentials(credentialsPath(homeDir), { endpoint: first.endpoint, apiKey: KEY });
    for (const options of [
      { args: ['doctor', '--endpoint', other.endpoint, '--json'], env: {} },
      { args: ['doctor', '--json'], env: { SUROWAN_ENDPOINT: other.endpoint } },
    ]) {
      const result = await cli(options.args, homeDir, options.env);
      expect(result.code).toBe(2);
      expect(JSON.parse(result.stderr).error).toBe('missing_credential');
      expect(result.stderr).not.toContain(KEY);
    }
    expect(first.requests).toHaveLength(0);
    expect(other.requests).toHaveLength(0);
  });

  it('reports missing login and requires an explicit key', async () => {
    const homeDir = await home();
    const missing = await cli(['doctor', '--json'], homeDir);
    expect(missing.code).toBe(2);
    expect(JSON.parse(missing.stderr).error).toBe('missing_endpoint');
    const login = await child(['login', '--endpoint', 'https://admin.example.com', '--json'], homeDir, '');
    expect(login.code).toBe(2);
    expect(JSON.parse(login.stderr).error).toBe('missing_argument');
  });

  it('accepts a piped single-line API key without printing it', async () => {
    const homeDir = await home();
    const result = await child(
      ['login', '--endpoint', 'https://admin.example.com', '--api-key-stdin', '--json'],
      homeDir,
      `${KEY}\r\n`,
    );
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout).status).toBe('saved');
    expect(result.stdout).not.toContain(KEY);
    expect(JSON.parse(await readFile(credentialsPath(homeDir), 'utf8')).apiKey).toBe(KEY);
  });

  it('bounds stdin, rejects conflicting sources, and preserves existing credentials on invalid login', async () => {
    const homeDir = await home();
    await writeCredentials(credentialsPath(homeDir), { endpoint: 'https://admin.example.com', apiKey: KEY });
    const before = await readFile(credentialsPath(homeDir), 'utf8');
    for (const input of ['', `${KEY}\nsecond-line`, Buffer.alloc(4_099, 0x61).toString()]) {
      const result = await child(
        ['login', '--endpoint', 'https://admin.example.com', '--api-key-stdin', '--json'],
        homeDir,
        input,
      );
      expect(result.code).toBe(2);
      expect(JSON.parse(result.stderr).error).toBe('invalid_api_key');
      expect(result.stdout).toBe('');
      expect(result.stderr).not.toContain(KEY);
      expect(await readFile(credentialsPath(homeDir), 'utf8')).toBe(before);
    }
    const conflict = await child(
      ['login', '--endpoint', 'https://admin.example.com', '--api-key-stdin'],
      homeDir,
      KEY,
      false,
      {
        SUROWAN_API_KEY: KEY,
      },
    );
    expect(conflict.code).toBe(2);
    expect(JSON.parse(conflict.stderr).error).toBe('conflicting_key_input');
    expect(await readFile(credentialsPath(homeDir), 'utf8')).toBe(before);
  }, 20_000);

  it('times out on unfinished key input without saving or sending HTTP', async () => {
    const homeDir = await home();
    const http = await server((response) => json(response, 200, { items: [], next_cursor: null }));
    const result = await child(
      ['login', '--endpoint', http.endpoint, '--api-key-stdin', '--timeout-ms', '100', '--json'],
      homeDir,
      KEY,
      true,
    );
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr).error).toBe('timeout');
    expect(result.stderr).not.toContain(KEY);
    expect(http.requests).toHaveLength(0);
    await expect(readFile(credentialsPath(homeDir))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
