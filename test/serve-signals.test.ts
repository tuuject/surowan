import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';

const RUNTIME_HOST = pathToFileURL(
  fileURLToPath(new URL('../src/adapters/local-monolith/runtime-host.ts', import.meta.url)),
).href;

const children: ChildProcess[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    child.kill('SIGKILL');
  }
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe.skipIf(process.platform === 'win32')('stop signals', () => {
  test.each([
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ] as const)('a second %s forces the exit with code %i', async (signal, exitCode) => {
    const directory = await mkdtemp(join(tmpdir(), 'plasticwan-signals-'));
    directories.push(directory);
    const forcedMarker = join(directory, 'forced.txt');
    const scriptPath = join(directory, 'child.ts');
    await writeFile(
      scriptPath,
      `import { writeFileSync } from 'node:fs';
import { watchStopSignals } from ${JSON.stringify(RUNTIME_HOST)};
watchStopSignals(
  () => console.log('drained'),
  (received) => {
    // Synchronous write: the marker must survive process.exit on a pipe.
    writeFileSync(${JSON.stringify(forcedMarker)}, received);
    process.exit(received === 'SIGTERM' ? 143 : 130);
  },
);
console.log('ready');
// Keep-alive only; the child stays up until a signal arrives.
setInterval(() => {}, 60_000);
`,
    );
    const child = spawn(process.execPath, [scriptPath], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000 });
    children.push(child);

    const output = new LineWaiter();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => output.push(chunk));
    child.on('exit', () => output.abandon());

    await output.line('ready');
    child.kill(signal);
    await output.line('drained');

    // The graceful path is still running: the child must survive the first signal.
    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBeNull();
    expect(existsSync(forcedMarker)).toBe(false);

    child.kill(signal);
    const exit = Promise.withResolvers<number | null>();
    child.once('exit', (code) => exit.resolve(code));
    child.once('error', (error) => exit.reject(error));
    expect(await exit.promise).toBe(exitCode);
    expect(readFileSync(forcedMarker, 'utf8')).toBe(signal);
  });
});

/** Resolves a waiter as soon as the accumulated child output contains its needle. */
class LineWaiter {
  #buffer = '';
  #waiters: Array<{ needle: string; settle: (error?: Error) => void }> = [];

  push(chunk: string): void {
    this.#buffer += chunk;
    this.#flush();
  }

  /** Rejects waiters when the child ends without producing their needle. */
  abandon(): void {
    for (const waiter of this.#waiters.splice(0)) {
      waiter.settle(new Error(`child exited before "${waiter.needle}": ${this.#buffer}`));
    }
  }

  line(needle: string): Promise<void> {
    if (this.#buffer.includes(needle)) {
      return Promise.resolve();
    }
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    this.#waiters.push({ needle, settle: (error) => (error === undefined ? resolve() : reject(error)) });
    return promise;
  }

  #flush(): void {
    for (const waiter of this.#waiters.splice(0)) {
      if (this.#buffer.includes(waiter.needle)) {
        waiter.settle();
      } else {
        this.#waiters.push(waiter);
      }
    }
  }
}
