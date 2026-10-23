import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  API_KEY,
  ITEM,
  jsonResponse,
  onlyRequest,
  runCli,
  setupCliWorkDir,
  startServer,
  teardownCliWorkDir,
} from './invocation-cli-fixtures.ts';

beforeAll(async () => {
  await setupCliWorkDir();
});

afterAll(async () => {
  await teardownCliWorkDir();
});

describe('surowan-utils invocation CLI', () => {
  it('list sends filters and auth, and prints one stable JSON document', async () => {
    const server = await startServer((_request, response) => {
      jsonResponse(response, 200, { items: [ITEM], next_cursor: '7' });
    });
    try {
      const result = await runCli(
        ['invocation', 'list', '--limit', '5', '--cursor', '9', '--state', 'completed', '--chat', '-100123', '--json'],
        { env: { SUROWAN_ENDPOINT: server.baseUrl, SUROWAN_API_KEY: API_KEY } },
      );
      expect(result.code).toBe(0);
      expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout)).toEqual({ items: [ITEM], next_cursor: '7' });
      expect(server.requests).toHaveLength(1);
      const request = onlyRequest(server);
      expect(request.method).toBe('GET');
      const url = new URL(request.url, server.baseUrl);
      expect(url.pathname).toBe('/api/invocations');
      expect(Object.fromEntries(url.searchParams)).toEqual({
        limit: '5',
        cursor: '9',
        state: 'completed',
        chat: '-100123',
      });
      expect(request.headers.authorization).toBe(`Bearer ${API_KEY}`);
      expect(request.headers.accept).toContain('application/json');
    } finally {
      await server.close();
    }
  }, 20_000);

  it('list without filters sends no query string and keeps human output concise', async () => {
    const server = await startServer((_request, response) => {
      jsonResponse(response, 200, { items: [ITEM], next_cursor: null });
    });
    try {
      const result = await runCli(['invocation', 'list'], {
        env: { SUROWAN_ENDPOINT: server.baseUrl, SUROWAN_API_KEY: API_KEY },
      });
      expect(result.code).toBe(0);
      expect(result.stderr).toBe('');
      const request = onlyRequest(server);
      expect(request.url).toBe('/api/invocations');
      expect(result.stdout).not.toContain('{');
      expect(result.stdout).toContain('7');
      expect(result.stdout).toContain('completed');
      expect(result.stdout).toContain('Test Group');
      expect(result.stdout).toContain('(-1001234567890)');
    } finally {
      await server.close();
    }
  }, 20_000);

  it('list names a Playground room by its room id and room message sequence', async () => {
    const room = {
      ...ITEM,
      chat: {
        host_kind: 'playground',
        telegram_chat_id: null,
        room_id: '3',
        type: 'group',
        title: 'Room',
        username: null,
        message_thread_id: 0,
      },
      matched_messages: [
        {
          source: 'incoming',
          telegram_message_id: null,
          room_seq: '4',
          telegram_send_id: null,
          at: '2026-10-21T07:44:39.112Z',
          text: 'hi',
        },
      ],
    };
    const server = await startServer((_request, response) => {
      jsonResponse(response, 200, { items: [room], next_cursor: null });
    });
    try {
      const result = await runCli(['invocation', 'list'], {
        env: { SUROWAN_ENDPOINT: server.baseUrl, SUROWAN_API_KEY: API_KEY },
      });
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('Room(room:3)');
      expect(result.stdout).toContain('room_msg=4');
      expect(result.stdout).not.toContain('msg=null');
    } finally {
      await server.close();
    }
  }, 20_000);

  it('--api-key overrides SUROWAN_API_KEY', async () => {
    const server = await startServer((_request, response) => {
      jsonResponse(response, 200, { items: [], next_cursor: null });
    });
    try {
      const result = await runCli(['invocation', 'list', '--json', '--api-key', 'flag-key'], {
        env: { SUROWAN_ENDPOINT: server.baseUrl, SUROWAN_API_KEY: 'env-key' },
      });
      expect(result.code).toBe(0);
      expect(onlyRequest(server).headers.authorization).toBe('Bearer flag-key');
    } finally {
      await server.close();
    }
  }, 20_000);

  it('get returns the invocation detail document unchanged', async () => {
    const detail = { id: '42', state: 'failed', error_code: 'provider_error', turns_used: 3 };
    const server = await startServer((_request, response) => {
      jsonResponse(response, 200, detail);
    });
    try {
      const result = await runCli(['invocation', 'get', '42', '--json'], {
        env: { SUROWAN_ENDPOINT: server.baseUrl, SUROWAN_API_KEY: API_KEY },
      });
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(detail);
      const request = onlyRequest(server);
      expect(request.method).toBe('GET');
      expect(request.url).toBe('/api/invocations/42');
    } finally {
      await server.close();
    }
  }, 20_000);
});
