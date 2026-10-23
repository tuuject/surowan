import { describe, expect, it } from 'vitest';
import { credentialsPath, writeCredentials } from '../packages/cli/src/credentials.ts';
import { KEY, cli, home, json, server } from './cli-login-fixtures.ts';

describe('surowan-utils login and doctor', () => {
  it.each([401, 403])('doctor fails on HTTP %s and redacts a reflected saved key without retrying', async (status) => {
    const homeDir = await home();
    const http = await server((response) =>
      json(response, status, { error: 'unauthenticated', message: `reflected ${KEY}` }),
    );
    await writeCredentials(credentialsPath(homeDir), { endpoint: http.endpoint, apiKey: KEY });
    const result = await cli(['doctor', '--json'], homeDir);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr)).toEqual({ error: 'unauthenticated', message: 'reflected [redacted]' });
    expect(http.requests).toHaveLength(1);
  });

  it('doctor rejects a redirect and unexpected successful JSON without reporting a healthy login', async () => {
    const homeDir = await home();
    const http = await server((response) => {
      if (http.requests.length === 1) {
        response.writeHead(302, { location: `${http.endpoint}/elsewhere` });
        response.end();
      } else {
        json(response, 200, { status: 'ok' });
      }
    });
    await writeCredentials(credentialsPath(homeDir), { endpoint: http.endpoint, apiKey: KEY });
    const redirect = await cli(['doctor', '--json'], homeDir);
    expect(redirect.code).toBe(1);
    expect(JSON.parse(redirect.stderr).error).toBe('redirect_not_allowed');
    const invalid = await cli(['doctor', '--json'], homeDir);
    expect(invalid.code).toBe(1);
    expect(JSON.parse(invalid.stderr).error).toBe('invalid_response');
    expect(invalid.stdout).toBe('');
    expect(http.requests).toHaveLength(2);
  });

  it('doctor aborts a stalled server without retries', async () => {
    const homeDir = await home();
    const http = await server(() => {});
    await writeCredentials(credentialsPath(homeDir), { endpoint: http.endpoint, apiKey: KEY });
    const result = await cli(['doctor', '--timeout-ms', '100', '--json'], homeDir);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr).error).toBe('timeout');
    expect(http.requests).toHaveLength(1);
  });
});
