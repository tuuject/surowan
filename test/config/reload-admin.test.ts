import { expect, test } from 'vitest';
import { chmod } from 'node:fs/promises';
import { readConfigRevision } from '../../src/adapters/local-monolith/config/file.ts';
import { setup } from './reload-fixtures.ts';

test('rejects a configuration file that is not 0600 or whose directory is not 0700', async () => {
  if (process.platform === 'win32') {
    return;
  }
  const fixture = await setup();
  const before = fixture.configStore.current();
  try {
    await chmod(fixture.configPath, 0o644);
    const fileResult = await fixture.reloader.reloadFromFile();
    expect(fileResult.ok).toBe(false);
    if (fileResult.ok) {
      throw new Error('Expected the file mode to be rejected');
    }
    expect(fileResult.code).toBe('config_permissions');
    expect(fixture.configStore.current()).toBe(before);

    await chmod(fixture.configPath, 0o600);
    await chmod(fixture.directory, 0o755);
    const directoryResult = await fixture.reloader.reloadFromFile();
    expect(directoryResult.ok).toBe(false);
    if (directoryResult.ok) {
      throw new Error('Expected the directory mode to be rejected');
    }
    expect(directoryResult.code).toBe('config_permissions');
  } finally {
    await chmod(fixture.directory, 0o700).catch(() => undefined);
    await chmod(fixture.configPath, 0o600).catch(() => undefined);
    fixture.store.close();
  }
});

test('a write with a stale revision is refused and leaves the file unchanged', async () => {
  const fixture = await setup();
  try {
    const revision = await readConfigRevision(fixture.configPath);
    const before = await fixture.readText();

    const stale = await fixture.reloader.writeAndApply(
      [{ path: ['agent', 'thinking_level'], value: 'high' }],
      'f'.repeat(64),
    );
    expect(stale.ok).toBe(false);
    if (stale.ok) {
      throw new Error('Expected the stale revision to be refused');
    }
    expect(stale.code).toBe('config_conflict');
    expect(await fixture.readText()).toBe(before);
    expect(fixture.configStore.current().config.agent!.thinking_level).toBe('low');

    const applied = await fixture.reloader.writeAndApply(
      [{ path: ['agent', 'thinking_level'], value: 'high' }],
      revision,
    );
    expect(applied.ok).toBe(true);
    if (!applied.ok) {
      throw new Error(applied.message);
    }
    expect(applied.applied).toEqual(['agent.thinking_level']);
    expect(fixture.configStore.current().config.agent!.thinking_level).toBe('high');
    // Leaf edits keep the comments the test configuration was written with.
    expect(await fixture.readText()).toBe(before.replace('"thinking_level": "low"', '"thinking_level": "high"'));
  } finally {
    fixture.store.close();
  }
});
