import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { createServer, type ViteDevServer } from 'vite';

const ready = Promise.withResolvers<string | null>();
const stopped = Promise.withResolvers<void>();
const exited = Promise.withResolvers<void>();
let stopping = false;
let vite: ViteDevServer | undefined;
let closingVite: Promise<void> | undefined;

function stop(error?: unknown): void {
  if (stopping) {
    return;
  }
  stopping = true;
  if (error !== undefined) {
    console.error(`Mock dev server failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
  // Start closing synchronously: Vite removes its own SIGTERM/stdin handlers
  // here, before they can process.exit() and skip waiting for the fixture.
  closingVite = vite?.close();
  ready.resolve(null);
  stopped.resolve();
}

// A piped stdin lets the existing fixture clean up on Windows too, where
// child.kill('SIGTERM') would terminate it without running its shutdown hook.
const backend = spawn(process.execPath, [join(import.meta.dirname, 'e2e', 'server.ts')], {
  cwd: import.meta.dirname,
  env: { ...process.env, E2E_PASSKEYS: '0' },
  stdio: ['pipe', 'pipe', 'inherit'],
  windowsHide: true,
});
backend.once('error', (error) => {
  exited.resolve();
  stop(error);
});
backend.once('exit', (code, signal) => {
  exited.resolve();
  if (!stopping) {
    stop(new Error(`Mock backend exited unexpectedly (${signal ?? String(code)})`));
  }
});
backend.stdin.on('error', (error) => stop(error));
const lines = createInterface({ input: backend.stdout });
lines.on('line', (line) => {
  console.log(line);
  const base = /^E2E_READY base=(http:\/\/127\.0\.0\.1:\d+)$/.exec(line)?.[1];
  if (base !== undefined) {
    ready.resolve(base);
  }
});
const readyTimeout = setTimeout(() => stop(new Error('Mock backend did not become ready within 60 seconds')), 60_000);

process.once('SIGINT', () => stop());
process.once('SIGTERM', () => stop());
if (!process.stdin.isTTY) {
  process.stdin.once('end', () => stop());
  process.stdin.resume();
}

try {
  const base = await ready.promise;
  clearTimeout(readyTimeout);
  if (base !== null && !stopping) {
    // The config reads this when Vite loads it, not when this module imports Vite.
    process.env.ADMIN_API_TARGET = base;
    vite = await createServer({
      root: import.meta.dirname,
      configFile: join(import.meta.dirname, 'vite.config.ts'),
      clearScreen: false,
    });
    if (!stopping) {
      await vite.listen();
      if (!stopping) {
        vite.printUrls();
        console.log(`ADMIN_DEV_MOCK_READY frontend=http://127.0.0.1:5273 backend=${base}`);
        console.log('Temporary mock data. Create an administrator in the browser. Ctrl+C stops both servers.');
      }
    }
  }
  await stopped.promise;
} catch (error) {
  stop(error);
} finally {
  stopping = true;
  clearTimeout(readyTimeout);
  lines.close();
  backend.stdin.end();
  const killTimeout = setTimeout(() => backend.kill('SIGKILL'), 10_000);
  try {
    await (closingVite ?? vite?.close());
  } finally {
    await exited.promise;
    clearTimeout(killTimeout);
    process.stdin.pause();
  }
}
