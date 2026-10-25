import { describe, expect, it } from 'vitest';
import { errorDocument, jsonResponse, onlyRequest, requestPath, requestQuery, runCli, startServer } from './harness.ts';
import { ENV, CONFIG_VIEW, PROMPT_GLOBAL, PROMPT_GROUP, ACTIVE_PROMPTS } from './inspection-fixtures.ts';

describe('surowan-utils inspection commands', () => {
  it('config show defaults to the active source and prints pretty JSON without --json', async () => {
    const server = await startServer((_request, response) => {
      jsonResponse(response, 200, CONFIG_VIEW);
    });
    try {
      const result = await runCli(['config', 'show'], { env: ENV(server.baseUrl) });
      expect(result.code).toBe(0);
      expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout)).toEqual(CONFIG_VIEW);
      expect(result.stdout).toContain('\n  ');
      const request = onlyRequest(server);
      expect(request.method).toBe('GET');
      expect(requestPath(request)).toBe('/api/config/view');
      expect(requestQuery(request)).toEqual({ source: 'active' });
    } finally {
      await server.close();
    }
  }, 20_000);

  it('config show --source file sends the file source and --json keeps one compact document', async () => {
    const server = await startServer((_request, response) => {
      jsonResponse(response, 200, { ...CONFIG_VIEW, source: 'file' });
    });
    try {
      const result = await runCli(['config', 'show', '--source', 'file', '--json'], { env: ENV(server.baseUrl) });
      expect(result.code).toBe(0);
      expect(requestQuery(onlyRequest(server))).toEqual({ source: 'file' });
      expect(result.stdout).toBe(`${JSON.stringify({ ...CONFIG_VIEW, source: 'file' })}\n`);
    } finally {
      await server.close();
    }
  }, 20_000);

  it('config show refuses a response without the redacted config object', async () => {
    const server = await startServer((_request, response) => {
      jsonResponse(response, 200, { source: 'active', generation: 1 });
    });
    try {
      const result = await runCli(['config', 'show', '--json'], { env: ENV(server.baseUrl) });
      expect(result.code).toBe(1);
      expect(result.stdout).toBe('');
      expect(errorDocument(result).error).toBe('invalid_response');
    } finally {
      await server.close();
    }
  }, 20_000);

  it('prompt get global reads the current global prompt', async () => {
    const server = await startServer((_request, response) => {
      jsonResponse(response, 200, PROMPT_GLOBAL);
    });
    try {
      const result = await runCli(['prompt', 'get', 'global'], { env: ENV(server.baseUrl) });
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(PROMPT_GLOBAL);
      const request = onlyRequest(server);
      expect(requestPath(request)).toBe('/api/prompts/global');
      expect(requestQuery(request)).toEqual({ source: 'active' });
    } finally {
      await server.close();
    }
  }, 20_000);

  it('prompt get group sends the chat id and file source', async () => {
    const server = await startServer((_request, response) => {
      jsonResponse(response, 200, PROMPT_GROUP);
    });
    try {
      const result = await runCli(['prompt', 'get', 'group', '--chat', '-100123', '--source', 'file', '--json'], {
        env: ENV(server.baseUrl),
      });
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(PROMPT_GROUP);
      expect(requestQuery(onlyRequest(server))).toEqual({ source: 'file', chat: '-100123' });
    } finally {
      await server.close();
    }
  }, 20_000);

  it('prompt get refuses a response for another scope', async () => {
    const server = await startServer((_request, response) => {
      jsonResponse(response, 200, { ...PROMPT_GLOBAL, scope: 'group' });
    });
    try {
      const result = await runCli(['prompt', 'get', 'global', '--json'], { env: ENV(server.baseUrl) });
      expect(result.code).toBe(1);
      expect(errorDocument(result).error).toBe('invalid_response');
    } finally {
      await server.close();
    }
  }, 20_000);

  it('invocation prompts returns the active prompt template for that conversation', async () => {
    const server = await startServer((_request, response) => {
      jsonResponse(response, 200, ACTIVE_PROMPTS);
    });
    try {
      const result = await runCli(['invocation', 'prompts', '42', '--json'], { env: ENV(server.baseUrl) });
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(ACTIVE_PROMPTS);
      const request = onlyRequest(server);
      expect(request.method).toBe('GET');
      expect(requestPath(request)).toBe('/api/invocations/42/prompts');
    } finally {
      await server.close();
    }
  }, 20_000);

  it('invocation prompts refuses a historical recorded template', async () => {
    const server = await startServer((_request, response) => {
      jsonResponse(response, 200, { ...ACTIVE_PROMPTS, source: 'recorded' });
    });
    try {
      const result = await runCli(['invocation', 'prompts', '42', '--json'], { env: ENV(server.baseUrl) });
      expect(result.code).toBe(1);
      expect(errorDocument(result).error).toBe('invalid_response');
    } finally {
      await server.close();
    }
  }, 20_000);
});
