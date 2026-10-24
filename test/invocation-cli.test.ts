import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_SEARCH_LENGTH } from '../packages/cli/src/args/spec.ts';
import { parseEndpoint } from '../packages/cli/src/client.ts';
import { CliError } from '../packages/cli/src/errors.ts';
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

function endpointErrorCode(raw: string): string | undefined {
  try {
    parseEndpoint(raw);
    return undefined;
  } catch (error) {
    return error instanceof CliError ? error.code : 'not_a_cli_error';
  }
}

beforeAll(async () => {
  await setupCliWorkDir();
});

afterAll(async () => {
  await teardownCliWorkDir();
});

describe('surowan-utils invocation CLI', () => {
  it('rejects unknown arguments and subcommands instead of ignoring them', async () => {
    const server = await startServer((_request, response) => {
      jsonResponse(response, 200, { items: [], next_cursor: null });
    });
    try {
      const env = { SUROWAN_ENDPOINT: server.baseUrl, SUROWAN_API_KEY: API_KEY };
      const unknownOption = await runCli(['invocation', 'list', '--bogus', '--json'], { env });
      expect(unknownOption.code).toBe(2);
      expect(errorDocument(unknownOption).error).toBe('invalid_arguments');

      const unknownSubcommand = await runCli(['invocation', 'frobnicate', '--json'], { env });
      expect(unknownSubcommand.code).toBe(2);
      expect(errorDocument(unknownSubcommand).error).toBe('unknown_subcommand');

      const extraPositional = await runCli(['invocation', 'list', 'extra', '--json'], { env });
      expect(extraPositional.code).toBe(2);
      expect(errorDocument(extraPositional).error).toBe('unexpected_argument');

      const wrongOption = await runCli(['invocation', 'get', '4', '--limit', '5', '--json'], { env });
      expect(wrongOption.code).toBe(2);
      expect(errorDocument(wrongOption).error).toBe('unexpected_option');

      const removedSystemPrompt = await runCli(['invocation', 'replay', '4', '--system-prompt', 'x', '--json'], {
        env,
      });
      expect(removedSystemPrompt.code).toBe(2);
      expect(errorDocument(removedSystemPrompt).error).toBe('invalid_arguments');

      const wrongMediaFlag = await runCli(['invocation', 'media', '4', '--source', 'active', '--json'], { env });
      expect(wrongMediaFlag.code).toBe(2);
      expect(errorDocument(wrongMediaFlag).error).toBe('unexpected_option');

      const badSource = await runCli(['config', 'show', '--source', 'runtime', '--json'], { env });
      expect(badSource.code).toBe(2);
      expect(errorDocument(badSource).error).toBe('invalid_source');

      const badVariant = await runCli(['invocation', 'media', '4', '--variant', 'thumbnail', '--json'], { env });
      expect(badVariant.code).toBe(2);
      expect(errorDocument(badVariant).error).toBe('invalid_variant');

      const groupWithoutChat = await runCli(['prompt', 'get', 'group', '--json'], { env });
      expect(groupWithoutChat.code).toBe(2);
      expect(errorDocument(groupWithoutChat).error).toBe('missing_argument');

      const chatOnGlobal = await runCli(['prompt', 'get', 'global', '--chat', '-1', '--json'], { env });
      expect(chatOnGlobal.code).toBe(2);
      expect(errorDocument(chatOnGlobal).error).toBe('unexpected_option');

      const bothStdin = await runCli(
        ['invocation', 'replay', '4', '--global-prompt', '-', '--group-prompt', '-', '--json'],
        { env },
      );
      expect(bothStdin.code).toBe(2);
      expect(errorDocument(bothStdin).error).toBe('conflicting_prompt_input');

      expect(server.requests).toHaveLength(0);
    } finally {
      await server.close();
    }
  }, 30_000);

  it('validates ids, limits and filters before any request', async () => {
    const server = await startServer((_request, response) => {
      jsonResponse(response, 200, { items: [], next_cursor: null });
    });
    try {
      const env = { SUROWAN_ENDPOINT: server.baseUrl, SUROWAN_API_KEY: API_KEY };
      const cases: readonly (readonly [readonly string[], string])[] = [
        [['invocation', 'get', '12abc', '--json'], 'invalid_id'],
        [['invocation', 'get', '99999999999999999999', '--json'], 'invalid_id'],
        [['invocation', 'get', '9223372036854775808', '--json'], 'invalid_id'],
        [['invocation', 'list', '--limit', '0', '--json'], 'invalid_limit'],
        [['invocation', 'list', '--limit', '101', '--json'], 'invalid_limit'],
        [['invocation', 'list', '--limit', 'abc', '--json'], 'invalid_limit'],
        [['invocation', 'list', '--state', 'bad state', '--json'], 'invalid_state'],
        [['invocation', 'list', '--search', '', '--json'], 'invalid_search'],
        [['invocation', 'list', '--search', 'a'.repeat(MAX_SEARCH_LENGTH + 1), '--json'], 'invalid_search'],
        [['invocation', 'list', '--at', '2026-13-01T00:00', '--json'], 'invalid_at'],
        [['invocation', 'list', '--at', '2026-02-29T00:00', '--json'], 'invalid_at'],
        [['invocation', 'list', '--at', '2026-04-31T00:00', '--json'], 'invalid_at'],
        [['invocation', 'list', '--at', '2026-10-06T24:00', '--json'], 'invalid_at'],
        [['invocation', 'list', '--at', '2026-10-06T12:60', '--json'], 'invalid_at'],
        [['invocation', 'list', '--at', '2026-10-06T12:00:00.1234', '--json'], 'invalid_at'],
        [['invocation', 'list', '--at', '20261006T120000', '--json'], 'invalid_at'],
        [['invocation', 'list', '--at', '2026-10-06T12:00+25:00', '--json'], 'invalid_at'],
        [['invocation', 'list', '--at', '2026-10-06T12:00+08:60', '--json'], 'invalid_at'],
        [['invocation', 'list', '--at', '0999-12-31T00:00', '--json'], 'invalid_at'],
        [['invocation', 'list', '--from', '2026-10-06T12:00:61', '--json'], 'invalid_from'],
        [['invocation', 'list', '--to', '2026-10-06 12:00:00.Z', '--json'], 'invalid_to'],
        [['invocation', 'list', '--to', '2026-10-06T12:00+14:01', '--json'], 'invalid_to'],
        [
          ['invocation', 'list', '--at', '2026-10-06T12:00', '--from', '2026-10-06T13:00', '--json'],
          'invalid_time_range',
        ],
        [
          ['invocation', 'list', '--at', '2026-10-06T12:00', '--to', '2026-10-06T13:00', '--json'],
          'invalid_time_range',
        ],
        [
          ['invocation', 'list', '--from', '2026-10-06T13:00:00Z', '--to', '2026-10-06T12:00:00Z', '--json'],
          'invalid_time_range',
        ],
        [
          ['invocation', 'list', '--from', '2026-10-06T00:00:00Z', '--to', '2026-10-06T08:00:00+08:00', '--json'],
          'invalid_time_range',
        ],
        [
          ['invocation', 'list', '--from', '2026-10-06T23:00:00+08:00', '--to', '2026-10-06T12:00:00Z', '--json'],
          'invalid_time_range',
        ],
        [['invocation', 'preflight', '42', '--before-send', '0', '--json'], 'invalid_before_send'],
        [['invocation', 'preflight', '42', '--before-send', '-1', '--json'], 'invalid_before_send'],
        [['invocation', 'preflight', '42', '--before-send', 'abc', '--json'], 'invalid_before_send'],
        [['invocation', 'preflight', '42', '--before-send', '9223372036854775808', '--json'], 'invalid_before_send'],
        [['invocation', 'replay', '42', '--before-send', '12.5', '--json'], 'invalid_before_send'],
      ];
      for (const [args, code] of cases) {
        const result = await runCli(args, { env });
        expect(result.code, args.join(' ')).toBe(2);
        expect(errorDocument(result).error, args.join(' ')).toBe(code);
      }
      expect(server.requests).toHaveLength(0);
    } finally {
      await server.close();
    }
  }, 30_000);

  it('canonicalizes leading-zero decimal ids for every id input', async () => {
    const server = await startServer(
      preflightOr((request, response) => {
        const path = request.url ?? '';
        if (path.startsWith('/api/invocations?')) {
          jsonResponse(response, 200, { items: [], next_cursor: null });
          return;
        }
        if (path.startsWith('/api/prompts/')) {
          jsonResponse(response, 200, {
            source: 'active',
            scope: 'group',
            chat_id: '-42',
            prompt: 'group prompt',
            core_read_only: true,
            generation: 1,
            hash: 'group-hash',
          });
          return;
        }
        if (path.endsWith('/replay')) {
          jsonResponse(response, 200, { status: 'started', invocation_id: '8', error: null });
          return;
        }
        jsonResponse(response, 200, { id: '42', state: 'completed' });
      }),
    );
    try {
      const env = { SUROWAN_ENDPOINT: server.baseUrl, SUROWAN_API_KEY: API_KEY };
      expect((await runCli(['invocation', 'get', '0042', '--json'], { env })).code).toBe(0);
      expect(
        (await runCli(['invocation', 'list', '--cursor', '007', '--chat', '-00100', '--json'], { env })).code,
      ).toBe(0);
      expect((await runCli(['invocation', 'replay', '0007', '--json'], { env })).code).toBe(0);
      expect((await runCli(['prompt', 'get', 'group', '--chat', '-0042', '--json'], { env })).code).toBe(0);
      expect((await runCli(['invocation', 'preflight', '0007', '--before-send', '0042', '--json'], { env })).code).toBe(
        0,
      );
      expect(server.requests.map((request) => `${request.method} ${request.url}`)).toEqual([
        'GET /api/invocations/42',
        'GET /api/invocations?cursor=7&chat=-100',
        'GET /api/invocations/7/replay-preflight',
        'POST /api/invocations/7/replay',
        'GET /api/prompts/group?source=active&chat=-42',
        'GET /api/invocations/7/replay-preflight?before_send_id=42',
      ]);
    } finally {
      await server.close();
    }
  }, 30_000);

  it('requires an endpoint and an API key, and refuses unsafe endpoints', async () => {
    const missingEndpoint = await runCli(['invocation', 'list', '--json']);
    expect(missingEndpoint.code).toBe(2);
    expect(errorDocument(missingEndpoint).error).toBe('missing_endpoint');

    const missingKey = await runCli(['invocation', 'list', '--json'], {
      env: { SUROWAN_ENDPOINT: 'http://127.0.0.1:8787' },
    });
    expect(missingKey.code).toBe(2);
    expect(errorDocument(missingKey).error).toBe('missing_api_key');

    const remotePlaintext = await runCli(['invocation', 'list', '--endpoint', 'http://10.255.255.1:9', '--json'], {
      env: { SUROWAN_API_KEY: API_KEY },
    });
    expect(remotePlaintext.code).toBe(2);
    expect(errorDocument(remotePlaintext).error).toBe('insecure_endpoint');

    const credentialUrl = await runCli(
      ['invocation', 'list', '--endpoint', 'http://user:pass@127.0.0.1:8787', '--json'],
      { env: { SUROWAN_API_KEY: API_KEY } },
    );
    expect(credentialUrl.code).toBe(2);
    expect(errorDocument(credentialUrl).error).toBe('invalid_endpoint');

    const nonHttp = await runCli(['invocation', 'list', '--endpoint', 'ftp://127.0.0.1:8787', '--json'], {
      env: { SUROWAN_API_KEY: API_KEY },
    });
    expect(nonHttp.code).toBe(2);
    expect(errorDocument(nonHttp).error).toBe('invalid_endpoint');
  }, 30_000);

  it('prints usage for --help without requiring an endpoint', async () => {
    const result = await runCli(['--help']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('surowan-utils - Surowan Admin API 工具客户端');
    expect(result.stdout).toContain('surowan-utils invocation replay');
    expect(result.stdout).toContain('--before-send');
    expect(result.stdout).toContain('--confirm-paid');
    expect(result.stdout).not.toContain('plasticwan-debug');
    expect(result.stderr).toBe('');
  }, 20_000);

  it('accepts https and loopback http endpoints and rejects unsafe forms', () => {
    expect(parseEndpoint('https://admin.example.com').href).toBe('https://admin.example.com/');
    expect(parseEndpoint('http://localhost:8787/base').href).toBe('http://localhost:8787/base/');
    expect(parseEndpoint('http://127.0.0.2:8787').hostname).toBe('127.0.0.2');
    expect(endpointErrorCode('http://10.0.0.5:8787')).toBe('insecure_endpoint');
    expect(endpointErrorCode('http://user:pass@127.0.0.1:8787')).toBe('invalid_endpoint');
    expect(endpointErrorCode('ftp://127.0.0.1:8787')).toBe('invalid_endpoint');
    expect(endpointErrorCode('http://127.0.0.1:8787/?a=1')).toBe('invalid_endpoint');
    expect(endpointErrorCode('not a url')).toBe('invalid_endpoint');
  });
});
