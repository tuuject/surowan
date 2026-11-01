import { expect, test } from 'vitest';
import { CHAT_ID, setup } from './reload-fixtures.ts';

test('a failed publish hook reports publish_incomplete and the next unchanged apply retries it', async () => {
  let calls = 0;
  let failNext = false;
  const fixture = await setup({
    onPublished: () => {
      calls += 1;
      if (failNext) {
        failNext = false;
        throw new Error('context rebuild failed');
      }
    },
  });
  try {
    await fixture.patch((config) => {
      const chat = config.telegram.chats.find((entry) => entry.id === CHAT_ID);
      if (chat === undefined) {
        throw new Error('Missing fixture Chat');
      }
      chat.group_memory = { enabled: true };
    });
    failNext = true;
    const failed = await fixture.reloader.reloadFromFile();
    expect(failed).toMatchObject({ ok: false, code: 'publish_incomplete' });
    if (failed.ok) {
      throw new Error('Expected the publication to stay incomplete');
    }
    expect(failed.message).toContain('context rebuild failed');
    // The configuration is already active: the failure is not a refused candidate.
    expect(fixture.configStore.current().config.telegram.chats[0]?.group_memory).toEqual({ enabled: true });
    expect(fixture.reloader.status().lastError).toMatchObject({ code: 'publish_incomplete' });
    expect(calls).toBe(1);

    // Same file: without the pending flag this would take the unchanged early return.
    const retried = await fixture.reloader.reloadFromFile();
    expect(retried.ok).toBe(true);
    expect(calls).toBe(2);
    expect(fixture.reloader.status().lastError).toBeNull();

    // Once completed, an unchanged apply no longer reruns the hook.
    expect((await fixture.reloader.reloadFromFile()).ok).toBe(true);
    expect(calls).toBe(2);
  } finally {
    fixture.store.close();
  }
});
