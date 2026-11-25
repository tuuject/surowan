/**
 * Rewrites a page for the packed manual: what resolves only on the published
 * site becomes what the runtime can serve.
 *
 * Examples point at their packed pages, every image becomes its caption (the
 * offline manual is text-only), and other public resources (JSON Schema,
 * `llms.txt`) keep their label but lose the link.
 *
 * The page is parsed as CommonMark and only `image`, `imageReference`, `link`,
 * `linkReference` and `definition` nodes are rewritten, by their source
 * positions. Everything the parser classifies as code — a fence in a list item
 * or a quote, an indented block, a span that wraps — is never touched, and
 * neither is raw HTML. A `__DOCS_BASE__` that survives outside code (an
 * `<a href>`, for example) fails the pack loudly.
 */
import { posix } from 'node:path';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { exampleNames } from './prepare.ts';

/** Prefix the site build swaps for its public base path; the runtime has no site to link to. */
const PUBLIC_PREFIX = '__DOCS_BASE__/';

type MarkdownTree = ReturnType<typeof fromMarkdown>;
type MarkdownNode = MarkdownTree['children'][number];
type ExampleName = (typeof exampleNames)[number];

/** One replacement of `[start, end)` in the source text. */
interface Edit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/** The packed page that quotes one downloadable example verbatim. */
export function packedExamplePath(name: ExampleName): string {
  return `examples/${name.endsWith('.md') ? name : `${name}.md`}`;
}

function childrenOf(node: MarkdownNode): readonly MarkdownNode[] {
  return 'children' in node ? node.children : [];
}

function offsets(node: MarkdownNode): Edit | undefined {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  return start === undefined || end === undefined ? undefined : { start, end, text: '' };
}

/** Every node of the tree, depth first, parents before children. */
function walk(node: MarkdownNode, visit: (node: MarkdownNode) => void): void {
  visit(node);
  for (const child of childrenOf(node)) {
    walk(child, visit);
  }
}

/** The same walk over a parsed document; the root itself carries no span. */
function walkTree(tree: MarkdownTree, visit: (node: MarkdownNode) => void): void {
  for (const child of tree.children) {
    walk(child, visit);
  }
}

/** Applies non-overlapping edits; when two nest, the outer one wins. */
function applyEdits(text: string, edits: readonly Edit[]): string {
  const ordered = [...edits].sort((left, right) => left.start - right.start || right.end - left.end);
  const parts: string[] = [];
  let cursor = 0;
  for (const edit of ordered) {
    if (edit.start < cursor) {
      continue;
    }
    parts.push(text.slice(cursor, edit.start), edit.text);
    cursor = edit.end;
  }
  parts.push(text.slice(cursor));
  return parts.join('');
}

/** `(Screenshot: alt)`, the caption the offline manual keeps instead of a picture. */
function caption(alt: string | null | undefined): string {
  const text = (alt ?? '').trim();
  return text.length === 0 ? '(Screenshot)' : `(Screenshot: ${text})`;
}

/** The source text of a link label, so inline code and a wrapped label survive. */
function rawLabel(node: MarkdownNode, text: string): string {
  const [first, ...rest] = childrenOf(node);
  const last = rest.at(-1) ?? first;
  const start = first === undefined ? undefined : offsets(first);
  const end = last === undefined ? undefined : offsets(last);
  return start === undefined || end === undefined ? '' : text.slice(start.start, end.end);
}

function captionEdits(text: string): Edit[] {
  const edits: Edit[] = [];
  walkTree(fromMarkdown(text), (node) => {
    if (node.type !== 'image' && node.type !== 'imageReference') {
      return;
    }
    const span = offsets(node);
    if (span !== undefined) {
      edits.push({ ...span, text: caption(node.alt) });
    }
  });
  return edits;
}

function linkEdits(text: string, pagePath: string): Edit[] {
  const tree = fromMarkdown(text);
  /** Definitions by normalized identifier, with the raw label to rebuild them. */
  const definitions = new Map<string, { readonly url: string; readonly label: string }>();
  walkTree(tree, (node) => {
    if (node.type === 'definition') {
      definitions.set(node.identifier, { url: node.url, label: node.label ?? node.identifier });
    }
  });

  const isPublic = (url: string): boolean => url.startsWith(PUBLIC_PREFIX);
  const exampleOf = (url: string): ExampleName | undefined =>
    exampleNames.find((name) => url === `${PUBLIC_PREFIX}examples/${name}`);
  const relativeTo = (name: ExampleName): string => posix.relative(posix.dirname(pagePath), packedExamplePath(name));
  const exampleLink = (label: string, name: ExampleName): string => `[${label}](${relativeTo(name)})`;

  const edits: Edit[] = [];
  walkTree(tree, (node) => {
    const span = offsets(node);
    if (span === undefined) {
      return;
    }
    if (node.type === 'link' && isPublic(node.url)) {
      const example = exampleOf(node.url);
      // Without a packed page the label stays and the reference becomes plain
      // text; a prefix that still survives anywhere then fails the pack.
      edits.push({
        ...span,
        text: example === undefined ? rawLabel(node, text) : exampleLink(rawLabel(node, text), example),
      });
      return;
    }
    if (node.type === 'linkReference') {
      const definition = definitions.get(node.identifier);
      if (definition === undefined || !isPublic(definition.url)) {
        return;
      }
      // An example's definition is rewritten in place, so the reference stays as
      // it is; any other public definition is dropped, so the prose keeps the label.
      if (exampleOf(definition.url) === undefined) {
        edits.push({ ...span, text: rawLabel(node, text) });
      }
      return;
    }
    if (node.type === 'definition' && isPublic(node.url)) {
      const example = exampleOf(node.url);
      edits.push({
        ...span,
        text: example === undefined ? '' : `[${node.label ?? node.identifier}]: ${relativeTo(example)}`,
      });
    }
  });
  return edits;
}

/** Source offsets of every code node: the only place the public prefix may stay. */
function codeSpans(text: string): Edit[] {
  const spans: Edit[] = [];
  walkTree(fromMarkdown(text), (node) => {
    if (node.type !== 'code' && node.type !== 'inlineCode') {
      return;
    }
    const span = offsets(node);
    if (span !== undefined) {
      spans.push(span);
    }
  });
  return spans;
}

/** Fails when the public prefix survives anywhere a reader would treat as prose. */
function assertNoPublicPrefix(text: string, pagePath: string): void {
  const spans = codeSpans(text);
  const insideCode = (offset: number): boolean => spans.some((span) => offset >= span.start && offset < span.end);
  for (let index = text.indexOf(PUBLIC_PREFIX); index !== -1; index = text.indexOf(PUBLIC_PREFIX, index + 1)) {
    if (!insideCode(index)) {
      throw new Error(`Manual page has a public-resource reference the pack cannot rewrite: ${pagePath}`);
    }
  }
}

/** Rewrites the public references of one page; throws when one cannot be rewritten. */
export function rewritePublicLinks(text: string, pagePath: string): string {
  // Nothing an image or a public link needs: keep the bytes and skip the parse.
  // Every image starts with `![`, so this cannot hide one.
  if (!text.includes('![') && !text.includes(PUBLIC_PREFIX)) {
    return text;
  }
  // Images first: an image inside a link label must already be a caption when
  // the label is sliced for the link's replacement.
  const captioned = applyEdits(text, captionEdits(text));
  const rewritten = applyEdits(captioned, linkEdits(captioned, pagePath));
  assertNoPublicPrefix(rewritten, pagePath);
  return rewritten;
}
