import { expect, test } from 'vitest';
import { rewritePublicLinks } from '../scripts/docs/manual-links.ts';

/**
 * `rewritePublicLinks` follows CommonMark structure, not line shape: a link
 * label may wrap, a label or alt may contain inline code, and a code sample —
 * fenced in a list item or a quote, indented, or a span that wraps — must keep
 * its bytes. These are the forms that made a line-by-line rewrite either corrupt
 * a sample or abort the pack.
 */

test('rewrites a public link whose label wraps or carries inline code', () => {
  const page = [
    'Wrapped: [the complete',
    'configuration example](__DOCS_BASE__/examples/config.example.jsonc) works.',
    '',
    'Labelled: [`![inner](local.png)` compose](__DOCS_BASE__/examples/docker-compose.yml) works.',
    '',
    'Other: [the schema](__DOCS_BASE__/config.schema.json) keeps its label.',
    '',
  ].join('\n');
  expect(rewritePublicLinks(page, 'guides/installation.md')).toBe(
    [
      'Wrapped: [the complete',
      'configuration example](../examples/config.example.jsonc.md) works.',
      '',
      'Labelled: [`![inner](local.png)` compose](../examples/docker-compose.yml.md) works.',
      '',
      'Other: the schema keeps its label.',
      '',
    ].join('\n'),
  );
});

test('captions every image, including one with inline code in its alt', () => {
  const page = [
    'Image: ![see `code` here](__DOCS_BASE__/screenshots/admin/navigation.en.light.png)',
    '',
    'Linked: [![the shot](__DOCS_BASE__/screenshots/admin/navigation.en.light.png)](__DOCS_BASE__/examples/config.example.jsonc)',
    '',
    'Escaped: \\` then ![after the escape](__DOCS_BASE__/screenshots/admin/navigation.en.light.png) works.',
    '',
    'Empty: ![](local.png)',
    '',
  ].join('\n');
  expect(rewritePublicLinks(page, 'guides/models.md')).toBe(
    [
      'Image: (Screenshot: see code here)',
      '',
      'Linked: [(Screenshot: the shot)](../examples/config.example.jsonc.md)',
      '',
      'Escaped: \\` then (Screenshot: after the escape) works.',
      '',
      'Empty: (Screenshot)',
      '',
    ].join('\n'),
  );
});

test('resolves a reference-style link through its definition', () => {
  const page = [
    'Reference: [the example][ex] stays readable.',
    '',
    '[ex]: __DOCS_BASE__/examples/system-prompt.example.md',
    '',
  ].join('\n');
  expect(rewritePublicLinks(page, 'guides/first-persona.md')).toBe(
    ['Reference: [the example][ex] stays readable.', '', '[ex]: ../examples/system-prompt.example.md', ''].join('\n'),
  );
});

test('resolves an example from the manual root without a parent hop', () => {
  const page = '[the example](__DOCS_BASE__/examples/config.minimal.example.jsonc)\n';
  expect(rewritePublicLinks(page, 'index.md')).toBe('[the example](examples/config.minimal.example.jsonc.md)\n');
});

test('leaves every code form untouched', () => {
  const page = [
    'Span: `first',
    '![span sample](screenshots/local.png)',
    'last` stays code.',
    '',
    '    ![indented sample](screenshots/local.png)',
    '',
    '1. Step',
    '',
    '   - Nested',
    '',
    '     ```md',
    '     ![nested list fence sample](screenshots/local.png)',
    '     ```',
    '',
    '> ```md',
    '> ![quoted fence sample](screenshots/local.png)',
    '> ```',
    '',
    // A closing fence may only be followed by spaces or tabs, so the block runs
    // to the real fence and both samples stay code.
    '```md',
    '![nbsp sample](screenshots/local.png)',
    '```\u00a0',
    '![after the fake close](screenshots/local.png)',
    '```',
    '',
    // A public prefix inside code is a sample, not a reference to resolve.
    '```md',
    '[the example](__DOCS_BASE__/examples/config.example.jsonc)',
    '```',
    '',
  ].join('\n');
  expect(rewritePublicLinks(page, 'guides/tools.md')).toBe(page);
});

test('captions a reference-style image and drops its definition', () => {
  const page = [
    'Shot: ![the shot][nav]',
    '',
    '[nav]: __DOCS_BASE__/screenshots/admin/navigation.en.light.png',
    '',
  ].join('\n');
  // The definition only fed that image, so it leaves nothing behind for the
  // leftover check to trip over.
  expect(rewritePublicLinks(page, 'guides/admin.md')).toBe(['Shot: (Screenshot: the shot)', '', '', ''].join('\n'));
});

test('fails loudly when the prefix survives outside code', () => {
  const page = '<a href="__DOCS_BASE__/llms.txt">the index</a>\n';
  expect(() => rewritePublicLinks(page, 'guides/admin.md')).toThrow(
    'public-resource reference the pack cannot rewrite: guides/admin.md',
  );
});
