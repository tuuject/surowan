/**
 * `/api/telegram` bucket timing: the saved and running values the Telegram
 * page shows, and the write that edits the three `telegram.bucket_*` fields
 * and applies them hot. Every case runs a real file, reloader and AdminServer,
 * so the assertions cover what lands on disk and what the process runs with.
 */
import { readFile } from 'node:fs/promises';
import { expect, test } from 'vitest';
import { AdminServer } from '../../src/ingress/admin/index.ts';
import { resolveBucketTiming } from '../../src/platform/config/resolve.ts';
import { ImConnectionRegistry } from '../../src/platform/im-connection.ts';
import { setup } from '../config/reload-fixtures.ts';
import { PASSWORD, post, readJson, request, sessionCookie } from './fixtures.ts';

interface Panel {
  readonly fixture: Awaited<ReturnType<typeof setup>>;
  call(path: string, init?: RequestInit): Promise<Response>;
  configText(): Promise<string>;
  close(): Promise<void>;
}

async function panel(options: Parameters<typeof setup>[0] = {}): Promise<Panel> {
  const fixture = await setup(options);
  const server = new AdminServer({
    store: fixture.store,
    configStore: fixture.configStore,
    configReloader: fixture.reloader,
    secrets: fixture.secrets,
    connections: new ImConnectionRegistry(),
  });
  const cookie = sessionCookie(await server.handle(post('/api/auth/setup', { username: 'owner', password: PASSWORD })));
  return {
    fixture,
    call: (path, init = {}) =>
      server.handle(
        request(`/api${path}`, {
          ...init,
          headers: { cookie, origin: 'http://127.0.0.1:8899', ...(init.headers as Record<string, string>) },
        }),
      ),
    configText: () => readFile(fixture.configPath, 'utf8'),
    close: async () => {
      await server.stop();
      fixture.store.close();
    },
  };
}

function putTiming(revision: string | null, body: unknown): RequestInit {
  return {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...(revision === null ? {} : { 'if-match': revision }) },
    body: JSON.stringify(body),
  };
}

type FileTelegram = Record<string, unknown>;

async function fileTelegram(p: Panel): Promise<FileTelegram> {
  return (JSON.parse(await p.configText()) as { telegram: FileTelegram }).telegram;
}

const DEFAULT_TIMING = { bucket_window_seconds: 15, bucket_max_seconds: null, bucket_bump_seconds: 0 };

test('GET /telegram reports the saved and running bucket timing, with absent fields resolved', async () => {
  const p = await panel();
  try {
    const view = await readJson(await p.call('/telegram'));
    expect(view.bucket_timing).toEqual({ saved: DEFAULT_TIMING, active: DEFAULT_TIMING });
  } finally {
    await p.close();
  }
});

test('PUT /telegram/bucket-timing writes the file and the running process adopts it at once', async () => {
  const p = await panel();
  try {
    const before = await readJson(await p.call('/telegram'));
    const response = await p.call(
      '/telegram/bucket-timing',
      putTiming(before.revision, { bucket_window_seconds: 10, bucket_max_seconds: 60, bucket_bump_seconds: 5 }),
    );
    expect(response.status).toBe(200);
    const body = await readJson(response);
    const written = { bucket_window_seconds: 10, bucket_max_seconds: 60, bucket_bump_seconds: 5 };
    expect(body).toMatchObject({
      revision: expect.stringMatching(/^[a-f0-9]{64}$/),
      bucket_timing: { saved: written, active: written },
      apply: {
        applied: ['telegram.bucket_bump_seconds', 'telegram.bucket_max_seconds', 'telegram.bucket_window_seconds'],
        restart_required: [],
      },
    });
    expect(body.revision).not.toBe(before.revision);
    expect(await fileTelegram(p)).toMatchObject(written);
    expect(resolveBucketTiming(p.fixture.configStore.current().config, 'telegram')).toEqual({
      windowSeconds: 10,
      maxSeconds: 60,
      bumpSeconds: 5,
    });

    // `null` removes an optional field: the ceiling follows the window again
    // and the bump goes back to none.
    const cleared = await p.call(
      '/telegram/bucket-timing',
      putTiming(body.revision, { bucket_max_seconds: null, bucket_bump_seconds: null }),
    );
    expect(cleared.status).toBe(200);
    const clearedBody = await readJson(cleared);
    const resolved = { bucket_window_seconds: 10, bucket_max_seconds: null, bucket_bump_seconds: 0 };
    expect(clearedBody.bucket_timing).toEqual({ saved: resolved, active: resolved });
    expect(clearedBody.apply.applied).toEqual(['telegram.bucket_bump_seconds', 'telegram.bucket_max_seconds']);
    const file = await fileTelegram(p);
    expect(file).not.toHaveProperty('bucket_max_seconds');
    expect(file).not.toHaveProperty('bucket_bump_seconds');
    expect(file.bucket_window_seconds).toBe(10);
  } finally {
    await p.close();
  }
});

test('PUT /telegram/bucket-timing that changes nothing leaves the file alone', async () => {
  const p = await panel();
  try {
    const before = await readJson(await p.call('/telegram'));
    const text = await p.configText();
    // The window already is 15, and an absent bump already means 0.
    const response = await p.call(
      '/telegram/bucket-timing',
      putTiming(before.revision, { bucket_window_seconds: 15, bucket_bump_seconds: 0, bucket_max_seconds: null }),
    );
    expect(response.status).toBe(200);
    const body = await readJson(response);
    expect(body.revision).toBe(before.revision);
    expect(body.apply).toEqual({ applied: [], restart_required: [], outside_serve: [] });
    expect(await p.configText()).toBe(text);
  } finally {
    await p.close();
  }
});

test('PUT /telegram/bucket-timing rejects malformed bodies and stale revisions without writing', async () => {
  const p = await panel();
  try {
    const { revision } = await readJson(await p.call('/telegram'));
    const text = await p.configText();
    const expectRejected = async (init: RequestInit, status: number, error: string): Promise<void> => {
      const response = await p.call('/telegram/bucket-timing', init);
      expect({ status: response.status, error: (await readJson(response)).error }).toEqual({ status, error });
    };
    await expectRejected(putTiming(null, { bucket_window_seconds: 10 }), 400, 'revision_required');
    await expectRejected(putTiming('0'.repeat(64), { bucket_window_seconds: 10 }), 409, 'config_conflict');
    await expectRejected(putTiming(revision, {}), 400, 'invalid_body');
    await expectRejected(putTiming(revision, { token: 'x' }), 400, 'invalid_body');
    await expectRejected(putTiming(revision, { bucket_window_seconds: 10, extra: 1 }), 400, 'invalid_body');
    // The window is required in the section, so it cannot be removed.
    await expectRejected(putTiming(revision, { bucket_window_seconds: null }), 400, 'invalid_bucket_timing');
    await expectRejected(putTiming(revision, { bucket_window_seconds: 301 }), 400, 'invalid_bucket_timing');
    await expectRejected(putTiming(revision, { bucket_bump_seconds: -1 }), 400, 'invalid_bucket_timing');
    await expectRejected(putTiming(revision, { bucket_max_seconds: 1.5 }), 400, 'invalid_bucket_timing');
    await expectRejected(putTiming(revision, { bucket_max_seconds: '30' }), 400, 'invalid_bucket_timing');
    expect(await p.configText()).toBe(text);
    expect(resolveBucketTiming(p.fixture.configStore.current().config, 'telegram')).toEqual({
      windowSeconds: 15,
      maxSeconds: 15,
      bumpSeconds: 0,
    });
  } finally {
    await p.close();
  }
});

test('PUT /telegram/bucket-timing validates the timing against the whole file', async () => {
  const p = await panel({
    transform: (config) => {
      config.agent!.context!.idle_grace_seconds = 30;
    },
  });
  try {
    const { revision } = await readJson(await p.call('/telegram'));
    const text = await p.configText();

    const belowWindow = await p.call('/telegram/bucket-timing', putTiming(revision, { bucket_max_seconds: 10 }));
    expect(belowWindow.status).toBe(422);
    const belowBody = await readJson(belowWindow);
    expect(belowBody.error).toBe('config_invalid');
    expect(belowBody.message).toContain('bucket_max_seconds must be at least telegram.bucket_window_seconds');

    // A ceiling past the long-lived idle grace would never attach its batch.
    const pastGrace = await p.call('/telegram/bucket-timing', putTiming(revision, { bucket_max_seconds: 60 }));
    expect(pastGrace.status).toBe(422);
    expect((await readJson(pastGrace)).message).toContain('idle_grace_seconds');

    expect(await p.configText()).toBe(text);
    expect(p.fixture.configStore.current().config.telegram.bucket_max_seconds).toBeUndefined();

    // Within the grace the same ceiling is fine.
    const within = await p.call('/telegram/bucket-timing', putTiming(revision, { bucket_max_seconds: 30 }));
    expect(within.status).toBe(200);
    expect((await readJson(within)).bucket_timing.active.bucket_max_seconds).toBe(30);
  } finally {
    await p.close();
  }
});

test('PUT /telegram/bucket-timing creates a missing telegram section from the documented defaults', async () => {
  const p = await panel({
    transform: (config) => {
      (config as unknown as Record<string, unknown>).telegram = undefined;
    },
  });
  try {
    const before = await readJson(await p.call('/telegram'));
    expect(before).toMatchObject({ telegram_section_present: false, bucket_timing: { saved: DEFAULT_TIMING } });
    const response = await p.call('/telegram/bucket-timing', putTiming(before.revision, { bucket_bump_seconds: 5 }));
    expect(response.status).toBe(200);
    expect(await readJson(response)).toMatchObject({
      telegram_section_present: true,
      bucket_timing: { active: { bucket_window_seconds: 15, bucket_max_seconds: null, bucket_bump_seconds: 5 } },
    });
    expect(await fileTelegram(p)).toMatchObject({
      process_bot_messages: false,
      bucket_window_seconds: 15,
      bucket_bump_seconds: 5,
      chats: [],
    });
  } finally {
    await p.close();
  }
});
