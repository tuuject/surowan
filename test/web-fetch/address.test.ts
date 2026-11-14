import { afterAll, expect, test } from 'vitest';
import { BUILTIN_PLUGINS } from '../../src/plugins/builtin.ts';
import { loadPlugins } from '../../src/plugins/plugin.ts';
import { createWebFetchTool } from '../../src/plugins/web-fetch/web-fetch.ts';
import { createToolAudit } from '../../src/store/tool-audit.ts';
import { cleanupWebFetchDirectories, fixture } from './fixtures.ts';

afterAll(cleanupWebFetchDirectories);

test('proxy synthetic DNS answers are refused unless the deployment opts in', async () => {
  const { store, context } = await fixture();
  try {
    let requests = 0;
    const tool = createWebFetchTool({
      audit: createToolAudit(store, context.invocationId),
      invocationDeadline: Date.now() + 30_000,
      resolveHostname: async () => [{ address: '198.18.0.42', family: 4 }],
      requestResolved: async () => {
        requests += 1;
        return new Response('ok', { headers: { 'content-type': 'text/plain' } });
      },
    });
    await expect(tool.execute('web-default', { url: 'https://attacker.example/' })).rejects.toThrow(
      'non-public address',
    );
    expect(requests).toBe(0);
  } finally {
    store.close();
  }
});

test('web_fetch returns bounded untrusted text through proxy synthetic DNS and audits it', async () => {
  const { store, context } = await fixture();
  try {
    const tool = createWebFetchTool({
      audit: createToolAudit(store, context.invocationId),
      invocationDeadline: Date.now() + 30_000,
      allowProxySyntheticAddresses: true,
      resolveHostname: async (hostname) => {
        expect(hostname).toBe('public.example');
        return [{ address: '198.18.0.42', family: 4 }];
      },
      requestResolved: async (url, address) => {
        expect(url.href).toBe('https://public.example/article?q=1');
        expect(address).toBe('198.18.0.42');
        return new Response('你'.repeat(20_000), {
          status: 200,
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        });
      },
    });
    const result = await tool.execute('web-1', { url: 'https://public.example/article?q=1' });
    const text = result.content[0]?.type === 'text' ? result.content[0].text : '';
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(32_768);
    expect(text.startsWith('Untrusted web content follows.')).toBe(true);
    expect(text.endsWith('[content truncated]')).toBe(true);
    expect(result.details).toEqual({
      url: 'https://public.example/article?q=1',
      status: 200,
      format: 'raw',
      truncated: true,
    });
    expect(
      store.db
        .prepare<[], { state: string; side_effect: bigint; result_text: string }>(
          "SELECT state, side_effect, result_text FROM tool_calls WHERE tool_call_id = 'web-1'",
        )
        .get(),
    ).toEqual({ state: 'success', side_effect: 0n, result_text: text });
  } finally {
    store.close();
  }
});

test('web_fetch config flags reach the built-in plugin tool', async () => {
  const { store, config, context } = await fixture((file) => {
    file.web_fetch = { dangerously_allow_all_ip_addresses: true };
  });
  try {
    const plugins = loadPlugins(BUILTIN_PLUGINS);
    const tool = plugins
      .capabilities(store, config, context, Date.now() + 30_000)
      .find((entry) => entry.tool.name === 'web_fetch')?.tool;
    expect(tool?.description).toContain('This deployment also allows private and local addresses.');
  } finally {
    store.close();
  }
});

test('dangerously_allow_all_ip_addresses skips address checks but keeps URL rules', async () => {
  const { store, context } = await fixture();
  try {
    const addresses: string[] = [];
    const tool = createWebFetchTool({
      audit: createToolAudit(store, context.invocationId),
      invocationDeadline: Date.now() + 30_000,
      allowAllAddresses: true,
      resolveHostname: async () => [{ address: '10.0.0.8', family: 4 }],
      requestResolved: async (url, address) => {
        addresses.push(address);
        if (url.pathname === '/start') {
          return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/admin' } });
        }
        return new Response('ok', { headers: { 'content-type': 'text/plain' } });
      },
    });
    expect(tool.description).toContain('This deployment also allows private and local addresses.');
    expect(tool.description).not.toContain('use it for private/local resources');
    await tool.execute('web-lan', { url: 'http://nas.lan/status' });
    await tool.execute('web-loopback', { url: 'http://[::1]/' });
    await tool.execute('web-redirect-local', { url: 'https://public.example/start' });
    expect(addresses).toEqual(['10.0.0.8', '::1', '10.0.0.8', '127.0.0.1']);
    await expect(tool.execute('web-port', { url: 'http://127.0.0.1:8080/' })).rejects.toThrow('default ports');
    expect(
      store.db
        .prepare<[], { tool_call_id: string; state: string }>('SELECT tool_call_id, state FROM tool_calls ORDER BY id')
        .all(),
    ).toEqual([
      { tool_call_id: 'web-lan', state: 'success' },
      { tool_call_id: 'web-loopback', state: 'success' },
      { tool_call_id: 'web-redirect-local', state: 'success' },
      { tool_call_id: 'web-port', state: 'error' },
    ]);
  } finally {
    store.close();
  }
});

test('web_fetch allows public IPv4 answers and still blocks IPv4-mapped IPv6 literals', async () => {
  const { store, context } = await fixture();
  try {
    let requests = 0;
    const tool = createWebFetchTool({
      audit: createToolAudit(store, context.invocationId),
      invocationDeadline: Date.now() + 30_000,
      resolveHostname: async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '2606:2800:220:1::1', family: 6 },
      ],
      requestResolved: async (_url, address) => {
        requests += 1;
        expect(address).toBe('93.184.216.34');
        return new Response('ok', { headers: { 'content-type': 'text/plain' } });
      },
    });
    await tool.execute('web-public-v4', { url: 'https://public.example/' });
    await expect(tool.execute('web-mapped', { url: 'http://[::ffff:7f00:1]/' })).rejects.toThrow('non-public address');
    expect(requests).toBe(1);
  } finally {
    store.close();
  }
});

test('web_fetch blocks IPv6 transition addresses that embed an IPv4 destination', async () => {
  const { store, context } = await fixture();
  try {
    let requests = 0;
    const resolved: Record<string, string> = {
      'six-to-four.example': '2002:7f00:1::1',
      'teredo.example': '2001:0:4136:e378:8000:63bf:3fff:fdd2',
    };
    const tool = createWebFetchTool({
      audit: createToolAudit(store, context.invocationId),
      invocationDeadline: Date.now() + 30_000,
      resolveHostname: async (hostname) => [{ address: resolved[hostname] ?? '2606:4700::1', family: 6 }],
      requestResolved: async () => {
        requests += 1;
        return new Response('ok', { headers: { 'content-type': 'text/plain' } });
      },
    });
    await expect(tool.execute('web-6to4', { url: 'https://six-to-four.example/' })).rejects.toThrow(
      'non-public address',
    );
    await expect(tool.execute('web-teredo', { url: 'https://teredo.example/' })).rejects.toThrow('non-public address');
    await expect(tool.execute('web-literal-6to4', { url: 'http://[2002:a00:1::1]/' })).rejects.toThrow(
      'non-public address',
    );
    // An ordinary global unicast address still passes.
    await tool.execute('web-public-v6', { url: 'https://public.example/' });
    expect(requests).toBe(1);
  } finally {
    store.close();
  }
});

test('web_fetch blocks private and literal synthetic addresses, including redirects', async () => {
  const { store, context } = await fixture();
  try {
    let requests = 0;
    const tool = createWebFetchTool({
      audit: createToolAudit(store, context.invocationId),
      invocationDeadline: Date.now() + 30_000,
      // Even with the opt-in, a literal synthetic IP and a private redirect stay blocked.
      allowProxySyntheticAddresses: true,
      resolveHostname: async () => [{ address: '198.18.0.42', family: 4 }],
      requestResolved: async () => {
        requests += 1;
        return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/admin' } });
      },
    });
    await expect(tool.execute('web-private', { url: 'http://127.0.0.1/secret' })).rejects.toThrow('non-public address');
    await expect(tool.execute('web-synthetic', { url: 'http://198.18.0.42/secret' })).rejects.toThrow(
      'non-public address',
    );
    await expect(tool.execute('web-redirect', { url: 'https://public.example/start' })).rejects.toThrow(
      'non-public address',
    );
    expect(requests).toBe(1);
    expect(
      store.db
        .prepare<[], { tool_call_id: string; state: string; error_code: string }>(
          'SELECT tool_call_id, state, error_code FROM tool_calls ORDER BY id',
        )
        .all(),
    ).toEqual([
      { tool_call_id: 'web-private', state: 'error', error_code: 'blocked_address' },
      { tool_call_id: 'web-synthetic', state: 'error', error_code: 'blocked_address' },
      { tool_call_id: 'web-redirect', state: 'error', error_code: 'blocked_address' },
    ]);
  } finally {
    store.close();
  }
});
