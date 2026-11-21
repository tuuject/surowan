import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import { describe, expect, test } from 'vitest';
import { type DecisionsRequest, requestDecision } from '../../src/platform/decisions.ts';

/**
 * The Decisions API client against a local fixture and injected `fetch` stubs:
 * never the real service. Each case is one of the plan's failure rows, and the
 * rule the runtime relies on is visible here — a failure is a value, never a
 * throw, and the credential never reaches `detail`.
 */

const KEY = 'sk-or-gate-0123456789abcdef';
const MODEL = 'typesafe/jev-1.14';

const SUCCESS_BODY = {
  id: 'dec_01',
  model: MODEL,
  provider: 'typesafe',
  answers: { gate: { type: 'noul', noul: 0.82, confidence: 0.91 } },
  usage: { input_tokens: 123, output_tokens: 1, cost: 0.000_02, total_tokens: 124 },
};

interface Received {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

/** A real local HTTP fixture: the client's own fetch, socket and abort handling run for real. */
async function startServer(
  handler: (request: IncomingMessage, res: ServerResponse) => void,
): Promise<{ url: string; requests: Received[]; close: () => Promise<void> }> {
  const requests: Received[] = [];
  const server = createServer((request, res) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      requests.push({
        method: request.method ?? '',
        url: request.url ?? '',
        headers: request.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      handler(request, res);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('The fixture server did not bind a port');
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: async () => {
      // A hung handler still owns a socket; closing connections first lets the
      // server actually shut down.
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function responseFor(body: unknown, status = 200): typeof fetch {
  return async () => new Response(JSON.stringify(body), { status });
}

function textResponse(body: string, status = 200): typeof fetch {
  return async () => new Response(body, { status });
}

/** A `fetch` that only settles when its signal aborts, like a server that never answers. */
const hangingFetch: typeof fetch = (_input, init) =>
  new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    if (signal === null || signal === undefined) {
      reject(new Error('The client must pass an abort signal'));
      return;
    }
    signal.addEventListener('abort', () => reject(new DOMException('The operation was aborted', 'AbortError')));
  });

function request(overrides: Partial<DecisionsRequest>): DecisionsRequest {
  return {
    apiKey: KEY,
    baseUrl: 'http://127.0.0.1:1/api/alpha',
    model: MODEL,
    state: { pending: [] },
    instructions: 'Would the bot reply?',
    timeoutMs: 2_000,
    ...overrides,
  };
}

describe('requestDecision wire format', () => {
  test('posts one gate question to {base_url}/decisions and reads the probability and usage', async () => {
    const server = await startServer((_request, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(SUCCESS_BODY));
    });
    try {
      const result = await requestDecision(
        request({
          // A trailing slash must not double up with the appended path.
          baseUrl: `${server.url}/api/alpha/`,
          state: { bot: { name: 'Bowl' }, history: [], pending: [{ from: 'a', text: 'hi' }] },
          instructions: 'Would {{ bot.name }} reply?',
        }),
      );
      expect(result).toMatchObject({ ok: true, probability: 0.82, inputTokens: 123, cost: 0.000_02 });
      if (!result.ok) {
        throw new Error('expected a decision');
      }
      expect(result.durationMs).toBeGreaterThanOrEqual(0);

      const received = server.requests[0];
      expect(server.requests).toHaveLength(1);
      expect(received?.method).toBe('POST');
      expect(received?.url).toBe('/api/alpha/decisions');
      expect(received?.headers.authorization).toBe(`Bearer ${KEY}`);
      expect(received?.headers['content-type']).toBe('application/json');
      expect(JSON.parse(received?.body ?? '')).toEqual({
        model: MODEL,
        state: { bot: { name: 'Bowl' }, history: [], pending: [{ from: 'a', text: 'hi' }] },
        questions: { gate: { type: 'noul', instructions: 'Would {{ bot.name }} reply?' } },
      });
    } finally {
      await server.close();
    }
  });

  test('a usable answer tolerates envelope and usage fields it does not know', async () => {
    const result = await requestDecision(
      request({
        fetchImpl: responseFor({
          ...SUCCESS_BODY,
          answers: {
            gate: { type: 'noul', noul: 1, confidence: 0.4, rationale: 'because' },
            other: { type: 'refusal' },
          },
          usage: { input_tokens: 7, output_tokens: 0, cost: 0, cached_tokens: 3, tier: 'free' },
          future_field: true,
        }),
      }),
    );
    expect(result).toMatchObject({ ok: true, probability: 1, inputTokens: 7, cost: 0 });
  });

  test('a refusal is its own failure code, not an invalid response', async () => {
    const result = await requestDecision(
      request({
        fetchImpl: responseFor({ ...SUCCESS_BODY, answers: { gate: { type: 'refusal' } } }),
      }),
    );
    expect(result).toMatchObject({ ok: false, code: 'refusal' });
  });

  test('the request carries no cost when the service reports none', async () => {
    const result = await requestDecision(
      request({ fetchImpl: responseFor({ ...SUCCESS_BODY, usage: { input_tokens: 5, output_tokens: 1 } }) }),
    );
    expect(result).toMatchObject({ ok: true, probability: 0.82, inputTokens: 5, cost: null });
  });
});

describe('requestDecision failures', () => {
  test.each([401, 402, 429, 500])('HTTP %i is an http_error carrying the status', async (status) => {
    const result = await requestDecision(
      request({
        fetchImpl: responseFor({ error: { code: status, message: `upstream says ${status}` } }, status),
      }),
    );
    expect(result).toMatchObject({ ok: false, code: 'http_error', status });
    if (result.ok) {
      throw new Error('expected a failure');
    }
    expect(result.detail).toContain(`HTTP ${status}`);
    expect(result.detail).toContain(`upstream says ${status}`);
  });

  test('an error body that echoes the credential is redacted from the detail', async () => {
    const result = await requestDecision(
      request({
        fetchImpl: responseFor({ error: { code: 401, message: `invalid key ${KEY}` } }, 401),
      }),
    );
    expect(result).toMatchObject({ ok: false, code: 'http_error', status: 401 });
    if (result.ok) {
      throw new Error('expected a failure');
    }
    expect(result.detail).not.toContain(KEY);
    expect(result.detail).toContain('[redacted]');
  });

  test('a credential with surrounding whitespace is redacted in the form that was sent', async () => {
    // `fetch` strips the whitespace from the header, so the upstream echoes
    // the stripped value, which the resolved value does not match as written.
    const result = await requestDecision(
      request({
        apiKey: ` ${KEY}\t`,
        fetchImpl: responseFor({ error: { code: 401, message: `invalid key ${KEY}` } }, 401),
      }),
    );
    if (result.ok) {
      throw new Error('expected a failure');
    }
    expect(result.detail).not.toContain(KEY);
    expect(result.detail).toContain('[redacted]');
  });

  test('a transport error is a network_error with the credential redacted and the socket cause kept', async () => {
    const result = await requestDecision(
      request({
        fetchImpl: async () => {
          throw new TypeError(`fetch failed while sending authorization for ${KEY}`, {
            cause: new Error('connect ECONNREFUSED 127.0.0.1:1'),
          });
        },
      }),
    );
    expect(result).toMatchObject({ ok: false, code: 'network_error' });
    if (result.ok) {
      throw new Error('expected a failure');
    }
    expect(result.detail).not.toContain(KEY);
    expect(result.detail).toContain('ECONNREFUSED');
  });

  test('a body that is not JSON is an invalid_response', async () => {
    const result = await requestDecision(request({ fetchImpl: textResponse('<html>not json</html>') }));
    expect(result).toMatchObject({ ok: false, code: 'invalid_response' });
  });

  test('a body without answers.gate.noul is an invalid_response', async () => {
    const result = await requestDecision(
      request({
        fetchImpl: responseFor({ answers: { gate: { type: 'noul' } }, usage: { input_tokens: 1, output_tokens: 0 } }),
      }),
    );
    expect(result).toMatchObject({ ok: false, code: 'invalid_response' });
  });

  test('a body without a usage block is an invalid_response', async () => {
    const result = await requestDecision(
      request({ fetchImpl: responseFor({ answers: { gate: { type: 'noul', noul: 0.5 } } }) }),
    );
    expect(result).toMatchObject({ ok: false, code: 'invalid_response' });
  });

  test('a probability outside 0..1 or not finite is an invalid_response', async () => {
    for (const body of [
      '{"answers":{"gate":{"type":"noul","noul":1.4}},"usage":{"input_tokens":1,"output_tokens":0}}',
      '{"answers":{"gate":{"type":"noul","noul":-0.2}},"usage":{"input_tokens":1,"output_tokens":0}}',
      '{"answers":{"gate":{"type":"noul","noul":1e999}},"usage":{"input_tokens":1,"output_tokens":0}}',
      '{"answers":{"gate":{"type":"noul","noul":"0.5"}},"usage":{"input_tokens":1,"output_tokens":0}}',
      '{"answers":{"gate":{"type":"boolean","noul":0.5}},"usage":{"input_tokens":1,"output_tokens":0}}',
    ]) {
      const result = await requestDecision(request({ fetchImpl: textResponse(body) }));
      expect(result, body).toMatchObject({ ok: false, code: 'invalid_response' });
    }
  });

  test('a hung server times out within the budget', async () => {
    const server = await startServer(() => {
      // Never answers: the socket stays open until the client aborts.
    });
    try {
      const timeoutMs = 150;
      const started = Date.now();
      const result = await requestDecision(request({ baseUrl: `${server.url}/api/alpha`, timeoutMs }));
      const elapsed = Date.now() - started;
      expect(result).toMatchObject({ ok: false, code: 'timeout' });
      expect(elapsed).toBeGreaterThanOrEqual(timeoutMs - 20);
      expect(elapsed).toBeLessThan(timeoutMs + 1_500);
    } finally {
      await server.close();
    }
  });

  test('the external shutdown signal is aborted, not a timeout', async () => {
    const controller = new AbortController();
    const started = Date.now();
    const pending = requestDecision(request({ timeoutMs: 5_000, signal: controller.signal, fetchImpl: hangingFetch }));
    setTimeout(() => controller.abort(), 20);
    const result = await pending;
    expect(result).toMatchObject({ ok: false, code: 'aborted' });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test('a redirect is refused instead of followed', async () => {
    const server = await startServer((request, res) => {
      if (request.url?.endsWith('/elsewhere') === true) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(SUCCESS_BODY));
        return;
      }
      res.writeHead(302, { location: '/elsewhere' });
      res.end();
    });
    try {
      const result = await requestDecision(request({ baseUrl: `${server.url}/api/alpha` }));
      expect(result).toMatchObject({ ok: false, code: 'network_error' });
      // Only the first hop reached the fixture: the credential never travelled
      // to the redirect target.
      expect(server.requests.map((entry) => entry.url)).toEqual(['/api/alpha/decisions']);
    } finally {
      await server.close();
    }
  });
});
