import { Buffer } from 'node:buffer';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  API_KEY,
  errorDocument,
  jsonResponse,
  preflightOr,
  runCli,
  setupCliWorkDir,
  startServer,
  teardownCliWorkDir,
} from './invocation-cli-fixtures.ts';

beforeAll(async () => {
  await setupCliWorkDir();
});

afterAll(async () => {
  await teardownCliWorkDir();
});

describe('surowan-utils invocation CLI', () => {
  it('server JSON errors become JSON on stderr with a non-zero exit', async () => {
    const server = await startServer((_request, response) => {
      jsonResponse(response, 400, { error: 'invalid_state', message: 'state filter is invalid' });
    });
    try {
      const result = await runCli(['invocation', 'list', '--json'], {
        env: { SUROWAN_ENDPOINT: server.baseUrl, SUROWAN_API_KEY: API_KEY },
      });
      expect(result.code).toBe(1);
      expect(result.stdout).toBe('');
      expect(errorDocument(result)).toEqual({ error: 'invalid_state', message: 'state filter is invalid' });
    } finally {
      await server.close();
    }
  }, 20_000);

  it('rejects a non-JSON success body', async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<html>proxy error</html>');
    });
    try {
      const result = await runCli(['invocation', 'list', '--json'], {
        env: { SUROWAN_ENDPOINT: server.baseUrl, SUROWAN_API_KEY: API_KEY },
      });
      expect(result.code).toBe(1);
      expect(result.stdout).toBe('');
      expect(errorDocument(result).error).toBe('invalid_response');
    } finally {
      await server.close();
    }
  }, 20_000);

  it('does not follow redirects', async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(302, { location: `${server.baseUrl}/elsewhere` });
      response.end();
    });
    try {
      const result = await runCli(['invocation', 'list', '--json'], {
        env: { SUROWAN_ENDPOINT: server.baseUrl, SUROWAN_API_KEY: API_KEY },
      });
      expect(result.code).toBe(1);
      expect(errorDocument(result).error).toBe('redirect_not_allowed');
      expect(server.requests).toHaveLength(1);
    } finally {
      await server.close();
    }
  }, 20_000);

  it.each(['', 'unfinished prompt'])(
    'times out on stdin without EOF before sending HTTP: %j',
    async (stdin) => {
      const server = await startServer((_request, response) => {
        jsonResponse(response, 200, { error: null });
      });
      try {
        const result = await runCli(
          ['invocation', 'replay', '42', '--global-prompt', '-', '--timeout-ms', '250', '--json'],
          {
            env: { SUROWAN_ENDPOINT: server.baseUrl, SUROWAN_API_KEY: API_KEY },
            stdin,
            keepStdinOpen: true,
          },
        );
        expect(server.requests).toHaveLength(0);
        expect(result.code).toBe(1);
        expect(result.stdout).toBe('');
        expect(errorDocument(result)).toEqual({
          error: 'timeout',
          message: 'stdin timed out after 250ms; no request was sent',
        });
        expect(result.stderr).not.toContain(API_KEY);
      } finally {
        await server.close();
      }
    },
    20_000,
  );

  it('aborts on timeout without retrying', async () => {
    const server = await startServer(() => {
      // Never respond: the client must abort the in-flight request itself.
    });
    try {
      const result = await runCli(['invocation', 'list', '--timeout-ms', '500', '--json'], {
        env: { SUROWAN_ENDPOINT: server.baseUrl, SUROWAN_API_KEY: API_KEY },
      });
      expect(result.code).toBe(1);
      expect(errorDocument(result).error).toBe('timeout');
      expect(server.requests).toHaveLength(1);
    } finally {
      await server.close();
    }
  }, 20_000);

  it('times out when a 200 response body stalls, without retrying', async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write('{"items": [');
      // Never end the body: only the client-side timeout can stop the read.
    });
    try {
      const result = await runCli(['invocation', 'list', '--timeout-ms', '500', '--json'], {
        env: { SUROWAN_ENDPOINT: server.baseUrl, SUROWAN_API_KEY: API_KEY },
      });
      expect(result.code).toBe(1);
      expect(result.stdout).toBe('');
      expect(errorDocument(result).error).toBe('timeout');
      expect(server.requests).toHaveLength(1);
    } finally {
      await server.close();
    }
  }, 20_000);

  it.each([
    ['get', 'content-length'],
    ['get', 'chunked'],
    ['replay', 'content-length'],
    ['replay', 'chunked'],
  ])(
    'reads JSON responses larger than 4 MiB for %s with %s',
    async (command, framing) => {
      const body = { id: '42', error: null, payload: `${'a'.repeat(4 * 1024 * 1024)}末尾` };
      const encoded = JSON.stringify(body);
      const server = await startServer(
        preflightOr((_request, response) => {
          response.setHeader('content-type', 'application/json');
          if (framing === 'content-length') {
            response.setHeader('content-length', Buffer.byteLength(encoded));
          } else {
            response.setHeader('transfer-encoding', 'chunked');
          }
          response.end(encoded);
        }),
      );
      try {
        const result = await runCli(['invocation', command, '42', '--json'], {
          env: { SUROWAN_ENDPOINT: server.baseUrl, SUROWAN_API_KEY: API_KEY },
        });
        expect(result.code).toBe(0);
        expect(result.stderr).toBe('');
        expect(JSON.parse(result.stdout)).toEqual(body);
        expect(server.requests.map((request) => request.method)).toEqual(
          command === 'replay' ? ['GET', 'POST'] : ['GET'],
        );
      } finally {
        await server.close();
      }
    },
    20_000,
  );

  it('preserves server JSON errors larger than 4 MiB without retrying', async () => {
    const server = await startServer((_request, response) => {
      jsonResponse(response, 500, {
        error: 'server_failure',
        message: `request for ${API_KEY} failed`,
        details: 'a'.repeat(4 * 1024 * 1024),
      });
    });
    try {
      const result = await runCli(['invocation', 'list', '--json'], {
        env: { SUROWAN_ENDPOINT: server.baseUrl, SUROWAN_API_KEY: API_KEY },
      });
      expect(result.code).toBe(1);
      expect(result.stdout).toBe('');
      expect(errorDocument(result)).toEqual({ error: 'server_failure', message: 'request for [redacted] failed' });
      expect(result.stderr).not.toContain(API_KEY);
      expect(server.requests).toHaveLength(1);
    } finally {
      await server.close();
    }
  }, 20_000);
});
