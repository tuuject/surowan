/**
 * Readonly document spaces the model reads on demand.
 *
 * A space is a logical namespace with a stable id (the bundled `manual` today,
 * a per-user wiki later); the model never learns where its files live. Path
 * validation, size limits, and error codes live here so every implementation
 * shares one boundary: paths stay inside their space, only Markdown documents
 * exist, and reads are bounded.
 */

export const DOC_PATH_MAX_LENGTH = 512;
export const DOC_READ_MAX_BYTES = 32_768;
export const DOC_SPACE_ID_PATTERN = '^[a-z][a-z0-9-]{0,31}$';
/** The generated Markdown index that makes a space discoverable without RAG. */
export const DOC_INDEX_PATH = 'index.md';

const SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export type DocSpaceErrorCode = 'invalid_path' | 'unknown_space' | 'document_not_found' | 'unsupported_document';

export class DocSpaceError extends Error {
  readonly code: DocSpaceErrorCode;

  constructor(code: DocSpaceErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * Caller identity for space resolution. The document tools never accept an
 * owner id from the model: the runtime supplies this context, so a future
 * per-user wiki can resolve ownership and access from the live conversation
 * instead of trusting a tool argument.
 */
export interface DocAccessContext {
  readonly conversationId: bigint;
  readonly chatId: bigint;
}

export interface DocSpaceSummary {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  /** Number of readable Markdown pages, excluding the space's own index. */
  readonly documents: number;
}

export interface DocText {
  readonly space: string;
  /** Space-relative path of the document that was read. */
  readonly path: string;
  readonly text: string;
  readonly truncated: boolean;
}

export interface DocSpaces {
  /** Spaces this caller may read, in stable order; empty when none are installed. */
  spaces(context: DocAccessContext): Promise<readonly DocSpaceSummary[]>;
  /** The space's own index document: the compact entry point for `read`. */
  index(context: DocAccessContext, space: string): Promise<DocText>;
  /** One Markdown document, addressed by space-relative path or by a link plus its base. */
  read(context: DocAccessContext, space: string, path: string, base?: string): Promise<DocText>;
}

/**
 * Normalizes a document path to path segments inside one space root.
 *
 * `path` is always space-relative: absolute paths, drive letters, backslashes,
 * percent escapes, and empty segments are rejected outright. A `base` document
 * path enables link resolution — `..` may climb within the space but never past
 * its root, and a `#fragment` names a heading, not a file, so it is dropped
 * (a fragment-only link resolves to the base document itself). Only Markdown
 * documents are addressable.
 */
export function resolveDocPath(link: string, base?: string): readonly string[] {
  if (
    link.length === 0 ||
    link.length > DOC_PATH_MAX_LENGTH ||
    (base !== undefined && (base.length === 0 || base.length > DOC_PATH_MAX_LENGTH))
  ) {
    throw new DocSpaceError('invalid_path', 'Document path exceeds the length limit');
  }
  const fragment = link.indexOf('#');
  const path = fragment === -1 ? link : link.slice(0, fragment);
  if (path.length === 0) {
    if (base === undefined) {
      throw new DocSpaceError('invalid_path', 'A fragment-only link needs the base document it belongs to');
    }
    return resolveDocPath(base);
  }
  const segments: string[] = [];
  if (base === undefined) {
    if (path.startsWith('/')) {
      throw new DocSpaceError('invalid_path', 'Document paths are space-relative; absolute paths are not readable');
    }
  } else {
    const baseSegments = base.split('/');
    for (const segment of baseSegments) {
      if (!SEGMENT_PATTERN.test(segment)) {
        throw new DocSpaceError('invalid_path', 'Base document path contains an invalid path segment');
      }
    }
    if (!(baseSegments[baseSegments.length - 1] ?? '').endsWith('.md')) {
      throw new DocSpaceError('unsupported_document', 'Only .md documents exist');
    }
    for (const segment of baseSegments.slice(0, -1)) {
      segments.push(segment);
    }
  }
  for (const segment of path.split('/')) {
    if (segment === '.') {
      continue;
    }
    if (segment === '..') {
      if (base === undefined || segments.pop() === undefined) {
        throw new DocSpaceError('invalid_path', 'Document path escapes the space root');
      }
      continue;
    }
    if (segment.length === 0) {
      throw new DocSpaceError('invalid_path', 'Document path contains an empty path segment');
    }
    if (!SEGMENT_PATTERN.test(segment)) {
      throw new DocSpaceError('invalid_path', `Document path contains an invalid path segment: ${segment}`);
    }
    segments.push(segment);
  }
  const filename = segments[segments.length - 1];
  if (filename === undefined) {
    throw new DocSpaceError('invalid_path', 'Document path is empty');
  }
  if (!filename.endsWith('.md')) {
    throw new DocSpaceError('unsupported_document', 'Only .md documents inside a space exist');
  }
  return segments;
}

/** The compact space list the model sees before it chooses a space to read. */
export function renderDocSpaceList(spaces: readonly DocSpaceSummary[]): string {
  if (spaces.length === 0) {
    return 'No document spaces are installed in this runtime.';
  }
  return [
    'Document spaces available to you (readonly):',
    ...spaces.map(
      (space) => `- ${space.id}: ${space.title} — ${space.description} (${space.documents} markdown documents)`,
    ),
    'Call list_documents again with a space id to get its index, then read_document with a space and one document path.',
  ].join('\n');
}

/** No spaces are installed; preserve the uninstalled space's missing behavior. */
export function emptyDocSpaces(): DocSpaces {
  const unknown = (space: string): never => {
    throw new DocSpaceError('unknown_space', `No such document space: ${space}`);
  };
  return {
    async spaces(): Promise<readonly DocSpaceSummary[]> {
      return [];
    },
    async index(_context: DocAccessContext, space: string): Promise<DocText> {
      return unknown(space);
    },
    async read(_context: DocAccessContext, space: string, _path: string, _base?: string): Promise<DocText> {
      return unknown(space);
    },
  };
}
