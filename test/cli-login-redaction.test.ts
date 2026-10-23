import { describe, expect, it } from 'vitest';
import { credentialsPath, writeCredentials } from '../packages/cli/src/credentials.ts';
import { cli, home, json, server } from './cli-login-fixtures.ts';

describe('surowan-utils login and doctor', () => {
  it.each(['{', '42', '"', '\\', 'synthetic-quote-"-key', 'synthetic-backslash-key-\\'])(
    'keeps JSON valid while redacting saved keys, including structural characters (%j)',
    async (apiKey) => {
      const homeDir = await home();
      const http = await server((response, request) => {
        if ((request.url ?? '').endsWith('/replay-preflight')) {
          json(response, 200, {
            available: true,
            reason: null,
            message: null,
            prompt_overrides_available: true,
            omitted_images: 0,
            fidelity: {
              input: 'historical_public_chat',
              model_selection: 'current_chat_config',
              prompt_selection: 'current_chat_config',
              tool_selection: 'current_registry',
              hot_injections: 'not_replayed',
              external_tools: 'blocked',
              system_resources: 'current_read_only',
              side_effects: 'synthetic',
            },
          });
          return;
        }
        json(response, 200, { id: '7', error: null, items: [{ id: 42, echo: `key ${apiKey}` }], next_cursor: null });
      });
      await writeCredentials(credentialsPath(homeDir), { endpoint: http.endpoint, apiKey });
      for (const args of [
        ['invocation', 'list', '--json'],
        ['invocation', 'get', '7', '--json'],
        ['invocation', 'get', '7'],
        ['invocation', 'replay', '7', '--json'],
        ['invocation', 'replay', '7'],
      ]) {
        const result = await cli(args, homeDir);
        expect(result.code, args.join(' ')).toBe(0);
        expect(result.stderr).toBe('');
        expect(JSON.parse(result.stdout)).toEqual({
          id: '7',
          error: null,
          items: [{ id: 42, echo: 'key [redacted]' }],
          next_cursor: null,
        });
      }
      const doctor = await cli(['doctor', '--json'], homeDir);
      expect(doctor.code).toBe(0);
      expect(JSON.parse(doctor.stdout).status).toBe('ok');
      // Two replays now run a preflight GET before the POST.
      expect(http.requests).toHaveLength(8);
    },
  );
});
