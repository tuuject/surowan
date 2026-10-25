import { describe, expect, it } from 'vitest';
import { errorDocument, jsonResponse, requestPath, runCli, startServer } from './harness.ts';
import { API_KEY, ENV, CONFIG_VIEW, PROMPT_GLOBAL, ACTIVE_PROMPTS, PREFLIGHT } from './inspection-fixtures.ts';

describe('surowan-utils inspection commands', () => {
  it('redacts the API key echoed by the new endpoints', async () => {
    const echo = `secret ${API_KEY}`;
    const server = await startServer((request, response) => {
      const path = requestPath(request);
      if (path === '/api/config/view') {
        jsonResponse(response, 200, { ...CONFIG_VIEW, config: { note: echo } });
        return;
      }
      if (path.startsWith('/api/prompts/')) {
        jsonResponse(response, 200, { ...PROMPT_GLOBAL, prompt: echo });
        return;
      }
      if (path.endsWith('/prompts')) {
        jsonResponse(response, 200, { ...ACTIVE_PROMPTS, group_prompt: echo });
        return;
      }
      jsonResponse(response, 200, { ...PREFLIGHT, message: echo });
    });
    try {
      const env = ENV(server.baseUrl);
      const runs: readonly (readonly string[])[] = [
        ['config', 'show', '--json'],
        ['prompt', 'get', 'global', '--json'],
        ['invocation', 'prompts', '42', '--json'],
        ['invocation', 'preflight', '42', '--json'],
      ];
      for (const args of runs) {
        const result = await runCli(args, { env });
        expect(result.code, args.join(' ')).toBe(0);
        expect(result.stdout, args.join(' ')).not.toContain(API_KEY);
        expect(result.stdout, args.join(' ')).toContain('[redacted]');
        // Redaction must not corrupt the JSON document.
        expect(() => JSON.parse(result.stdout), args.join(' ')).not.toThrow();
      }
    } finally {
      await server.close();
    }
  }, 30_000);

  it('rejects unknown or misplaced subcommands and flags before any request', async () => {
    const server = await startServer((_request, response) => {
      jsonResponse(response, 200, {});
    });
    try {
      const env = ENV(server.baseUrl);
      const cases: readonly (readonly [readonly string[], string])[] = [
        [['models'], 'missing_subcommand'],
        [['models', 'show'], 'unknown_subcommand'],
        [['models', 'list', 'extra'], 'unexpected_argument'],
        [['models', 'list', '--source', 'file'], 'unexpected_option'],
        [['models', 'list', '--confirm-paid'], 'unexpected_option'],
        [['models', 'list', '--model', 'target'], 'unexpected_option'],
        [['invocation', 'replay', '1', '--model', 'target'], 'invalid_model_override'],
        [['invocation', 'preflight', '1', '--provider', 'other'], 'invalid_model_override'],
        [['invocation', 'replay', '1', '--provider', '', '--model', 'target'], 'invalid_model_override'],
        [['invocation', 'preflight', '1', '--provider', 'other', '--model', '  '], 'invalid_model_override'],
        [['invocation', 'replay', '1', '--provider', 'other', '--model', 'a'.repeat(257)], 'invalid_model_override'],
        [['invocation', 'replay', '1', '--provider', 'other\n', '--model', 'target'], 'invalid_model_override'],
        [['invocation', 'replay', '1', '--thinking-level', 'unknown'], 'invalid_thinking_level'],
        [['invocation', 'preflight', '1', '--thinking-level', ''], 'invalid_thinking_level'],
        [['invocation', 'list', '--provider', 'other', '--model', 'target'], 'unexpected_option'],
        [['invocation', 'get', '1', '--thinking-level', 'off'], 'unexpected_option'],
        [['invocation', 'prompts', '1', '--thinking-level', 'off'], 'unexpected_option'],
        [['invocation', 'media', '1', '--thinking-level', 'off'], 'unexpected_option'],
        [['config', 'show', '--thinking-level', 'off'], 'unexpected_option'],
        [['prompt', 'get', 'global', '--thinking-level', 'off'], 'unexpected_option'],
        [['login', '--thinking-level', 'off'], 'unexpected_option'],
        [['doctor', '--thinking-level', 'off'], 'unexpected_option'],
        [['config'], 'missing_subcommand'],
        [['config', 'get'], 'unknown_subcommand'],
        [['config', 'show', 'extra'], 'unexpected_argument'],
        [['config', 'show', '--chat', '-1'], 'unexpected_option'],
        [['prompt'], 'missing_subcommand'],
        [['prompt', 'set'], 'unknown_subcommand'],
        [['prompt', 'get'], 'unknown_subcommand'],
        [['prompt', 'get', 'global', '--limit', '1'], 'unexpected_option'],
        [['invocation', 'prompts'], 'missing_argument'],
        [['invocation', 'prompts', '1', 'extra'], 'unexpected_argument'],
        [['invocation', 'prompts', '1', '--before-send', '5'], 'unexpected_option'],
        [['invocation', 'prompts', '1', '--confirm-paid'], 'unexpected_option'],
        [['invocation', 'preflight', '1', '--cursor', '2'], 'unexpected_option'],
        [['invocation', 'preflight', '1', '--search', 'x'], 'unexpected_option'],
        [['invocation', 'preflight', '1', '--from', '2026-10-06T12:00'], 'unexpected_option'],
        [['invocation', 'preflight', '1', '--before-send', '5', '--confirm-paid'], 'unexpected_option'],
        [['invocation', 'list', '--before-send', '5'], 'unexpected_option'],
        [['invocation', 'list', '--confirm-paid'], 'unexpected_option'],
        [['invocation', 'get', '1', '--confirm-paid'], 'unexpected_option'],
        [['invocation', 'media', '1', '--confirm-paid'], 'unexpected_option'],
        [['config', 'show', '--confirm-paid'], 'unexpected_option'],
        [['prompt', 'get', 'global', '--confirm-paid'], 'unexpected_option'],
        [['login', '--confirm-paid'], 'unexpected_option'],
        [['doctor', '--confirm-paid'], 'unexpected_option'],
        [['invocation', 'get', '1', '--search', 'x'], 'unexpected_option'],
        [['invocation', 'media', '1', '--limit', '1'], 'unexpected_option'],
        [['invocation', 'media', '1', '--at', '2026-10-06T12:00'], 'unexpected_option'],
        [['invocation', 'media', 'abc'], 'invalid_id'],
        [['invocation', 'replay', '1', '--search', 'x'], 'unexpected_option'],
        [['invocation', 'replay', '1', '--at', '2026-10-06T12:00'], 'unexpected_option'],
        [['invocation', 'replay', '1', '--system-prompt', 'x'], 'invalid_arguments'],
        [['invocation', 'replay', '1', '--variant', 'original'], 'unexpected_option'],
        [['config', 'show', '--search', 'x'], 'unexpected_option'],
        [['prompt', 'get', 'global', '--to', '2026-10-06T12:00'], 'unexpected_option'],
        [['prompt', 'get', 'global', '--before-send', '1'], 'unexpected_option'],
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

  it('prints the new commands in --help', async () => {
    const result = await runCli(['--help']);
    expect(result.code).toBe(0);
    for (const fragment of [
      'surowan-utils models list',
      '--provider',
      '--model',
      '--thinking-level',
      'surowan-utils config show',
      'surowan-utils prompt get group',
      'surowan-utils invocation prompts',
      'surowan-utils invocation preflight',
      'surowan-utils invocation media',
      '--global-prompt',
      '--group-prompt',
      '--search',
      '--before-send',
      '--confirm-paid',
    ]) {
      expect(result.stdout).toContain(fragment);
    }
    expect(result.stdout).not.toContain('--system-prompt');
  }, 20_000);
});
