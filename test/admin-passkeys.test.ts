import { readFile } from 'node:fs/promises';
import Database from 'better-sqlite3';
import { expect, test } from 'vitest';

test('032 migration preserves users and sessions with foreign keys enabled and permits password removal', async () => {
  const db = new Database(':memory:');
  try {
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(await readFile(new URL('../src/store/migrations/003_admin.sql', import.meta.url), 'utf8'));
    db.exec("INSERT INTO admin_users VALUES(42,'owner','old-hash','created','updated',NULL)");
    db.exec("INSERT INTO admin_sessions VALUES(9,42,'digest','created','expires','seen')");
    const sql = await readFile(new URL('../src/store/migrations/032_admin_passkeys.sql', import.meta.url), 'utf8');
    db.transaction(() => {
      db.exec(sql);
    }).immediate();
    expect(db.prepare('SELECT * FROM admin_sessions').get()).toMatchObject({
      id: 9,
      user_id: 42,
      token_hash: 'digest',
    });
    expect(db.prepare('SELECT * FROM admin_users').get()).toMatchObject({ id: 42, password_hash: 'old-hash' });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    db.exec('UPDATE admin_users SET password_hash = NULL');
    db.exec('DELETE FROM admin_users');
    expect(db.prepare('SELECT * FROM admin_sessions').all()).toEqual([]);
  } finally {
    db.close();
  }
});
