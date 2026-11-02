import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { loginPanel, PASSWORD, panelFixture, runCli, USERNAME } from './fixtures.ts';

describe('surowan-utils panel pages', () => {
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

  it('downloads a room asset by the hexadecimal id the upload returned', async () => {
    const fixture = await panelFixture();
    try {
      await fetch(`${fixture.baseUrl}/api/auth/setup`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
      });
      await loginPanel(fixture);
      const created = await runCli(
        ['room', 'create', '--set', 'title=Asset room', '--set', 'request_key=cli-asset-room', '--json'],
        fixture,
      );
      expect(created.code, created.stderr).toBe(0);
      const roomId = (JSON.parse(created.stdout) as { room: { id: string } }).room.id;
      const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 7, g: 8, b: 9 } } })
        .png()
        .toBuffer();

      const uploaded = await runCli(
        [
          'room',
          'asset',
          'upload',
          roomId,
          '--set',
          'mime=image/png',
          '--set',
          `content_base64=${png.toString('base64')}`,
          '--json',
        ],
        fixture,
      );
      expect(uploaded.code, uploaded.stderr).toBe(0);
      const assetId = (JSON.parse(uploaded.stdout) as { asset_id: string }).asset_id;
      expect(assetId).toMatch(/^[0-9a-f]{32}$/);

      const target = join(fixture.home, 'asset.png');
      const content = await runCli(
        ['room', 'asset', 'content', roomId, assetId, '--output', target, '--json'],
        fixture,
      );
      expect(content.code, content.stderr).toBe(0);
      expect(await readFile(target)).toEqual(png);
    } finally {
      await fixture.close();
    }
  }, 60_000);
});
