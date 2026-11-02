import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { errorCode, loginPanel, PASSWORD, panelFixture, runCli, storedSession, USERNAME } from './panel-fixtures.ts';

describe('surowan-utils panel surface', () => {
  it('creates the first administrator from the CLI without any stored credential', async () => {
    const fixture = await panelFixture();
    try {
      const fresh = await runCli(['session', 'show', '--endpoint', fixture.baseUrl, '--json'], fixture);
      expect(fresh.code, fresh.stderr).toBe(0);
      expect(JSON.parse(fresh.stdout)).toMatchObject({ setup_required: true, authenticated: false });

      const setup = await runCli(
        ['setup', '--endpoint', fixture.baseUrl, '--file', '-', '--json'],
        fixture,
        {},
        { stdin: JSON.stringify({ username: USERNAME, password: PASSWORD }) },
      );
      expect(setup.code, setup.stderr).toBe(0);
      // The setup route rotates in a session like any login, so it is stored.
      expect(storedSession(fixture).length).toBeGreaterThan(0);

      const after = await runCli(['session', 'show', '--json'], fixture);
      expect(after.code, after.stderr).toBe(0);
      expect(JSON.parse(after.stdout)).toMatchObject({ setup_required: false, authenticated: true });

      // One credentials file, one credential kind: mixing them is refused.
      const mixed = await runCli(
        ['login', '--endpoint', fixture.baseUrl, '--username', USERNAME, '--password', PASSWORD],
        fixture,
        { SUROWAN_API_KEY: 'pwk_synthetic' },
      );
      expect(mixed.code).toBe(2);
      expect(errorCode(mixed)).toBe('conflicting_credentials');
    } finally {
      await fixture.close();
    }
  }, 60_000);

  it('logs in with the panel password and reads a session-only audit page', async () => {
    const fixture = await panelFixture();
    try {
      const setup = await fetch(`${fixture.baseUrl}/api/auth/setup`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
      });
      expect(setup.status).toBe(200);
      await loginPanel(fixture);

      const overview = await runCli(['overview', '--json'], fixture);
      expect(overview.code, overview.stderr).toBe(0);
      expect(JSON.parse(overview.stdout)).toMatchObject({ runtime_status: { sleeping: false } });

      // The saved credential is a session token, not an API key.
      const stored = JSON.parse(
        await readFile(join(fixture.home, '.config', 'surowan-utils', 'credentials.json'), 'utf8'),
      );
      expect(Object.keys(stored).sort()).toEqual(['endpoint', 'session']);
      expect(overview.stdout).not.toContain(stored.session);
    } finally {
      await fixture.close();
    }
  }, 60_000);

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

  it('keeps API keys on the narrow surface and refuses panel writes with one', async () => {
    const fixture = await panelFixture();
    try {
      const setup = await fetch(`${fixture.baseUrl}/api/auth/setup`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
      });
      const cookie = setup.headers.getSetCookie()[0] ?? '';
      const created = await fetch(`${fixture.baseUrl}/api/api-keys`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ name: 'cli' }),
      });
      const key = (await created.json()) as { key: string };

      const env = { SUROWAN_ENDPOINT: fixture.baseUrl, SUROWAN_API_KEY: key.key };
      const harness = await runCli(['harness', 'show', '--json'], fixture, env);
      expect(harness.code).toBe(1);
      expect(errorCode(harness)).toBe('forbidden');

      // The same key still reaches the inspection allowlist it was issued for.
      const models = await runCli(['models', 'list', '--json'], fixture, env);
      expect(models.code, models.stderr).toBe(0);
    } finally {
      await fixture.close();
    }
  }, 60_000);

  it('persists the rotated session after a credential change and clears it on logout', async () => {
    const fixture = await panelFixture();
    try {
      const setup = await fetch(`${fixture.baseUrl}/api/auth/setup`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
      });
      expect(setup.status).toBe(200);
      await loginPanel(fixture);
      const storedPath = join(fixture.home, '.config', 'surowan-utils', 'credentials.json');
      const first = JSON.parse(await readFile(storedPath, 'utf8')) as { session: string };

      // Changing the password revokes every session and issues a new token.
      const changed = await runCli(
        ['account', 'update', '--set', `username=${USERNAME}`, '--set', `password=${'{{SECRET_9hgm2vkd}}'}`, '--json'],
        fixture,
      );
      expect(changed.code, changed.stderr).toBe(0);
      const second = JSON.parse(await readFile(storedPath, 'utf8')) as { session: string };
      expect(second.session).not.toBe(first.session);
      expect(changed.stdout).not.toContain(second.session);

      // The new token is the one that works; the old one is dead.
      const overview = await runCli(['overview', '--json'], fixture);
      expect(overview.code, overview.stderr).toBe(0);
      const stale = await runCli(['overview', '--json'], fixture, { SUROWAN_SESSION: first.session });
      expect(stale.code).toBe(1);
      expect(errorCode(stale)).toBe('unauthenticated');

      const logout = await runCli(['logout', '--json'], fixture);
      expect(logout.code, logout.stderr).toBe(0);
      await expect(readFile(storedPath, 'utf8')).rejects.toThrow();
    } finally {
      await fixture.close();
    }
  }, 60_000);

  it('creates a playground room and sends a message through the same routes the page uses', async () => {
    const fixture = await panelFixture();
    try {
      await fetch(`${fixture.baseUrl}/api/auth/setup`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
      });
      await loginPanel(fixture);

      const created = await runCli(
        [
          'room',
          'create',
          '--set',
          'title=CLI room',
          '--set',
          'request_key=cli-room-1',
          '--set-json',
          'members=[{"name":"alice","role":"member"}]',
          '--json',
        ],
        fixture,
      );
      expect(created.code, created.stderr).toBe(0);
      const room = JSON.parse(created.stdout) as {
        room: { id: string; hold: boolean; latest_input_seq: string };
      };
      expect(room.room.hold).toBe(true);
      expect(room.room.latest_input_seq).toBe('0');

      const detail = await runCli(['room', 'show', room.room.id, '--json'], fixture);
      expect(detail.code, detail.stderr).toBe(0);
      const participants = (JSON.parse(detail.stdout) as { participants: readonly { id: string; name: string }[] })
        .participants;
      const alice = participants.find((entry) => entry.name === 'alice');
      expect(alice).toBeDefined();

      const sent = await runCli(
        [
          'room',
          'send',
          room.room.id,
          '--set',
          'request_key=cli-message-1',
          '--set',
          `sender_id=${alice?.id ?? ''}`,
          '--set',
          'text=hello from the cli',
          '--json',
        ],
        fixture,
      );
      expect(sent.code, sent.stderr).toBe(0);
      // `admitted` reports that the room accepted the input; with the hold on
      // it stays held until a Release seals it.
      const admitted = JSON.parse(sent.stdout) as { seq: string; admitted: boolean };
      expect(admitted.admitted).toBe(true);
      expect(admitted.seq).toBe('1');

      const messages = await runCli(['room', 'messages', room.room.id, '--json'], fixture);
      expect(messages.code, messages.stderr).toBe(0);
      expect(JSON.parse(messages.stdout)).toMatchObject({
        items: [expect.objectContaining({ text: 'hello from the cli', input_state: 'held' })],
      });
    } finally {
      await fixture.close();
    }
  }, 60_000);

  it('reads and writes memories, and exports the dictionary as text', async () => {
    const fixture = await panelFixture();
    try {
      await fetch(`${fixture.baseUrl}/api/auth/setup`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
      });
      await loginPanel(fixture);

      // A memo needs an existing `chats` row, not merely a configured Chat:
      // the panel's Chat dropdown is fed by the same stored rows.
      fixture.store.db
        .prepare(
          'INSERT INTO chats (host_kind, telegram_chat_id, canonical_chat_id, type, title, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run('telegram', 123456789n, 123456789n, 'group', 'Fixture chat', new Date().toISOString());
      const chats = await runCli(['memo', 'chats', '--json'], fixture);
      expect(chats.code, chats.stderr).toBe(0);
      const items = (JSON.parse(chats.stdout) as { items: readonly { telegram_chat_id: string }[] }).items;
      const chatId = items[0]?.telegram_chat_id;
      expect(chatId).toBeDefined();

      const created = await runCli(
        [
          'memo',
          'create',
          '--set',
          `chat_id=${chatId ?? ''}`,
          '--set',
          'summary=cli memo',
          '--set',
          'detail=body',
          '--json',
        ],
        fixture,
      );
      expect(created.code, created.stderr).toBe(0);
      const memo = JSON.parse(created.stdout) as { id: string; ttl_seconds: number | null };
      expect(memo.ttl_seconds).toBeNull();

      const updated = await runCli(['memo', 'update', memo.id, '--set', 'summary=cli memo edited', '--json'], fixture);
      expect(updated.code, updated.stderr).toBe(0);
      expect(JSON.parse(updated.stdout)).toMatchObject({ summary: 'cli memo edited' });

      const removed = await runCli(['memo', 'delete', memo.id, '--yes', '--json'], fixture);
      expect(removed.code, removed.stderr).toBe(0);

      // A prompt is a raw document, not JSON: `--file` fills the prompt field.
      const saved = await runCli(
        ['prompt', 'save', 'global', '--file', '-', '--set', 'note=cli edit', '--json'],
        fixture,
        {},
        { stdin: 'You are a concise assistant.\n' },
      );
      expect(saved.code, saved.stderr).toBe(0);
      expect(JSON.parse(saved.stdout)).toMatchObject({ status: 'saved' });
      const prompt = await runCli(['prompt', 'get', 'global', '--json'], fixture);
      expect(prompt.code, prompt.stderr).toBe(0);
      expect(JSON.parse(prompt.stdout)).toMatchObject({ prompt: 'You are a concise assistant.\n' });

      // The dictionary export is a file body, not JSON.
      const exported = await runCli(['dictionary', 'export', '--scope', 'global', '--format', 'jsonl'], fixture);
      expect(exported.code, exported.stderr).toBe(0);
      expect(exported.stdout.trim()).toBe('');
      // `--json` still yields exactly one JSON document for a text body.
      const asJson = await runCli(
        ['dictionary', 'export', '--scope', 'global', '--format', 'jsonl', '--json'],
        fixture,
      );
      expect(asJson.code, asJson.stderr).toBe(0);
      expect(() => JSON.parse(asJson.stdout)).not.toThrow();
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
});
