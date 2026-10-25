import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { credentialsPath, writeCredentials } from '../../packages/cli/src/credentials.ts';
import { KEY, child, cli, home, json, server, terminal } from './login-fixtures.ts';

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
      expect(JSON.parse(result.stderr).error).toBe('missing_api_key');
      expect(result.stderr).not.toContain(KEY);
    }
    expect(first.requests).toHaveLength(0);
    expect(other.requests).toHaveLength(0);
  });

  it('reports missing login, rejects irrelevant flags and never prompts in a non-TTY', async () => {
    const homeDir = await home();
    const missing = await cli(['doctor', '--json'], homeDir);
    expect(missing.code).toBe(2);
    expect(JSON.parse(missing.stderr).error).toBe('missing_endpoint');
    for (const args of [
      ['doctor', '--limit', '1'],
      ['invocation', 'list', '--api-key-stdin'],
      ['login', 'extra'],
    ]) {
      const result = await cli(args, homeDir);
      expect(result.code).toBe(2);
      expect(result.stdout).toBe('');
    }
    const login = await child(['login', '--json'], homeDir, '');
    expect(login.code).toBe(2);
    expect(JSON.parse(login.stderr).error).toBe('login_input_required');
  });

  it('prompts for endpoint and hidden key, allows editing and restores terminal mode', async () => {
    const homeDir = await home();
    const tty = terminal();
    const pending = cli(['login', '--json'], homeDir);
    expect(tty.stderr()).toContain('Admin API endpoint: ');
    tty.input.write('https://admin.example.com\r');
    await vi.waitFor(() => expect(tty.stderr()).toContain('API key (hidden): '));
    tty.input.write(`${KEY}x\u007f\r`);
    const result = await pending;
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).status).toBe('saved');
    expect(result.stderr).toBe('');
    expect(tty.stderr()).not.toContain(KEY);
    expect(tty.rawModes).toEqual([true, false, true, false]);
    expect(JSON.parse(await readFile(credentialsPath(homeDir), 'utf8')).apiKey).toBe(KEY);
  });

  it.each(['interrupt', 'eof', 'timeout'])(
    'cancels hidden input on %s without saving and restores terminal mode',
    async (action) => {
      const homeDir = await home();
      const tty = terminal();
      const pending = cli(
        ['login', '--endpoint', 'https://admin.example.com', '--timeout-ms', '100', '--json'],
        homeDir,
      );
      expect(tty.stderr()).toContain('API key (hidden): ');
      tty.input.write(KEY);
      if (action === 'interrupt') {
        tty.input.write('\u0003');
      } else if (action === 'eof') {
        // Ctrl+D closes readline only on an empty editing buffer.
        tty.input.write('\u0015\u0004');
      }
      const result = await pending;
      expect(result.code).toBe(action === 'timeout' ? 1 : 2);
      expect(JSON.parse(result.stderr).error).toBe(action === 'timeout' ? 'timeout' : 'login_cancelled');
      expect(result.stdout).toBe('');
      expect(`${tty.stderr()}${result.stderr}`).not.toContain(KEY);
      expect(tty.rawModes).toEqual([true, false]);
      await expect(readFile(credentialsPath(homeDir))).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

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
