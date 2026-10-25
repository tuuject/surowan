import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_PROMPT_CHARS } from '../../packages/cli/src/commands.ts';
import {
  API_KEY,
  cliPromptFile,
  cliWorkDir,
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
  it('replay asks the preflight first and sends an empty JSON object without prompt overrides', async () => {
    const server = await startServer(
      preflightOr((_request, response) => {
        jsonResponse(response, 200, { status: 'started', invocation_id: '43', error: null });
      }),
    );
    try {
      const result = await runCli(['invocation', 'replay', '42', '--json'], {
        env: { SUROWAN_ENDPOINT: server.baseUrl, SUROWAN_API_KEY: API_KEY },
      });
      expect(result.code).toBe(0);
      expect(result.stderr).toBe('');
      expect(server.requests).toHaveLength(2);
      const preflight = server.requests[0];
      expect(preflight?.method).toBe('GET');
      expect(preflight?.url).toBe('/api/invocations/42/replay-preflight');
      const request = server.requests[1];
      expect(request?.method).toBe('POST');
      expect(request?.url).toBe('/api/invocations/42/replay');
      expect(request?.headers['content-type']).toContain('application/json');
      expect(JSON.parse(request?.body ?? '')).toEqual({});
    } finally {
      await server.close();
    }
  }, 20_000);

  it('replay reads --global-prompt and --group-prompt from files and stdin', async () => {
    const server = await startServer(
      preflightOr((_request, response) => {
        jsonResponse(response, 200, { status: 'started', error: null });
      }),
    );
    try {
      const env = { SUROWAN_ENDPOINT: server.baseUrl, SUROWAN_API_KEY: API_KEY };
      const promptFile = cliPromptFile();
      const fromFile = await runCli(['invocation', 'replay', '42', '--global-prompt', promptFile, '--json'], { env });
      expect(fromFile.code).toBe(0);
      expect(JSON.parse(server.requests[1]?.body ?? '')).toEqual({ global_prompt: 'from the prompt file' });

      const fromStdin = await runCli(['invocation', 'replay', '42', '--group-prompt', '-', '--json'], {
        env,
        stdin: 'from stdin',
      });
      expect(fromStdin.code).toBe(0);
      expect(JSON.parse(server.requests[3]?.body ?? '')).toEqual({ group_prompt: 'from stdin' });

      // An empty group prompt is legal; an empty global prompt is rejected.
      const emptyGroup = await runCli(['invocation', 'replay', '42', '--group-prompt', '-', '--json'], {
        env,
        stdin: '',
      });
      expect(emptyGroup.code).toBe(0);
      expect(JSON.parse(server.requests[5]?.body ?? '')).toEqual({ group_prompt: '' });

      const both = await runCli(
        ['invocation', 'replay', '42', '--global-prompt', promptFile, '--group-prompt', '-', '--json'],
        { env, stdin: 'group' },
      );
      expect(both.code).toBe(0);
      expect(JSON.parse(server.requests[7]?.body ?? '')).toEqual({
        global_prompt: 'from the prompt file',
        group_prompt: 'group',
      });
    } finally {
      await server.close();
    }
  }, 30_000);

  it.each(['provider_unavailable', { code: 'model_error', message: 'upstream down' }])(
    'replay keeps a structured failure on stdout and emits JSON stderr: %j',
    async (error) => {
      const failure = { version: 1, source_invocation_id: '42', error };
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
        expect(JSON.parse(result.stdout)).toEqual(failure);
        expect(errorDocument(result)).toEqual({
          error: 'replay_failed',
          message: `replay did not complete: ${typeof error === 'string' ? error : JSON.stringify(error)}`,
        });
        expect(result.stderr).not.toContain(API_KEY);
      } finally {
        await server.close();
      }
    },
    20_000,
  );

  it('refuses a sliced replay without --confirm-paid before reading stdin or sending HTTP', async () => {
    const server = await startServer(
      preflightOr((_request, response) => {
        jsonResponse(response, 200, { status: 'started', error: null });
      }),
    );
    try {
      const result = await runCli(
        ['invocation', 'replay', '42', '--before-send', '5', '--global-prompt', '-', '--timeout-ms', '250', '--json'],
        {
          env: { SUROWAN_ENDPOINT: server.baseUrl, SUROWAN_API_KEY: API_KEY },
          stdin: 'override',
          // stdin is never closed: only an early refusal can finish this run
          // before the read timeout would report `timeout` instead.
          keepStdinOpen: true,
        },
      );
      expect(result.code).toBe(2);
      expect(result.stdout).toBe('');
      expect(errorDocument(result)).toEqual({
        error: 'confirm_paid_required',
        message: 'invocation replay --before-send requires --confirm-paid to confirm the billed model call',
      });
      // The billed slice is refused before the preflight, the POST and the
      // prompt override read: the confirmation is not a post-hoc check.
      expect(server.requests).toHaveLength(0);
    } finally {
      await server.close();
    }
  }, 20_000);

  it('caps prompt parts and rejects empty global prompts', async () => {
    const server = await startServer(
      preflightOr((_request, response) => {
        jsonResponse(response, 200, { status: 'started', error: null });
      }),
    );
    try {
      const env = { SUROWAN_ENDPOINT: server.baseUrl, SUROWAN_API_KEY: API_KEY };
      const tooLarge = await runCli(['invocation', 'replay', '5', '--global-prompt', '-', '--json'], {
        env,
        stdin: 'a'.repeat(MAX_PROMPT_CHARS + 1),
      });
      expect(tooLarge.code).toBe(2);
      expect(errorDocument(tooLarge).error).toBe('global_prompt_too_large');

      const empty = await runCli(['invocation', 'replay', '5', '--global-prompt', '-', '--json'], {
        env,
        stdin: '   ',
      });
      expect(empty.code).toBe(2);
      expect(errorDocument(empty).error).toBe('global_prompt_empty');

      const missingFile = await runCli(
        ['invocation', 'replay', '5', '--global-prompt', join(cliWorkDir(), 'absent.txt'), '--json'],
        { env },
      );
      expect(missingFile.code).toBe(2);
      expect(errorDocument(missingFile).error).toBe('global_prompt_read_failed');

      const groupTooLarge = await runCli(['invocation', 'replay', '5', '--group-prompt', '-', '--json'], {
        env,
        stdin: 'a'.repeat(MAX_PROMPT_CHARS + 1),
      });
      expect(groupTooLarge.code).toBe(2);
      expect(errorDocument(groupTooLarge).error).toBe('group_prompt_too_large');

      expect(server.requests).toHaveLength(0);
    } finally {
      await server.close();
    }
  }, 30_000);

  it('refuses a prompt path that is not a regular file before reading it', async () => {
    const server = await startServer(
      preflightOr((_request, response) => {
        jsonResponse(response, 200, { status: 'started', error: null });
      }),
    );
    try {
      const env = { SUROWAN_ENDPOINT: server.baseUrl, SUROWAN_API_KEY: API_KEY };
      // /dev/null is a character device; on Windows the temp directory stands
      // in for the same "stat() succeeds but this is not a regular file" case.
      const notARegularFile = process.platform === 'win32' ? cliWorkDir() : '/dev/null';
      const result = await runCli(['invocation', 'replay', '5', '--global-prompt', notARegularFile, '--json'], {
        env,
      });
      expect(result.code).toBe(2);
      expect(result.stdout).toBe('');
      expect(errorDocument(result)).toEqual({
        error: 'global_prompt_read_failed',
        message: `global prompt file must be a regular file: ${notARegularFile}`,
      });
      expect(server.requests).toHaveLength(0);
    } finally {
      await server.close();
    }
  }, 30_000);
});
