import { expect, test } from 'vitest';
import { nextEntryName } from '../../src/platform/keychain.ts';

test('a suffix scan terminates for long taken bases and yields a valid free name', async () => {
  const long64 = 'a'.repeat(64);
  const long63 = 'b'.repeat(63);
  const taken = new Set([long64, long63]);
  const from64 = nextEntryName(long64, taken);
  expect(from64.length).toBeLessThanOrEqual(64);
  expect(from64).not.toBe(long64);
  expect(taken.has(from64)).toBe(false);
  const from63 = nextEntryName(long63, taken);
  expect(from63.length).toBeLessThanOrEqual(64);
  expect(taken.has(from63)).toBe(false);
});
