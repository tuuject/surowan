import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import {
  DOC_INDEX_PATH,
  DOC_READ_MAX_BYTES,
  DOC_SPACE_ID_PATTERN,
  type DocAccessContext,
  DocSpaceError,
  type DocSpaceSummary,
  type DocSpaces,
  type DocText,
  resolveDocPath,
} from '../../platform/doc-spaces.ts';
import { truncateUtf8 } from '../../platform/truncate.ts';

/**
 * Where `pnpm run manual:prepare` writes the bundled user manual. It is a build
 * artifact inside src/ (gitignored, never committed) so the same module-relative
 * path works from a checkout and from the Docker image, which copies src/ verbatim.
 */
export const BUNDLED_MANUAL_DIR = join(import.meta.dirname, '..', '..', 'manual');

const SPACE_ID_PATTERN = new RegExp(DOC_SPACE_ID_PATTERN);

export interface DocSpaceDefinition {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  /** Absolute directory the space is served from. */
  readonly root: string;
  readonly index?: string;
}

/** The manual shipped with this runtime: the docs site's Markdown, packed at build time. */
export function bundledManualSpace(root: string): DocSpaceDefinition {
  return {
    id: 'manual',
    title: '塑料碗用户手册',
    description: '塑料碗（Plastic Wan）的部署、配置与维护指南，与当前运行版本一起发布',
    root,
  };
}

interface LoadedSpace {
  readonly definition: DocSpaceDefinition;
  /** Real path of the root, so symlink containment compares resolved paths. */
  readonly root: string;
  readonly documents: number;
}

function isInsideRoot(root: string, target: string): boolean {
  return target.startsWith(`${root}${sep}`);
}

/** Filesystem-backed Local Monolith implementation of the shared document-space contract. */
export class FileSystemDocSpaces implements DocSpaces {
  readonly #loaded: readonly LoadedSpace[];
  readonly #missing: readonly string[];

  private constructor(loaded: readonly LoadedSpace[], missing: readonly string[]) {
    this.#loaded = loaded;
    this.#missing = missing;
  }

  /**
   * Loads every definition whose root exists. A root that was never installed
   * (a checkout before `pnpm run manual:prepare`) is reported through `missing`
   * instead of failing startup; a root that exists but has no index, or an
   * invalid definition, is a packaging error and throws.
   */
  static async load(definitions: readonly DocSpaceDefinition[]): Promise<FileSystemDocSpaces> {
    const loaded: LoadedSpace[] = [];
    const missing: string[] = [];
    for (const definition of definitions) {
      if (!SPACE_ID_PATTERN.test(definition.id)) {
        throw new Error(`Document space id is invalid: ${definition.id}`);
      }
      if (loaded.some((space) => space.definition.id === definition.id) || missing.includes(definition.id)) {
        throw new Error(`Duplicate document space id: ${definition.id}`);
      }
      const indexPath = definition.index ?? DOC_INDEX_PATH;
      if (resolveDocPath(indexPath).length !== 1) {
        throw new Error(`Document space ${definition.id} has an invalid index path: ${indexPath}`);
      }
      let root: string;
      try {
        root = await realpath(definition.root);
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
          missing.push(definition.id);
          continue;
        }
        throw error;
      }
      if (!(await stat(root)).isDirectory()) {
        throw new Error(`Document space root is not a directory: ${definition.root}`);
      }
      const index = join(root, indexPath);
      let indexReal: string;
      try {
        indexReal = await realpath(index);
      } catch {
        throw new Error(`Document space ${definition.id} is missing its index document: ${indexPath}`);
      }
      if (!isInsideRoot(root, indexReal) || !(await stat(indexReal)).isFile()) {
        throw new Error(`Document space ${definition.id} has an invalid index document: ${indexPath}`);
      }
      const entries = await readdir(root, { recursive: true, withFileTypes: true });
      const documents = entries.filter(
        (entry) =>
          entry.isFile() &&
          entry.name.endsWith('.md') &&
          relative(root, join(entry.parentPath, entry.name)).split(sep).join('/') !== indexPath,
      ).length;
      loaded.push({ definition, root, documents });
    }
    return new FileSystemDocSpaces(loaded, missing);
  }

  /** Installed spaces, for startup logging; `missing` lists definitions without a root. */
  get summaries(): readonly DocSpaceSummary[] {
    return this.#loaded.map((space) => ({
      id: space.definition.id,
      title: space.definition.title,
      description: space.definition.description,
      documents: space.documents,
    }));
  }

  get missing(): readonly string[] {
    return this.#missing;
  }

  // The access context is unused by bundled filesystem spaces. A per-user wiki
  // implementation resolves the conversation's own directories here, which is
  // why every method receives it instead of taking an owner id from the model.
  async spaces(_context: DocAccessContext): Promise<readonly DocSpaceSummary[]> {
    return this.summaries;
  }

  async index(_context: DocAccessContext, space: string): Promise<DocText> {
    const loaded = this.#requireSpace(space);
    return this.#readDocument(loaded, resolveDocPath(loaded.definition.index ?? DOC_INDEX_PATH));
  }

  async read(_context: DocAccessContext, space: string, path: string, base?: string): Promise<DocText> {
    const loaded = this.#requireSpace(space);
    return this.#readDocument(loaded, resolveDocPath(path, base));
  }

  #requireSpace(space: string): LoadedSpace {
    const loaded = this.#loaded.find((candidate) => candidate.definition.id === space);
    if (loaded === undefined) {
      const available = this.summaries.map((summary) => summary.id).join(', ') || 'none installed';
      throw new DocSpaceError('unknown_space', `No such document space: ${space} (available: ${available})`);
    }
    return loaded;
  }

  async #readDocument(loaded: LoadedSpace, segments: readonly string[]): Promise<DocText> {
    try {
      const file = await realpath(join(loaded.root, ...segments));
      // Symlinks that leave the space root resolve outside of it and are not readable.
      if (!isInsideRoot(loaded.root, file) || !(await stat(file)).isFile()) {
        throw new DocSpaceError('document_not_found', 'Document does not exist');
      }
      const raw = await readFile(file, 'utf8');
      const text = truncateUtf8(raw, DOC_READ_MAX_BYTES);
      return { space: loaded.definition.id, path: segments.join('/'), text, truncated: text !== raw };
    } catch (error) {
      if (error instanceof DocSpaceError) {
        throw error;
      }
      throw new DocSpaceError('document_not_found', 'Document does not exist');
    }
  }
}
