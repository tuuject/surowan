import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { expect, test } from '@playwright/test';
import { E2E_PASSWORD, E2E_USERNAME } from './helpers.ts';

/**
 * Launcher failure contracts, exercised through real processes and the browser:
 * - no running Bot is needed; Vite serves the source SPA and HMR;
 * - the random fixture URL overrides any inherited API target;
 * - same-origin setup works through the proxy, cross-site writes stay forbidden;
 * - stdin EOF closes both listeners; an occupied port or a lost backend fails
 *   non-zero and leaves neither a dev server nor a fixture listener behind.
 */
test.describe.configure({ mode: 'serial', timeout: 120_000 });

const DEV_BASE = 'http://127.0.0.1:5273';

function launch(options: { readonly preload?: string } = {}) {
  const child = spawn(
    process.execPath,
    [
      ...(options.preload === undefined ? [] : ['--import', pathToFileURL(options.preload).href]),
      join(import.meta.dirname, '..', 'dev-mock.ts'),
    ],
    {
      cwd: join(import.meta.dirname, '..'),
      env: { ...process.env, CI: 'false', ADMIN_API_TARGET: 'http://127.0.0.1:1' },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  const backend = Promise.withResolvers<string>();
  const ready = Promise.withResolvers<void>();
  const exited = Promise.withResolvers<number | null>();
  let output = '';
  child.stderr.on('data', (chunk: Buffer) => {
    output += String(chunk);
  });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    output += `${line}\n`;
    const base = /^E2E_READY base=(\S+)$/.exec(line)?.[1];
    if (base !== undefined) {
      backend.resolve(base);
    }
    if (line.startsWith('ADMIN_DEV_MOCK_READY ')) {
      ready.resolve();
    }
  });
  child.once('error', (error) => {
    backend.reject(error);
    ready.reject(error);
  });
  child.once('exit', (code) => {
    const error = new Error(`Mock dev command exited (${String(code)}):\n${output}`);
    backend.reject(error);
    ready.reject(error);
    exited.resolve(code);
  });
  // The port-conflict case intentionally exits without ever becoming ready.
  void backend.promise.catch(() => undefined);
  void ready.promise.catch(() => undefined);
  return {
    child,
    backend: backend.promise,
    ready: ready.promise,
    exited: exited.promise,
    output: () => output,
    stop: async (): Promise<void> => {
      child.stdin.end();
      const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
      try {
        await exited.promise;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

async function expectStopped(base: string): Promise<void> {
  await expect(fetch(base, { signal: AbortSignal.timeout(2_000) })).rejects.toThrow();
}

test('one command serves the hot-reloading SPA with an isolated backend and closes on stdin EOF', async ({
  page,
}, testInfo) => {
  const server = launch();
  try {
    await server.ready;
    const backend = await server.backend;
    const html = await (await page.request.get(DEV_BASE)).text();
    expect(html).toContain('/@vite/client');
    expect((await page.request.get(`${DEV_BASE}/@vite/client`)).status()).toBe(200);

    await page.goto(DEV_BASE);
    await expect(page.getByText('Create the administrator account')).toBeVisible();
    await page.getByLabel('Username').fill(E2E_USERNAME);
    await page.getByLabel('Password').fill(E2E_PASSWORD);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByText('Stored messages')).toBeVisible();
    expect((await page.request.get(`${DEV_BASE}/api/overview`)).status()).toBe(200);
    const denied = await page.request.post(`${DEV_BASE}/api/auth/logout`, {
      headers: { origin: 'http://evil.example' },
    });
    expect(denied.status()).toBe(403);
    expect((await page.request.get(`${DEV_BASE}/api/overview`)).status()).toBe(200);

    await page.goto(`${DEV_BASE}/messages`);
    await expect(page.locator('table tbody tr').first()).toBeVisible();
    await expect(page.locator('[data-route-error]')).toHaveCount(0);
    const screenshot = testInfo.outputPath('mock-dev-messages.png');
    await page.screenshot({ path: screenshot });
    await testInfo.attach('mock-dev-messages', { path: screenshot, contentType: 'image/png' });
    await server.stop();
    expect(await server.exited).toBe(0);
    await expectStopped(backend);
    await expectStopped(DEV_BASE);
    const report = testInfo.outputPath('mock-dev-lifecycle.json');
    await writeFile(
      report,
      JSON.stringify(
        {
          frontend: DEV_BASE,
          backend,
          viteClient: true,
          setupThroughProxy: true,
          crossSiteWriteStatus: denied.status(),
          exitCode: await server.exited,
          listenersClosed: true,
        },
        null,
        2,
      ),
    );
    await testInfo.attach('mock-dev-lifecycle', { path: report, contentType: 'application/json' });
  } finally {
    await server.stop();
  }
});

test('an occupied Vite port fails clearly and shuts down the fixture', async () => {
  const occupied = createServer();
  occupied.listen(5273, '127.0.0.1');
  await once(occupied, 'listening');
  const server = launch();
  try {
    const backend = await server.backend;
    expect(await server.exited).toBe(1);
    expect(server.output()).toContain('Port 5273 is already in use');
    await expectStopped(backend);
    expect(occupied.listening).toBe(true);
  } finally {
    await server.stop();
    await new Promise<void>((resolve, reject) => occupied.close((error) => (error ? reject(error) : resolve())));
  }
});

test('an unexpected backend exit stops Vite and reports failure', async () => {
  const server = launch();
  try {
    await server.ready;
    const backend = await server.backend;
    const stopped = await fetch(`${backend}/__e2e/shutdown`, { method: 'POST' });
    expect(stopped.status).toBe(200);
    expect(await server.exited).toBe(1);
    expect(server.output()).toContain('Mock backend exited unexpectedly');
    await expectStopped(backend);
    await expectStopped(DEV_BASE);
  } finally {
    await server.stop();
  }
});

test('Vite stdin handling cannot exit before a slow backend finishes', async () => {
  const preload = test.info().outputPath('slow-backend.mjs');
  // Delay only the real fixture's exit event, after its own shutdown finished.
  // This catches Vite calling process.exit() before the launcher awaited it.
  await writeFile(
    preload,
    `import { syncBuiltinESMExports } from 'node:module';
import childProcess from 'node:child_process';
const spawn = childProcess.spawn;
childProcess.spawn = (...args) => {
  const child = spawn(...args);
  const emit = child.emit;
  child.emit = function (event, ...values) {
    if (event === 'exit') {
      setTimeout(() => {
        console.log('MOCK_BACKEND_EXIT_OBSERVED');
        emit.call(this, event, ...values);
      }, 750);
      return true;
    }
    return emit.call(this, event, ...values);
  };
  return child;
};
syncBuiltinESMExports();
`,
  );
  const server = launch({ preload });
  try {
    await server.ready;
    await server.stop();
    expect(await server.exited).toBe(0);
    expect(server.output()).toContain('MOCK_BACKEND_EXIT_OBSERVED');
    await expectStopped(await server.backend);
    await expectStopped(DEV_BASE);
  } finally {
    await server.stop();
  }
});
