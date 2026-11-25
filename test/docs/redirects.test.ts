import { expect, test } from 'vitest';
import { fieldPageMoves, LEGACY_FIELD_SLUGS, redirectRules } from '../../scripts/docs/redirects.ts';

test('legacy configuration field sections keep their redirects when the schema changes', () => {
  // The frozen list is what the pre-reorganization generator published; retiring or
  // renaming a section must not silently drop its published URL.
  expect(LEGACY_FIELD_SLUGS).toContain('models-dev');
  expect(LEGACY_FIELD_SLUGS).toContain('web-fetch');
  const rules = redirectRules('/');
  for (const slug of LEGACY_FIELD_SLUGS) {
    for (const suffix of ['', '.html', '.md']) {
      const from = `/docs/reference/fields-${slug}${suffix}`;
      expect(
        rules.some((rule) => rule.from === from),
        from,
      ).toBe(true);
    }
  }
});

test('a retired section falls back to the field reference index', () => {
  const moves = fieldPageMoves(new Set(['telegram']));
  expect(moves).toContainEqual(['reference/fields-telegram', 'configuration/fields-telegram']);
  expect(moves).toContainEqual(['reference/fields-mcp', 'configuration/fields']);
  // Every frozen slug still has a move, even when no page generates it.
  expect(moves.map(([from]) => from)).toEqual(LEGACY_FIELD_SLUGS.map((slug) => `reference/fields-${slug}`));
});

test('the field reference index itself stays a hand-written redirect', () => {
  const rules = redirectRules('/');
  expect(rules).toContainEqual({ from: '/docs/reference/fields', to: '/docs/configuration/fields' });
  expect(rules).toContainEqual({ from: '/docs/reference/fields.md', to: '/docs/configuration/fields.md' });
});
