import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  API_KEY,
  ITEM,
  errorDocument,
  jsonResponse,
  preflightOr,
  runCli,
  setupCliWorkDir,
  startServer,
  teardownCliWorkDir,
} from './cli-fixtures.ts';

beforeAll(async () => {
  await setupCliWorkDir();
});

afterAll(async () => {
  await teardownCliWorkDir();
});

describe('surowan-utils invocation CLI', () => {
  it('never echoes the API key, even when a server reflects it', async () => {
    const server = await startServer((_request, response) => {
      jsonResponse(response, 500, { error: 'internal_error', message: `request for ${API_KEY} failed` });
    });
    try {
      const result = await runCli(['invocation', 'list', '--json'], {
        env: { SUROWAN_ENDPOINT: server.baseUrl, SUROWAN_API_KEY: API_KEY },
      });
      expect(result.code).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).not.toContain(API_KEY);
      expect(result.stderr).toContain('[redacted]');
    } finally {
      await server.close();
    }
  }, 20_000);

  it('redacts the API key echoed by successful bodies and keeps JSON valid', async () => {
    const echo = `key ${API_KEY}`;
    const server = await startServer(
      preflightOr((request, response) => {
        const path = request.url ?? '';
        if (path.endsWith('/replay')) {
          jsonResponse(response, 200, { status: 'started', invocation_id: '43', error: null, echo });
          return;
        }
        if (path.startsWith('/api/invocations/')) {
          jsonResponse(response, 200, { id: '42', state: 'failed', echo });
          return;
        }
        jsonResponse(response, 200, {
          items: [
            {
              ...ITEM,
              chat: { ...ITEM.chat, title: `group ${API_KEY}` },
              // Redaction must also cover the matched-message excerpt the human
              // list renders from the new filter response.
              matched_messages: [
                {
                  source: 'bot',
                  telegram_message_id: null,
                  telegram_send_id: '77',
                  at: '2026-10-05T00:00:00Z',
                  text: echo,
                },
              ],
            },
          ],
          next_cursor: echo,
        });
      }),
    );
    try {
      const env = { SUROWAN_ENDPOINT: server.baseUrl, SUROWAN_API_KEY: API_KEY };
      const runs: readonly (readonly [readonly string[], string])[] = [
        [['invocation', 'list', '--json'], 'next_cursor'],
        [['invocation', 'get', '42', '--json'], 'echo'],
        [['invocation', 'replay', '42', '--json'], 'echo'],
      ];
      for (const [args, field] of runs) {
        const result = await runCli(args, { env });
        expect(result.code, args.join(' ')).toBe(0);
        expect(result.stderr, args.join(' ')).toBe('');
        expect(result.stdout, args.join(' ')).not.toContain(API_KEY);
        const document = JSON.parse(result.stdout) as Record<string, unknown>;
        expect(document[field], args.join(' ')).toBe('key [redacted]');
      }
      const human = await runCli(['invocation', 'list'], { env });
      expect(human.code).toBe(0);
      expect(human.stdout).not.toContain(API_KEY);
      expect(human.stdout).toContain('group [redacted]');
      expect(human.stdout).toContain('send=77');
      expect(human.stdout).toContain('key [redacted]');
    } finally {
      await server.close();
    }
  }, 30_000);

  it('redacts a structured replay failure on stdout and stderr', async () => {
    const failure = {
      status: 'failed',
      invocation_id: '44',
      error: `provider_unavailable ${API_KEY}`,
      message: `upstream ${API_KEY} is down`,
    };
    const server = await startServer(
      preflightOr((_request, response) => {
        jsonResponse(response, 200, failure);
      }),
    );
    try {
      const result = await runCli(['invocation', 'replay', '42', '--json'], {
        env: { SUROWAN_ENDPOINT: server.baseUrl, SUROWAN_API_KEY: API_KEY },
      });
      expect(result.code).toBe(1);
      expect(result.stdout).not.toContain(API_KEY);
      expect(result.stderr).not.toContain(API_KEY);
      expect(result.stderr).toContain('replay did not complete');
      expect(result.stderr).toContain('[redacted]');
      expect(JSON.parse(result.stdout)).toEqual({
        ...failure,
        error: 'provider_unavailable [redacted]',
        message: 'upstream [redacted] is down',
      });
    } finally {
      await server.close();
    }
  }, 20_000);

  it('redacts an API key echoed through a server error code', async () => {
    const server = await startServer((_request, response) => {
      jsonResponse(response, 400, { error: `bad_key_${API_KEY}`, message: `key ${API_KEY} was rejected` });
    });
    try {
      const result = await runCli(['invocation', 'get', '42', '--json'], {
        env: { SUROWAN_ENDPOINT: server.baseUrl, SUROWAN_API_KEY: API_KEY },
      });
      expect(result.code).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).not.toContain(API_KEY);
      expect(errorDocument(result)).toEqual({ error: 'bad_key_[redacted]', message: 'key [redacted] was rejected' });
    } finally {
      await server.close();
    }
  }, 20_000);

  it('redacts a JSON-escaped key form without corrupting the JSON document', async () => {
    // This key ends in a backslash, so the raw form does not appear in JSON
    // output; only its escaped form does. Redacting it must not unbalance the
    // enclosing document.
    const escapedKey = 'esc\\';
    const server = await startServer((_request, response) => {
      jsonResponse(response, 200, { id: '42', echo: `echo ${escapedKey}` });
    });
    try {
      const result = await runCli(['invocation', 'get', '42', '--json'], {
        env: { SUROWAN_ENDPOINT: server.baseUrl, SUROWAN_API_KEY: escapedKey },
      });
      expect(result.code).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).not.toContain(escapedKey);
      const document = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(document.echo).toBe('echo [redacted]');
    } finally {
      await server.close();
    }
  }, 20_000);
});
