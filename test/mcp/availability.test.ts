import { expect, test } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { awaitServerAttempts } from '../../src/capabilities/mcp/availability.ts';
import { ImConnectionRegistry } from '../../src/platform/im-connection.ts';
import { standingWarnings } from '../../src/platform/warning-catalog.ts';
import { CHAT, directories, harness, server, waitForState, writeConfig } from './availability-shared.ts';

test('the deprecated required key still loads, warns per alias, and raises a standing warning', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'surowan-mcp-required-'));
  directories.push(directory);
  const loaded = await writeConfig(directory, (config) => {
    config.mcp = {
      servers: [
        { ...server('alpha', join(directory, 'alpha.pid')), required: true },
        { ...server('beta', join(directory, 'beta.pid')), required: false },
        server('gamma', join(directory, 'gamma.pid')),
      ],
    };
  });
  expect(loaded.warnings).toEqual([
    'mcp.servers[].required is deprecated and has no effect; remove it from: alpha, beta',
  ]);
  const connections = new ImConnectionRegistry();
  expect(standingWarnings(loaded.config, connections).map((warning) => warning.code)).toContain(
    'mcp_required_deprecated',
  );
  expect(
    standingWarnings(loaded.config, connections).find((warning) => warning.code === 'mcp_required_deprecated')
      ?.variables,
  ).toEqual({ aliases: ['alpha', 'beta'] });

  const clean = await writeConfig(directory, (config) => {
    config.mcp = { servers: [server('gamma', join(directory, 'gamma.pid'))] };
  });
  expect(clean.warnings).toEqual([]);
  expect(standingWarnings(clean.config, connections).map((warning) => warning.code)).not.toContain(
    'mcp_required_deprecated',
  );
});

test('start() returns promptly even with a black-holed server, and the failures degrade', async () => {
  const f = await harness((config) => {
    config.mcp = {
      servers: [
        {
          alias: 'closed',
          transport: 'streamable_http',
          url: 'http://127.0.0.1:1/mcp',
          follow_redirects: false,
          tools: ['echo'],
          payload_max_bytes: 32768,
          result_max_bytes: 32768,
          tool_policies: [{ name: 'echo', read_only: true, timeout_seconds: 5 }],
        },
        {
          // A non-routable endpoint whose connect hangs until the client
          // timeout: under the old contract this would have held `serve` for
          // the full attempt, and the deprecated flag still loads.
          alias: 'blackhole',
          transport: 'streamable_http',
          url: 'http://203.0.113.1:16999/mcp',
          follow_redirects: false,
          required: true,
          tools: ['echo'],
          payload_max_bytes: 32768,
          result_max_bytes: 32768,
          tool_policies: [{ name: 'echo', read_only: true, timeout_seconds: 5 }],
        },
      ],
    };
  });
  try {
    const started = Date.now();
    await f.manager.start();
    expect(Date.now() - started).toBeLessThan(5_000);

    // Nothing is ready, so the Chat sees no MCP tools.
    expect(f.manager.createTools(f.context, Date.now() + 60_000, f.loaded.config)).toEqual([]);

    // Poll for the moment `closed` sits in `degraded` with a re-armed backoff:
    // asserting a single awaited snapshot could land mid-retry in `starting`.
    const deadline = Date.now() + 10_000;
    let states = f.manager.serverStates();
    while (Date.now() < deadline) {
      states = f.manager.serverStates();
      const closed = states.find((server) => server.alias === 'closed');
      if (closed?.state === 'degraded' && closed.next_reconnect_at !== null) {
        break;
      }
      await delay(50);
    }
    expect(states.find((server) => server.alias === 'closed')).toMatchObject({
      state: 'degraded',
      error_code: expect.any(String),
      next_reconnect_at: expect.any(String),
    });
    expect(f.stateOf('closed')).toMatchObject({ state: 'degraded', reconnect_attempt: expect.any(BigInt) });
    // The black-holed one is still in its first attempt — `starting` is not a
    // failure and produces no warning.
    expect(states.find((server) => server.alias === 'blackhole')?.state).toBe('starting');
    const warnings = standingWarnings(f.loaded.config, new ImConnectionRegistry(), new Date(), states);
    expect(warnings.find((warning) => warning.code === 'mcp_server_unavailable')?.variables).toEqual({
      servers: [{ alias: 'closed', error_code: expect.any(String), next_reconnect_at: expect.any(String) }],
    });
  } finally {
    await f.close();
  }
}, 30_000);

test('a dropped server stops handing out tools and a queued call is refused as server_unavailable', async () => {
  const f = await harness((config, directory) => {
    config.mcp = { servers: [server('local', join(directory, 'local.pid'))] };
  });
  try {
    await f.manager.start();
    await awaitServerAttempts(f.manager);
    expect(f.stateOf('local')?.state).toBe('ready');
    const tool = f.manager
      .createTools(f.context, Date.now() + 60_000, f.loaded.config)
      .find((candidate) => candidate.name === 'local__echo');
    if (tool === undefined) {
      throw new Error('Missing local__echo');
    }

    // Kill the stdio server underneath the client: the transport drops, the
    // server degrades once and schedules its own reconnect.
    process.kill(await f.pidOf('local'));
    await waitForState(f.manager, 'local', 'degraded');
    expect(
      f.manager.createTools(f.context, Date.now() + 60_000, f.loaded.config).map((candidate) => candidate.name),
    ).toEqual([]);
    expect(f.manager.toolNamesForChat(BigInt(CHAT), f.loaded.config)).toEqual(['local__echo']);

    // A definition handed out earlier is refused without a request: audited as
    // `server_unavailable`, never `outcome_unknown`, and the refusal does not
    // re-arm the reconnect the drop already scheduled.
    const attempt = f.stateOf('local')?.reconnect_attempt;
    await expect(tool.execute('refused', { text: 'after-drop' })).rejects.toThrow('unavailable');
    expect(f.toolCalls()).toEqual([{ tool_name: 'local__echo', state: 'error', error_code: 'server_unavailable' }]);
    expect(f.stateOf('local')?.reconnect_attempt).toBe(attempt);

    // The standing warning names the degraded alias of the live configuration.
    const warnings = standingWarnings(
      f.loaded.config,
      new ImConnectionRegistry(),
      new Date(),
      f.manager.serverStates(),
    );
    expect(warnings.find((warning) => warning.code === 'mcp_server_unavailable')?.variables).toEqual({
      servers: [
        {
          alias: 'local',
          error_code: expect.stringMatching(/^transport_closed/),
          next_reconnect_at: expect.any(String),
        },
      ],
    });

    // The scheduled reconnect brings the server back and the tools return.
    await waitForState(f.manager, 'local', 'ready', 30_000);
    expect(f.manager.createTools(f.context, Date.now() + 60_000, f.loaded.config).map((c) => c.name)).toEqual([
      'local__echo',
    ]);
  } finally {
    await f.close();
  }
}, 60_000);

test('mcp_server_unavailable ignores aliases the published config removed and starting servers', async () => {
  const f = await harness((config, directory) => {
    config.mcp = { servers: [server('local', join(directory, 'local.pid'))] };
  });
  try {
    await f.manager.start();
    await awaitServerAttempts(f.manager);
    process.kill(await f.pidOf('local'));
    await waitForState(f.manager, 'local', 'degraded');
    const connections = new ImConnectionRegistry();

    // A degraded alias the published config no longer lists must not warn even
    // if a state entry for it lingers — the table keeps rows for removed
    // aliases, so only the live configuration decides who may appear.
    const withGhost = [
      ...f.manager.serverStates(),
      {
        alias: 'ghost',
        state: 'degraded' as const,
        error_code: 'transport_error',
        next_reconnect_at: null,
        retrying: false,
      },
    ];
    expect(
      standingWarnings(f.loaded.config, connections, new Date(), withGhost).find(
        (warning) => warning.code === 'mcp_server_unavailable',
      )?.variables,
    ).toEqual({
      servers: [
        {
          alias: 'local',
          error_code: expect.stringMatching(/^transport_closed/),
          next_reconnect_at: expect.any(String),
        },
      ],
    });

    // A server connecting for the very first time after boot is `starting`
    // without a retry: no failure has happened yet, so nothing warns.
    const starting = f.manager
      .serverStates()
      .map((server) => ({ ...server, state: 'starting' as const, retrying: false }));
    expect(
      standingWarnings(f.loaded.config, connections, new Date(), starting).map((warning) => warning.code),
    ).not.toContain('mcp_server_unavailable');
  } finally {
    await f.close();
  }
}, 30_000);
