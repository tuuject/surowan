import { describe, expect, it } from 'vitest';
import {
  errorDocument,
  jsonResponse,
  onlyRequest,
  requestPath,
  requestQuery,
  runCli,
  startServer,
} from './cli-harness.ts';
import { API_KEY, ENV, PREFLIGHT, MODELS } from './cli-inspection-fixtures.ts';

describe('surowan-utils inspection commands', () => {
  it.each([[[]], [['--json']]])(
    'lists active text models without probing providers (%j)',
    async (flags) => {
      const server = await startServer((_request, response) => jsonResponse(response, 200, MODELS));
      try {
        const result = await runCli(['models', 'list', ...flags], { env: ENV(server.baseUrl) });
        expect(result.code, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual(MODELS);
        expect(server.requests).toHaveLength(1);
        const request = onlyRequest(server);
        expect(request.method).toBe('GET');
        expect(requestPath(request)).toBe('/api/models');
        expect(requestQuery(request)).toEqual({});
        expect(request.headers.authorization).toBe(`Bearer ${API_KEY}`);
        expect(result.stdout.includes('\n  ')).toBe(flags.length === 0);
      } finally {
        await server.close();
      }
    },
    20_000,
  );

  it.each([
    { ...MODELS, source: 'file' },
    { ...MODELS, generation: '12' },
    { ...MODELS, models: [null] },
    { ...MODELS, models: [{ ...MODELS.models[0], provider: '' }] },
    { ...MODELS, models: [{ ...MODELS.models[0], input: ['image'] }] },
    { ...MODELS, models: [{ ...MODELS.models[0], thinking_levels: ['unknown'] }] },
  ])(
    'refuses malformed model catalogs (%j)',
    async (raw) => {
      const server = await startServer((_request, response) => jsonResponse(response, 200, raw));
      try {
        const result = await runCli(['models', 'list', '--json'], { env: ENV(server.baseUrl) });
        expect(result.code).toBe(1);
        expect(result.stdout).toBe('');
        expect(errorDocument(result).error).toBe('invalid_response');
      } finally {
        await server.close();
      }
    },
    20_000,
  );

  it('keeps empty catalogs valid and redacts echoed keys in model metadata', async () => {
    for (const models of [[], [{ ...MODELS.models[0], name: `echo ${API_KEY}` }]]) {
      const server = await startServer((_request, response) => jsonResponse(response, 200, { ...MODELS, models }));
      try {
        const result = await runCli(['models', 'list', '--json'], { env: ENV(server.baseUrl) });
        expect(result.code, result.stderr).toBe(0);
        expect(result.stdout).not.toContain(API_KEY);
        expect(JSON.parse(result.stdout).models).toHaveLength(models.length);
      } finally {
        await server.close();
      }
    }
  }, 20_000);

  it('uses the same temporary model and thinking selection for preflight and replay alongside a slice and prompt', async () => {
    const selected = { provider: 'other', model: 'vendor/text-model', thinking_level: 'off', before_send_id: '78' };
    const resultDocument = {
      model: { provider: 'other', id: 'vendor/text-model', thinking_level: 'off' },
      error: null,
    };
    const server = await startServer((request, response) => {
      jsonResponse(response, 200, requestPath(request).endsWith('/replay-preflight') ? PREFLIGHT : resultDocument);
    });
    try {
      const selection = [
        '--provider',
        'other',
        '--model',
        'vendor/text-model',
        '--thinking-level',
        'off',
        '--before-send',
        '78',
      ];
      const preflight = await runCli(['invocation', 'preflight', '42', ...selection, '--json'], {
        env: ENV(server.baseUrl),
      });
      expect(preflight.code, preflight.stderr).toBe(0);
      expect(server.requests).toHaveLength(1);
      expect(requestQuery(onlyRequest(server))).toEqual(selected);
      const replay = await runCli(
        ['invocation', 'replay', '42', ...selection, '--confirm-paid', '--global-prompt', '-', '--json'],
        {
          env: ENV(server.baseUrl),
          stdin: 'temporary global',
        },
      );
      expect(replay.code, replay.stderr).toBe(0);
      expect(JSON.parse(replay.stdout)).toEqual(resultDocument);
      expect(server.requests).toHaveLength(3);
      expect(requestQuery(onlyRequest(server, 1))).toEqual(selected);
      expect(onlyRequest(server, 2).method).toBe('POST');
      expect(JSON.parse(onlyRequest(server, 2).body)).toEqual({ ...selected, global_prompt: 'temporary global' });
    } finally {
      await server.close();
    }
  }, 20_000);

  it.each([
    [['--provider', 'other', '--model', 'vendor/text-model'], { provider: 'other', model: 'vendor/text-model' }],
    [['--thinking-level', 'high'], { thinking_level: 'high' }],
  ])(
    'does not confuse model selection with prompt overrides (%j)',
    async (selection, expected) => {
      const server = await startServer((request, response) => {
        jsonResponse(
          response,
          200,
          requestPath(request).endsWith('/replay-preflight')
            ? { ...PREFLIGHT, prompt_overrides_available: false }
            : { error: null },
        );
      });
      try {
        const result = await runCli(['invocation', 'replay', '42', ...selection, '--json'], {
          env: ENV(server.baseUrl),
        });
        expect(result.code, result.stderr).toBe(0);
        expect(server.requests).toHaveLength(2);
        expect(requestQuery(onlyRequest(server, 0))).toEqual(expected);
        expect(JSON.parse(onlyRequest(server, 1).body)).toEqual(expected);
      } finally {
        await server.close();
      }
    },
    20_000,
  );

  it('does not POST or retry when the selected model fails preflight', async () => {
    const server = await startServer((_request, response) =>
      jsonResponse(response, 200, {
        ...PREFLIGHT,
        available: false,
        reason: 'replay_model_unavailable',
        message: 'Target model is unavailable',
      }),
    );
    try {
      const result = await runCli(
        ['invocation', 'replay', '42', '--provider', 'other', '--model', 'missing', '--json'],
        {
          env: ENV(server.baseUrl),
        },
      );
      expect(result.code).toBe(1);
      expect(errorDocument(result).error).toBe('replay_model_unavailable');
      expect(server.requests).toHaveLength(1);
      expect(requestQuery(onlyRequest(server))).toEqual({ provider: 'other', model: 'missing' });
    } finally {
      await server.close();
    }
  }, 20_000);
});
