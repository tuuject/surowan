import { expect, test } from 'vitest';
import { keychainPath, readKeychain, updateKeychain } from '../../src/platform/keychain.ts';
import { CHAT_ID, setup } from '../config/reload-fixtures.ts';

test('the mis-delete regression: a config write keeps image credential entries even when the image section is invalid', async () => {
  const fixture = await setup({
    transform: (config) => {
      // The image section is structurally invalid (`models` must be an array), so
      // loading strips it from the validated configuration while the file keeps it.
      (config as Record<string, unknown>).image = {
        credentials: { openrouter: { jar: 'image-credential' } },
        models: 'not-an-array',
      };
    },
  });
  const jar = keychainPath(fixture.configPath);
  try {
    await updateKeychain(jar, { add: { 'image-credential': 'image-secret' } });
    // An unrelated member write (/ignoreme) runs the ordinary write path.
    const result = await fixture.reloader.setChatUserIgnored(CHAT_ID, 42n, true);
    expect(result.ok).toBe(true);
    const after = await readKeychain(jar);
    expect(after?.['image-credential']?.value).toBe('image-secret');
  } finally {
    fixture.store.close();
  }
});

test('removing the last reference of an entry no longer reclaims it', async () => {
  const fixture = await setup();
  const jar = keychainPath(fixture.configPath);
  try {
    expect((await readKeychain(jar))?.faux?.value).toBe('faux-secret');
    // Point the faux provider at another existing entry, dropping the only
    // reference the configuration carried for `faux`.
    const result = await fixture.reloader.writeAndApply([
      { path: ['providers', 'faux', 'api_key'], value: { jar: 'key-a' } },
    ]);
    expect(result.ok).toBe(true);
    expect((await readKeychain(jar))?.faux?.value).toBe('faux-secret');
  } finally {
    fixture.store.close();
  }
});
