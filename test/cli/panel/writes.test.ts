import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { errorCode, loginPanel, PASSWORD, panelFixture, runCli, storedSession, USERNAME } from './fixtures.ts';

describe('surowan-utils panel writes', () => {
  it('writes a real configuration field, discovering the revision itself', async () => {
    const fixture = await panelFixture();
    try {
      await fetch(`${fixture.baseUrl}/api/auth/setup`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
      });
      await loginPanel(fixture);

      const harness = await runCli(['harness', 'show', '--json'], fixture);
      expect(harness.code, harness.stderr).toBe(0);
      const before = JSON.parse(harness.stdout) as { saved: Record<string, number | boolean | null> };
      expect(before.saved.history_messages).toBeTypeOf('number');

      // `--output` only fits file and image responses; a JSON write that
      // carries it is refused before it can take effect.
      const unchanged = await readFile(fixture.configPath, 'utf8');
      const misplaced = await runCli(
        ['harness', 'update', '--set-json', 'values.history_messages=17', '--output', 'out.json', '--json'],
        fixture,
      );
      expect(misplaced.code).toBe(2);
      expect(errorCode(misplaced)).toBe('unexpected_option');
      expect(await readFile(fixture.configPath, 'utf8')).toBe(unchanged);

      const update = await runCli(['harness', 'update', '--set-json', 'values.history_messages=17', '--json'], fixture);
      expect(update.code, update.stderr).toBe(0);
      const after = JSON.parse(update.stdout) as { saved: Record<string, number | boolean | null>; apply: unknown };
      expect(after.saved.history_messages).toBe(17);
      expect(after.apply).toBeDefined();

      // The change is on disk, which is what the panel edits too.
      expect(await readFile(fixture.configPath, 'utf8')).toContain('"history_messages": 17');
    } finally {
      await fixture.close();
    }
  }, 60_000);

  it('sends the query of a write so it reaches the Chat it names', async () => {
    const fixture = await panelFixture();
    try {
      await fetch(`${fixture.baseUrl}/api/auth/setup`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
      });
      await loginPanel(fixture);

      // Without `chat` the server would change the global mode instead.
      const override = await runCli(
        ['dictionary', 'settings', 'update', '--chat', '123456789', '--set', 'injection_mode=off', '--json'],
        fixture,
      );
      expect(override.code, override.stderr).toBe(0);
      const settings = await runCli(['dictionary', 'settings', 'show', '--chat', '123456789', '--json'], fixture);
      expect(settings.code, settings.stderr).toBe(0);
      expect(JSON.parse(settings.stdout)).toMatchObject({ injection_mode: 'on_demand', override_mode: 'off' });

      // The group prompt route rejects a write without `chat`.
      const saved = await runCli(
        ['prompt', 'save', 'group', '--chat', '123456789', '--file', '-', '--json'],
        fixture,
        {},
        { stdin: 'Group rules from the cli.\n' },
      );
      expect(saved.code, saved.stderr).toBe(0);
      expect(JSON.parse(saved.stdout)).toMatchObject({ status: 'saved' });
      const prompt = await runCli(['prompt', 'get', 'group', '--chat', '123456789', '--json'], fixture);
      expect(prompt.code, prompt.stderr).toBe(0);
      expect(JSON.parse(prompt.stdout)).toMatchObject({ prompt: 'Group rules from the cli.\n' });
    } finally {
      await fixture.close();
    }
  }, 60_000);

  it('refuses destructive and billed actions without --yes, and never sends them', async () => {
    const fixture = await panelFixture();
    try {
      await fetch(`${fixture.baseUrl}/api/auth/setup`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
      });
      await loginPanel(fixture);

      const restart = await runCli(['restart', '--json'], fixture);
      expect(restart.code).toBe(2);
      expect(errorCode(restart)).toBe('confirmation_required');

      const cancel = await runCli(['session', 'cancel', '--json'], fixture);
      expect(cancel.code).toBe(2);
      expect(errorCode(cancel)).toBe('confirmation_required');

      const health = await runCli(
        ['provider', 'health-check', '--set', 'provider=agent', '--set', 'model=agent-model', '--json'],
        fixture,
      );
      expect(health.code).toBe(2);
      expect(errorCode(health)).toBe('confirmation_required');
    } finally {
      await fixture.close();
    }
  }, 60_000);

  it('shows the request instead of sending it with --dry-run', async () => {
    const fixture = await panelFixture();
    try {
      await fetch(`${fixture.baseUrl}/api/auth/setup`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
      });
      await loginPanel(fixture);
      const dry = await runCli(['chat', 'delete', '123', '--dry-run', '--json'], fixture);
      expect(dry.code, dry.stderr).toBe(0);
      expect(JSON.parse(dry.stdout)).toMatchObject({
        method: 'DELETE',
        path: '/api/chats/123',
        if_match: null,
        if_match_source: 'config',
      });
      // A dry run sends nothing, including the revision lookup.
      const configStatus = await runCli(['config', 'status', '--json'], fixture);
      expect(configStatus.code, configStatus.stderr).toBe(0);
      // Nothing was written: the Chat was never configured, so a real DELETE
      // would have failed with 404.
      const chats = await runCli(['chat', 'list', '--json'], fixture);
      expect(chats.code, chats.stderr).toBe(0);
    } finally {
      await fixture.close();
    }
  }, 60_000);

  it('lists every panel command and rejects an unknown one before any request', async () => {
    const fixture = await panelFixture();
    try {
      // `commands` needs no credential; the dispatch assertions below do.
      await fetch(`${fixture.baseUrl}/api/auth/setup`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
      });
      await loginPanel(fixture);
      const listed = await runCli(['commands', '--json'], fixture);
      expect(listed.code, listed.stderr).toBe(0);
      const entries = JSON.parse(listed.stdout) as readonly { command: string; revision: string | null }[];
      const commands = entries.map((entry) => entry.command);
      for (const expected of [
        'harness update',
        'chat create',
        'prompt save',
        'provider create',
        'dictionary create',
        'search update',
        'image config update',
        'telegram token',
        'room release',
        'api-key create',
      ]) {
        expect(commands).toContain(expected);
      }
      expect(entries.find((entry) => entry.command === 'chat create')?.revision).toBe('config');

      const unknown = await runCli(['chat', 'destory', '1'], fixture);
      expect(unknown.code).toBe(2);
      expect(errorCode(unknown)).toBe('unknown_command');
      expect(unknown.stderr).toContain('chat delete');

      // `config` and `prompt` are first-class groups *and* panel command
      // prefixes: the panel route wins only where a row exists, so the read
      // commands keep their old behavior.
      const configShow = await runCli(['config', 'show', '--json'], fixture);
      expect(configShow.code, configShow.stderr).toBe(0);
      const promptGet = await runCli(['prompt', 'get', 'global', '--json'], fixture);
      expect(promptGet.code, promptGet.stderr).toBe(0);
      const badScope = await runCli(['prompt', 'save', 'bogus', '--set', 'prompt=x'], fixture);
      expect(badScope.code).toBe(2);
      expect(errorCode(badScope)).toBe('invalid_scope');
      // A flag the route does not declare is rejected, including booleans.
      const strayBoolean = await runCli(['chat', 'list', '--confirm-paid'], fixture);
      expect(strayBoolean.code).toBe(2);
      expect(errorCode(strayBoolean)).toBe('unexpected_option');
      // Global credential flags are consumed, never treated as route params.
      const viaFlag = await runCli(
        ['overview', '--json', '--session', storedSession(fixture), '--endpoint', fixture.baseUrl],
        fixture,
      );
      expect(viaFlag.code, viaFlag.stderr).toBe(0);
    } finally {
      await fixture.close();
    }
  }, 60_000);

  it('restores a group prompt version, discovering its Chat and hash itself', async () => {
    const fixture = await panelFixture();
    try {
      await fetch(`${fixture.baseUrl}/api/auth/setup`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
      });
      await loginPanel(fixture);
      for (const text of ['First group rules.\n', 'Second group rules.\n']) {
        const saved = await runCli(
          ['prompt', 'save', 'group', '--chat', '123456789', '--file', '-', '--json'],
          fixture,
          {},
          { stdin: text },
        );
        expect(saved.code, saved.stderr).toBe(0);
      }
      const versions = await runCli(
        ['prompt', 'versions', '--scope', 'group', '--chat', '123456789', '--json'],
        fixture,
      );
      expect(versions.code, versions.stderr).toBe(0);
      const items = (JSON.parse(versions.stdout) as { items: readonly { id: string }[] }).items;
      const older = items.at(-1)?.id ?? '';
      const shown = await runCli(['prompt', 'version', 'show', older, '--json'], fixture);
      const content = (JSON.parse(shown.stdout) as { content: string }).content;

      // The version knows its Chat; `prompt restore` takes no --chat flag.
      const restored = await runCli(['prompt', 'restore', older, '--json'], fixture);
      expect(restored.code, restored.stderr).toBe(0);
      expect(JSON.parse(restored.stdout)).toMatchObject({ status: 'saved' });
      const prompt = await runCli(['prompt', 'get', 'group', '--chat', '123456789', '--json'], fixture);
      expect(JSON.parse(prompt.stdout)).toMatchObject({ prompt: content });
    } finally {
      await fixture.close();
    }
  }, 60_000);
});
