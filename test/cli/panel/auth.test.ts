import { describe, expect, it } from 'vitest';
import { errorCode, loginPanel, panelFixture, runCli } from './fixtures.ts';

describe('surowan-utils API key authorization', () => {
  it('no longer exposes account, session or API-key management commands', async () => {
    const fixture = await panelFixture();
    try {
      await loginPanel(fixture);
      for (const args of [
        ['setup', '--json'],
        ['session', 'show', '--json'],
        ['account', 'update', '--json'],
        ['passkey', 'list', '--json'],
        ['api-key', 'list', '--json'],
      ]) {
        const result = await runCli(args, fixture);
        expect(result.code, args.join(' ')).toBe(2);
        expect(errorCode(result), args.join(' ')).toBe('unknown_command');
      }
      const usernameLogin = await runCli(
        ['login', '--endpoint', fixture.baseUrl, '--username', 'owner', '--password', 'secret', '--json'],
        fixture,
      );
      expect(usernameLogin.code).toBe(2);
      expect(errorCode(usernameLogin)).toBe('invalid_arguments');
    } finally {
      await fixture.close();
    }
  }, 60_000);

  it('gates panel writes by the API key mode', async () => {
    const readFixture = await panelFixture();
    try {
      await loginPanel(readFixture, 'read');
      const readOnly = await runCli(['harness', 'show', '--json'], readFixture);
      expect(readOnly.code, readOnly.stderr).toBe(0);
      const denied = await runCli(
        ['harness', 'update', '--set-json', 'values.history_messages=17', '--json'],
        readFixture,
      );
      expect(denied.code).toBe(1);
      expect(errorCode(denied)).toBe('forbidden');
    } finally {
      await readFixture.close();
    }

    const writeFixture = await panelFixture();
    try {
      await loginPanel(writeFixture, 'read_write');
      const update = await runCli(
        ['harness', 'update', '--set-json', 'values.history_messages=18', '--json'],
        writeFixture,
      );
      expect(update.code, update.stderr).toBe(0);
    } finally {
      await writeFixture.close();
    }
  }, 60_000);
});
