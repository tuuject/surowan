import { expect, test } from 'vitest';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { awaitServerAttempts } from '../../src/capabilities/mcp/availability.ts';
import { ImConnectionRegistry } from '../../src/platform/im-connection.ts';
import { standingWarnings } from '../../src/platform/warning-catalog.ts';
import { flapServer, harness, waitForPid, waitForState } from './availability-shared.ts';

// Recovery semantics of the flap fixture: what a hung attempt, a transport
// error without a close, an oversized refresh, a mid-call drop and a retry do
// to the server's lifecycle and the operator-visible warning.

test('stop() aborts a hung handshake: the stdio child exits and the row stays stopped', async () => {
  const f = await harness((config, directory) => {
    config.mcp = { servers: [flapServer('hang', directory, { handshakeDelay: -1 })] };
  });
  try {
    await f.manager.start();
    // The child spawned and wrote its pid, but it never answers `initialize`:
    // the attempt sits in `starting` until its own timeout unless stop() cancels it.
    const pid = await waitForPid(join(f.directory, 'hang.pid'));
    expect(f.manager.serverStates().find((server) => server.alias === 'hang')?.state).toBe('starting');

    const started = Date.now();
    await f.manager.stop();
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(f.stateOf('hang')?.state).toBe('stopped');
    // Signal 0 probes existence: an orphaned child would still answer.
    expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    await f.close();
  }
}, 30_000);

test('a transport error without a close degrades once, arms recovery, and the tools return', async () => {
  const f = await harness((config, directory) => {
    config.mcp = { servers: [flapServer('flap', directory, { garbageAt: 1_200 })] };
  });
  try {
    await f.manager.start();
    await awaitServerAttempts(f.manager);
    expect(f.stateOf('flap')?.state).toBe('ready');

    // The malformed frame is a parse error: `onerror` fires while the child
    // stays alive and no `onclose` follows. Degrading without arming recovery
    // would hide the tools forever now that only `ready` servers expose any.
    await waitForState(f.manager, 'flap', 'degraded');
    expect(f.manager.serverStates().find((server) => server.alias === 'flap')?.next_reconnect_at).not.toBeNull();

    await waitForState(f.manager, 'flap', 'ready', 30_000);
    expect(
      f.manager
        .createTools(f.context, Date.now() + 60_000, f.loaded.config)
        .map((tool) => tool.name)
        .sort(),
    ).toEqual(['flap__echo', 'flap__linger']);
  } finally {
    await f.close();
  }
}, 60_000);

test('a refresh that overflows the registry while the server is degraded never publishes', async () => {
  const f = await harness((config, directory) => {
    config.mcp = { servers: [flapServer('flap', directory, { garbageAt: 800, expandAt: 1_400 })] };
  });
  try {
    await f.manager.start();
    await awaitServerAttempts(f.manager);
    expect(f.stateOf('flap')?.state).toBe('ready');

    // After the error degrades the server, its listChanged grows the set past
    // the 61-tool cap. The refresh must run the registry check as `ready`
    // like the initial connect does — watching a degraded server lets the
    // oversized set through unpublished. Nothing may ever expose a filler.
    let maxTools = 0;
    let sawRegistryFailure = false;
    const deadline = Date.now() + 4_500;
    while (Date.now() < deadline) {
      maxTools = Math.max(maxTools, f.manager.createTools(f.context, Date.now() + 60_000, f.loaded.config).length);
      const flap = f.manager.serverStates().find((server) => server.alias === 'flap');
      if (flap?.error_code === 'registry_update_failed') {
        sawRegistryFailure = true;
      }
      await delay(25);
    }
    expect(maxTools).toBeLessThanOrEqual(2);
    expect(sawRegistryFailure).toBe(true);
  } finally {
    await f.close();
  }
}, 30_000);

test('a sent read-only call retried after the server dropped keeps the first failure', async () => {
  const f = await harness((config, directory) => {
    config.mcp = { servers: [flapServer('flap', directory)] };
  });
  try {
    await f.manager.start();
    await awaitServerAttempts(f.manager);
    const linger = f.manager
      .createTools(f.context, Date.now() + 60_000, f.loaded.config)
      .find((candidate) => candidate.name === 'flap__linger');
    if (linger === undefined) {
      throw new Error('Missing flap__linger');
    }

    const pending = linger.execute('retry-class', { ms: 30_000 });
    // Let the request leave the process, then drop the server mid-call: the
    // first attempt fails transiently, the read-only retry finds no client.
    await delay(300);
    process.kill(await f.pidOf('flap'));
    await expect(pending).rejects.toThrow('flap__linger');
    // A request already went out, so the audit keeps the sent attempt's
    // transport class instead of the definite `server_unavailable` refusal.
    expect(f.toolCalls()).toEqual([
      { tool_name: 'flap__linger', state: 'outcome_unknown', error_code: 'connection_closed' },
    ]);
  } finally {
    await f.close();
  }
}, 30_000);

test('mcp_server_unavailable stays armed while a failed server retries, not on first boot', async () => {
  const f = await harness((config, directory) => {
    config.mcp = { servers: [flapServer('flap', directory, { handshakeDelay: 2_500 })] };
  });
  try {
    await f.manager.start();
    // First boot: the slow handshake is plain `starting` with no retry — the
    // outage has not happened yet, so nothing warns.
    const booting = f.manager.serverStates().find((server) => server.alias === 'flap');
    expect(booting).toMatchObject({ state: 'starting', retrying: false });
    expect(
      standingWarnings(f.loaded.config, new ImConnectionRegistry(), new Date(), f.manager.serverStates()).map(
        (warning) => warning.code,
      ),
    ).not.toContain('mcp_server_unavailable');

    await waitForState(f.manager, 'flap', 'ready', 20_000);
    process.kill(await f.pidOf('flap'));
    await waitForState(f.manager, 'flap', 'degraded');

    // The retry spends ~2.5 s in `starting`: the warning must stay armed for
    // the whole attempt instead of flickering off until it fails again, and
    // it keeps the code of the failure it is recovering from.
    const connections = new ImConnectionRegistry();
    let sawRetry = false;
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const states = f.manager.serverStates();
      const flap = states.find((server) => server.alias === 'flap');
      if (flap?.state === 'ready') {
        break;
      }
      if (flap?.state === 'starting') {
        expect(flap.retrying).toBe(true);
        const warning = standingWarnings(f.loaded.config, connections, new Date(), states).find(
          (candidate) => candidate.code === 'mcp_server_unavailable',
        );
        expect(warning?.variables).toEqual({
          servers: [{ alias: 'flap', error_code: expect.any(String), next_reconnect_at: null }],
        });
        sawRetry = true;
      }
      await delay(25);
    }
    expect(sawRetry).toBe(true);
    await waitForState(f.manager, 'flap', 'ready', 20_000);
  } finally {
    await f.close();
  }
}, 60_000);
