import { describe, expect, it } from 'vitest';
import { MAX_MODEL_LENGTH, MAX_SEARCH_LENGTH } from '../../packages/cli/src/args/spec.ts';
import { jsonResponse, onlyRequest, requestPath, requestQuery, runCli, startServer } from './harness.ts';
import { ENV, PREFLIGHT, LIST_ITEM } from './inspection-fixtures.ts';

describe('surowan-utils inspection commands', () => {
  it('invocation preflight forwards --before-send as before_send_id without posting', async () => {
    const server = await startServer((_request, response) => {
      jsonResponse(response, 200, PREFLIGHT);
    });
    try {
      const result = await runCli(['invocation', 'preflight', '42', '--before-send', '123', '--json'], {
        env: ENV(server.baseUrl),
      });
      expect(result.code).toBe(0);
      expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout)).toEqual(PREFLIGHT);
      expect(server.requests).toHaveLength(1);
      expect(onlyRequest(server).method).toBe('GET');
      expect(requestPath(onlyRequest(server))).toBe('/api/invocations/42/replay-preflight');
      expect(requestQuery(onlyRequest(server))).toEqual({ before_send_id: '123' });
    } finally {
      await server.close();
    }
  }, 20_000);

  it('invocation list forwards search and time filters verbatim and passes matched_messages through', async () => {
    const server = await startServer((_request, response) => {
      jsonResponse(response, 200, { items: [LIST_ITEM], total: 0, limit: 25, offset: 0, as_of: '0', new_count: 0 });
    });
    try {
      const env = ENV(server.baseUrl);
      const filtered = await runCli(
        [
          'invocation',
          'list',
          '--search',
          '100%_literal',
          '--from',
          '2026-10-06 11:00',
          '--to',
          '2026-10-06T12:00:30.5+08:00',
          '--json',
        ],
        { env },
      );
      expect(filtered.code).toBe(0);
      expect(filtered.stderr).toBe('');
      expect(requestQuery(onlyRequest(server, 0))).toEqual({
        search: '100%_literal',
        from: '2026-10-06 11:00',
        to: '2026-10-06T12:00:30.5+08:00',
      });
      // The JSON document is exactly what the server returned: matched_messages included.
      expect(JSON.parse(filtered.stdout)).toEqual({
        items: [LIST_ITEM],
        total: 0,
        limit: 25,
        offset: 0,
        as_of: '0',
        new_count: 0,
      });

      const at = await runCli(['invocation', 'list', '--at', '2024-02-29T12:00:30', '--json'], { env });
      expect(at.code).toBe(0);
      expect(requestQuery(onlyRequest(server, 1))).toEqual({ at: '2024-02-29T12:00:30' });

      const ascending = await runCli(
        ['invocation', 'list', '--from', '2026-10-06T00:00:00Z', '--to', '2026-10-06T09:00:00+08:00', '--json'],
        { env },
      );
      expect(ascending.code).toBe(0);
      expect(requestQuery(onlyRequest(server, 2))).toEqual({
        from: '2026-10-06T00:00:00Z',
        to: '2026-10-06T09:00:00+08:00',
      });

      // A keyword of exactly the maximum length is accepted; the rejected
      // overlong case is covered by the argument-validation suite.
      const longest = 'a'.repeat(MAX_SEARCH_LENGTH);
      const boundary = await runCli(['invocation', 'list', '--search', longest, '--json'], { env });
      expect(boundary.code).toBe(0);
      expect(requestQuery(onlyRequest(server, 3))).toEqual({ search: longest });
    } finally {
      await server.close();
    }
  }, 30_000);

  it('invocation list forwards the model filter verbatim alongside the other filters', async () => {
    const server = await startServer((_request, response) => {
      jsonResponse(response, 200, { items: [], total: 0, limit: 25, offset: 0, as_of: '0', new_count: 0 });
    });
    try {
      const env = ENV(server.baseUrl);
      const result = await runCli(
        ['invocation', 'list', '--model', 'deepseek/deepseek-v4-flash', '--state', 'completed', '--json'],
        { env },
      );
      expect(result.code, result.stderr).toBe(0);
      expect(requestQuery(onlyRequest(server))).toEqual({ model: 'deepseek/deepseek-v4-flash', state: 'completed' });

      const exactLength = await runCli(['invocation', 'list', '--model', 'm'.repeat(MAX_MODEL_LENGTH), '--json'], {
        env,
      });
      expect(exactLength.code, exactLength.stderr).toBe(0);
      expect(requestQuery(onlyRequest(server, 1))).toEqual({ model: 'm'.repeat(MAX_MODEL_LENGTH) });
    } finally {
      await server.close();
    }
  }, 20_000);

  it('invocation list leaves timezone-less ranges to the server instead of guessing an order', async () => {
    const server = await startServer((_request, response) => {
      jsonResponse(response, 200, { items: [], total: 0, limit: 25, offset: 0, as_of: '0', new_count: 0 });
    });
    try {
      const result = await runCli(
        ['invocation', 'list', '--from', '2026-10-07 00:00:00', '--to', '2026-10-06 00:00:00.9', '--json'],
        { env: ENV(server.baseUrl) },
      );
      expect(result.code).toBe(0);
      expect(requestQuery(onlyRequest(server))).toEqual({
        from: '2026-10-07 00:00:00',
        to: '2026-10-06 00:00:00.9',
      });
    } finally {
      await server.close();
    }
  }, 20_000);

  it('invocation list human output appends matched summaries without replacing the invocation time', async () => {
    const server = await startServer((_request, response) => {
      jsonResponse(response, 200, { items: [LIST_ITEM], total: 0, limit: 25, offset: 0, as_of: '0', new_count: 0 });
    });
    try {
      const result = await runCli(['invocation', 'list', '--search', 'keyword'], { env: ENV(server.baseUrl) });
      expect(result.code).toBe(0);
      expect(result.stderr).toBe('');
      const firstLine = result.stdout.split('\n')[0] ?? '';
      // The invocation's own time stays the leading timestamp; a matched message
      // time must never be presented as the invocation creation time.
      expect(firstLine).toContain(LIST_ITEM.created_at);
      expect(firstLine).not.toContain('2026-10-06T11:58:00Z');
      expect(result.stdout).toContain('matched incoming');
      expect(result.stdout).toContain('msg=55');
      expect(result.stdout).toContain('hello keyword');
      expect(result.stdout).toContain('matched bot');
      expect(result.stdout).toContain('send=77');
      expect(result.stdout).toContain('matched reply');
    } finally {
      await server.close();
    }
  }, 20_000);
});
