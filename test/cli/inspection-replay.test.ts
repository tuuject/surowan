import { describe, expect, it } from 'vitest';
import { errorDocument, jsonResponse, onlyRequest, requestPath, requestQuery, runCli, startServer } from './harness.ts';
import { ENV, PREFLIGHT } from './inspection-fixtures.ts';

describe('surowan-utils inspection commands', () => {
  it('invocation replay slices before a send even when prompt overrides are unavailable', async () => {
    const server = await startServer((request, response) => {
      if (requestPath(request).endsWith('/replay-preflight')) {
        jsonResponse(response, 200, { ...PREFLIGHT, prompt_overrides_available: false });
        return;
      }
      jsonResponse(response, 200, { status: 'started', invocation_id: '43', error: null });
    });
    try {
      const result = await runCli(['invocation', 'replay', '42', '--before-send', '0042', '--confirm-paid', '--json'], {
        env: ENV(server.baseUrl),
      });
      expect(result.code).toBe(0);
      expect(result.stderr).toBe('');
      expect(server.requests).toHaveLength(2);
      // The slice selection is a boundary, not a prompt override: it is sent as
      // the preflight query and the canonical POST body field.
      expect(requestQuery(onlyRequest(server, 0))).toEqual({ before_send_id: '42' });
      expect(requestPath(onlyRequest(server, 1))).toBe('/api/invocations/42/replay');
      expect(JSON.parse(onlyRequest(server, 1).body)).toEqual({ before_send_id: '42' });
    } finally {
      await server.close();
    }
  }, 20_000);

  it('invocation replay does not post when the slice preflight refuses', async () => {
    const server = await startServer((_request, response) => {
      jsonResponse(response, 200, {
        ...PREFLIGHT,
        available: false,
        reason: 'replay_slice_target_invalid',
        message: 'before_send_id does not identify a successful send of this invocation',
      });
    });
    try {
      const result = await runCli(['invocation', 'replay', '42', '--before-send', '123', '--confirm-paid', '--json'], {
        env: ENV(server.baseUrl),
      });
      expect(result.code).toBe(1);
      expect(result.stdout).toBe('');
      expect(server.requests).toHaveLength(1);
      expect(requestQuery(onlyRequest(server))).toEqual({ before_send_id: '123' });
      expect(errorDocument(result)).toEqual({
        error: 'replay_slice_target_invalid',
        message: 'before_send_id does not identify a successful send of this invocation',
      });
    } finally {
      await server.close();
    }
  }, 20_000);

  it('rejects a prompt override when preflight does not authorize it, without posting', async () => {
    const server = await startServer((_request, response) => {
      jsonResponse(response, 200, { ...PREFLIGHT, prompt_overrides_available: false });
    });
    try {
      const result = await runCli(['invocation', 'replay', '42', '--global-prompt', '-', '--json'], {
        env: ENV(server.baseUrl),
        stdin: 'override',
      });
      expect(result.code).toBe(1);
      expect(errorDocument(result).error).toBe('replay_prompt_parts_unavailable');
      expect(server.requests).toHaveLength(1);
    } finally {
      await server.close();
    }
  }, 20_000);
});
