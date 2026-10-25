import { expect, test } from 'vitest';
import { SecretStore } from '../../src/platform/secrets.ts';
import { logEvents, textUpdate, until, setup, settle } from './reload-fixtures.ts';

test('invocations.config_hash records the hash that was active when the run started', async () => {
  const fixture = await setup();
  try {
    // A bucket whose deadline already passed when the scheduler starts.
    fixture.ingestion.ingest(textUpdate(1, 10, 'hello'), new Date(Date.now() - 60_000));
    const [invocationId] = fixture.scheduler.processDue(new Date());
    if (invocationId === undefined) {
      throw new Error('Expected a queued invocation');
    }
    const queued = fixture.store.db
      .prepare<[bigint], { config_hash: string }>('SELECT config_hash FROM invocations WHERE id = ?')
      .get(invocationId);
    expect(queued?.config_hash).toBe(fixture.configStore.current().hash);

    await fixture.patch((config) => {
      config.agent!.thinking_level = 'high';
    });
    const reloaded = await fixture.reloader.reloadFromFile();
    expect(reloaded.ok).toBe(true);
    if (!reloaded.ok) {
      throw new Error(reloaded.message);
    }

    fixture.scheduler.start();
    await until(
      () =>
        fixture.store.db
          .prepare<[bigint], { state: string }>('SELECT state FROM invocations WHERE id = ?')
          .get(invocationId)?.state === 'completed',
      'the invocation to finish',
    );
    const running = fixture.store.db
      .prepare<[bigint], { config_hash: string }>('SELECT config_hash FROM invocations WHERE id = ?')
      .get(invocationId);
    expect(running?.config_hash).toBe(reloaded.status.activeHash);
    expect(running?.config_hash).not.toBe(queued?.config_hash);
  } finally {
    await fixture.scheduler.stop();
    fixture.store.close();
  }
}, 30_000);

test('redacts secrets from reload errors and logs', async () => {
  const fixture = await setup({
    secrets: (keyJar) => {
      const secrets = new SecretStore(keyJar);
      secrets.remember('secret-prompt-name');
      return secrets;
    },
  });
  try {
    await fixture.patch((config) => {
      config.agent!.system_prompt_file = 'secret-prompt-name.md';
    });
    const result = await fixture.reloader.reloadFromFile();
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('Expected the missing prompt to fail');
    }
    expect(result.code).toBe('config_invalid');
    expect(result.message).toContain('[REDACTED]');
    expect(result.message).not.toContain('secret-prompt-name');
    expect(fixture.reloader.status().lastError?.message).not.toContain('secret-prompt-name');
    const failed = logEvents('config_reload_failed').at(-1);
    expect(String(failed?.error)).not.toContain('secret-prompt-name');
  } finally {
    fixture.store.close();
  }
});

test('a reloaded history_messages applies to new invocations only', async () => {
  const fixture = await setup({
    transform: (config) => {
      config.agent!.history_messages = 1;
    },
  });
  try {
    const start = Date.now();
    const historyCount = (invocationId: bigint): number =>
      Number(
        fixture.store.db
          .prepare<[bigint], { count: bigint }>(
            "SELECT COUNT(*) AS count FROM invocation_messages WHERE invocation_id = ? AND section = 'history'",
          )
          .get(invocationId)?.count ?? 0n,
      );
    fixture.ingestion.ingest(textUpdate(1, 10, 'm1'), new Date(start));
    fixture.ingestion.ingest(textUpdate(2, 11, 'm2'), new Date(start + 1_000));
    fixture.ingestion.ingest(textUpdate(3, 12, 'm3'), new Date(start + 2_000));
    const [first] = fixture.scheduler.processDue(new Date(start + 20_000));
    if (first === undefined) {
      throw new Error('Expected the first invocation');
    }
    expect(historyCount(first)).toBe(0);
    settle(fixture, first);

    fixture.ingestion.ingest(textUpdate(4, 13, 'm4'), new Date(start + 30_000));
    const [second] = fixture.scheduler.processDue(new Date(start + 50_000));
    if (second === undefined) {
      throw new Error('Expected the second invocation');
    }
    expect(historyCount(second)).toBe(1);
    settle(fixture, second);

    await fixture.patch((config) => {
      config.agent!.history_messages = 20;
    });
    const reloaded = await fixture.reloader.reloadFromFile();
    expect(reloaded.ok).toBe(true);
    if (!reloaded.ok) {
      throw new Error(reloaded.message);
    }
    expect(reloaded.applied).toEqual(['agent.history_messages']);
    // The invocation that was already queued keeps the history it snapshotted.
    expect(historyCount(second)).toBe(1);

    fixture.ingestion.ingest(textUpdate(5, 14, 'm5'), new Date(start + 60_000));
    const [third] = fixture.scheduler.processDue(new Date(start + 80_000));
    if (third === undefined) {
      throw new Error('Expected the third invocation');
    }
    expect(historyCount(third)).toBe(4);
  } finally {
    fixture.store.close();
  }
});

test('reports retention fields as outside serve, not as pending a restart', async () => {
  const fixture = await setup();
  try {
    await fixture.patch((config) => {
      config.retention.online_days = 7;
    });
    const result = await fixture.reloader.reloadFromFile();
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.message);
    }
    expect(result.applied).toEqual([]);
    expect(result.restartRequired).toEqual([]);
    expect(result.outsideServe).toEqual(['retention.online_days']);
    // Only fields `serve` never reads changed, so the file still becomes the
    // active configuration and both hashes agree.
    expect(result.status.generation).toBe(2);
    expect(result.status.activeHash).toBe(result.status.fileHash);
  } finally {
    fixture.store.close();
  }
});

test('a reload with no changes keeps the generation', async () => {
  const fixture = await setup();
  try {
    await fixture.patch(() => undefined);
    const result = await fixture.reloader.reloadFromFile();
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.message);
    }
    expect(result.applied).toEqual([]);
    expect(result.restartRequired).toEqual([]);
    expect(result.outsideServe).toEqual([]);
    expect(result.status.generation).toBe(1);
    expect(result.status.activeHash).toBe(result.status.fileHash);
  } finally {
    fixture.store.close();
  }
});
