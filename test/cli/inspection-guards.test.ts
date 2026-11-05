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
        // One row per distinct rejection branch.
        [['models'], 'missing_subcommand'],
        [['models', 'show'], 'unknown_subcommand'],
        [['models', 'list', 'extra'], 'unexpected_argument'],
        [['models', 'list', '--confirm-paid'], 'unexpected_option'],
        [['invocation', 'replay', '1', '--model', 'target'], 'invalid_model_override'],
        [['invocation', 'replay', '1', '--provider', '', '--model', 'target'], 'invalid_model_override'],
        [['invocation', 'replay', '1', '--provider', 'other', '--model', 'a'.repeat(257)], 'invalid_model_override'],
        [['invocation', 'replay', '1', '--provider', 'other\n', '--model', 'target'], 'invalid_model_override'],
        [['invocation', 'replay', '1', '--thinking-level', 'unknown'], 'invalid_thinking_level'],
        [['invocation', 'list', '--model', ''], 'invalid_model'],
        [['invocation', 'list', '--model', 'gpt\n4.1'], 'invalid_model'],
        [['invocation', 'get', '1', '--thinking-level', 'off'], 'unexpected_option'],
        [['invocation', 'prompts'], 'missing_argument'],
        [['invocation', 'prompts', '1', 'extra'], 'unexpected_argument'],
        [['invocation', 'replay', '1', '--system-prompt', 'x'], 'invalid_arguments'],
        [['invocation', 'media', 'abc'], 'invalid_id'],
        // Panel-only flags would be dropped silently: a `--dry-run` replay must
        // not turn into a real, billed one.
        [['invocation', 'replay', '1', '--dry-run'], 'unexpected_option'],
        [['invocation', 'media', '1', '--output', 'x.bin'], 'unexpected_option'],
        [['config', 'show', '--if-match', 'x'], 'unexpected_option'],
        // Login input elsewhere would be ignored while the request runs with
        // the resolved credential; a request credential on login likewise.
        [['models', 'list', '--username', 'owner'], 'unexpected_option'],
        [['invocation', 'list', '--password', 'secret-password'], 'unexpected_option'],
        [['chat', 'list', '--password-stdin'], 'unexpected_option'],
        [['login', '--session', 'token'], 'unexpected_option'],
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
});
