/** Local process composition root: owns transport, files, locks and lifecycle. */
import { assertConfigPermissions, loadConfig } from './config.ts';
import { keyJarPath } from '../../platform/key-jar.ts';
import { SecretStore } from '../../platform/secrets.ts';
import { connectServeHosts, runServeLoop, startAdminServer, startCoreRuntime } from './runtime-host-serve-run.ts';
import { openServeEnvironment, startServeServices } from './runtime-host-serve.ts';
import { RESTART_EXIT_CODE, logEvent, type ServeContext, type ServeState } from './runtime-host-support.ts';
import { isTelegramDisabled } from './telegram-connection-token.ts';

export interface ServeOptions {
  /** Ask a running instance on the same data directory to stop first. */
  readonly takeover?: boolean;
}

export async function serve(configPath: string, options: ServeOptions = {}): Promise<void> {
  const takeover = options.takeover === true;
  const loaded = await loadConfig(configPath);
  await assertConfigPermissions(loaded.configPath);
  // Both halves of the product may be off, but not both at once: rooms are
  // reachable only through the panel, and a panel-only process with no IM has
  // nothing to do. Only an explicit disable counts; an unreadable token is a
  // configuration error the panel is expected to show, not a useless process.
  if (isTelegramDisabled(loaded.config) && loaded.config.admin.enabled === false) {
    throw new Error('Surowan is useless if neither admin panel is enabled nor telegram is configured');
  }
  const secrets = new SecretStore(keyJarPath(loaded.configPath));
  const state: ServeState = {};
  const replayShutdown = new AbortController();
  let shuttingDown = false;
  let restartRequested = false;
  // Long polling belongs to the Telegram connection manager, so the process
  // always lives on this promise; the same shutdown path resolves it.
  let releaseIdle: (() => void) | undefined;
  const idle = new Promise<void>((resolve) => {
    releaseIdle = resolve;
  });
  const shutdown = (): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logEvent('shutdown_requested');
    releaseIdle?.();
    replayShutdown.abort(new Error('shutdown'));
  };
  /**
   * The Admin Panel's restart: the same graceful shutdown as a signal, but the
   * process leaves with `RESTART_EXIT_CODE` so the supervisor starts it again.
   *
   * Shutdown reaches `admin.stop()` only through the `finally` block below,
   * after `bot.stop()` has unblocked `bot.start()`, so the panel's 202 is long
   * gone by the time the Admin server destroys its connections. Anything that
   * stops the Admin server earlier would cut that response off.
   */
  const requestRestart = (): void => {
    if (restartRequested || shuttingDown) {
      return;
    }
    restartRequested = true;
    logEvent('restart_requested');
    shutdown();
  };
  const context: ServeContext = {
    loaded,
    secrets,
    takeover,
    replayShutdown,
    idle,
    state,
    shutdown,
    requestRestart,
  };
  const stopSignals = watchStopSignals(shutdown, (signal) => {
    // 130/143 = 128 + the signal number: the shell's convention for a process
    // that died of a signal, which is what an interrupted drain is.
    const code = signal === 'SIGTERM' ? 143 : 130;
    logEvent('shutdown_forced', { signal });
    // Under a supervisor stdout is a pipe and its writes are asynchronous, so
    // leave from the flush callback; a write that never lands is still bounded
    // by the timer.
    const timer = setTimeout(() => process.exit(code), 250);
    process.stdout.write('', () => {
      clearTimeout(timer);
      process.exit(code);
    });
  });
  try {
    const environment = await openServeEnvironment(context);
    const services = await startServeServices(context, environment);
    const assembly = { ...services, ...connectServeHosts(context, services) };
    const core = await startCoreRuntime(context, assembly);
    await startAdminServer(context, assembly, core);
    await runServeLoop(context, assembly);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(secrets.redact(message));
  } finally {
    // The signal handlers outlive the drain below: that wait is what a second
    // signal exists to cut short. Without a handler Node falls back to the
    // default action, which skips `shutdown_forced` and, for a container's
    // PID 1, ignores the signal altogether.
    try {
      replayShutdown.abort(new Error('shutdown'));
      state.stopWatcher?.();
      state.warnings?.stop();
      // Stop ingress before the drain: no new update may become an invocation
      // while the scheduler is waiting for its runs to finish.
      await state.telegramConnection?.shutdown();
      await state.admin?.stop();
      await state.scheduler?.stop(30_000);
      state.host?.activity.stopAll();
      state.roomHost?.activity.stopAll();
      // The image worker borrows the SQLite connection; it must settle (marking
      // late results interrupted if the shutdown budget expires) before the
      // store closes underneath it.
      state.imageBridge?.stop();
      await state.imageService?.stop();
      await state.mcp?.stop();
      state.store?.close();
      await state.lock?.release();
    } finally {
      stopSignals();
    }
  }
  if (restartRequested) {
    logEvent('restart_exit', { code: RESTART_EXIT_CODE });
    // Leaving through the exit code lets pending output flush; the unref'd timer
    // only fires if some handle outlives the cleanup, so the supervisor is not
    // left waiting on a process that cannot finish.
    process.exitCode = RESTART_EXIT_CODE;
    setTimeout(() => process.exit(RESTART_EXIT_CODE), 1_000).unref();
  }
}

/**
 * Two-stage stop for SIGINT and SIGTERM: the first signal starts the graceful
 * shutdown, a second one calls `forceExit` instead of waiting for the drain.
 *
 * The escape hatch exists because the drain budget is a wait the operator may
 * not want: an Invocation that refuses to settle keeps the process alive until
 * its own abort lands. Forcing leaves the same state as a supervisor's SIGKILL
 * — the interrupted Invocation is recovered as `process_restart` on the next
 * start — and a signal that arrives after an internal shutdown (takeover,
 * panel restart) still needs its own first press.
 */
export function watchStopSignals(shutdown: () => void, forceExit: (signal: NodeJS.Signals) => void): () => void {
  let stopping = false;
  const onSignal = (signal: NodeJS.Signals): void => {
    if (stopping) {
      forceExit(signal);
      return;
    }
    stopping = true;
    shutdown();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  return () => {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  };
}
