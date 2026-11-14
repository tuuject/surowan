import type { Stats } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { lstat, link, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { CliError } from './errors.ts';

/**
 * One read/write contract for every file the CLI keeps under
 * `~/.config/surowan-utils/`: the credential pair and the paired client's
 * private key. The file must be a regular file that group and other cannot
 * read or write, its directory must be real and private, its bytes never reach
 * an error message, and a replacement is renamed into place so a failed write
 * cannot damage the previous file.
 */
export interface PrivateFileKind {
  /** The fixed code every read-side rejection carries. */
  readonly invalidCode: string;
  /** The fixed code a failed write carries. */
  readonly writeErrorCode: string;
  /** Noun used in messages, e.g. `credentials file`; never includes file bytes. */
  readonly label: string;
}

/** Reads the file, or `undefined` when it does not exist yet. */
export async function readPrivateFile(
  path: string,
  kind: PrivateFileKind,
  maxBytes: number,
): Promise<string | undefined> {
  const info = await inspectPrivateFile(path, kind);
  if (info === undefined) {
    return undefined;
  }
  if (info.size > maxBytes) {
    throw invalid(kind, path, `${kind.label} must not exceed ${maxBytes} bytes`);
  }
  await assertPrivateDirectory(dirname(path), path, kind);
  try {
    return await readFile(path, 'utf8');
  } catch {
    throw invalid(kind, path, `${kind.label} could not be read`);
  }
}

/**
 * Writes the whole file over whatever was stored before: a freshly created
 * 0600 file renamed into place, so a failed write leaves the old file
 * byte-for-byte intact. A symlink or an over-permissive file or directory is
 * refused rather than replaced. No lock is taken: two concurrent writers are
 * last-writer-wins.
 */
export async function writePrivateFile(path: string, text: string, kind: PrivateFileKind): Promise<void> {
  const directory = dirname(path);
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await assertPrivateDirectory(directory, path, kind);
    await inspectPrivateFile(path, kind);
    const temporary = join(directory, `.${basename(path)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(text, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, path);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  } catch (error) {
    if (error instanceof CliError) {
      throw error;
    }
    // The filesystem message is dropped: it can name the temporary file, and
    // the caller only ever needs to know that the write did not happen.
    throw new CliError(kind.writeErrorCode, `${kind.label} could not be written: ${path}`);
  }
}

/**
 * Publishes the file only when nothing is there yet, and reports whether this
 * call created it. The complete content appears under the final name through a
 * hard link, which is atomic and never replaces a winner: a concurrent creator
 * gets `EEXIST`, drops its temporary file and adopts the file that won. That is
 * what keeps two simultaneous `auth pair` runs from generating different keys
 * and leaving one of them paired but no longer on disk.
 */
export async function createPrivateFile(path: string, text: string, kind: PrivateFileKind): Promise<boolean> {
  const directory = dirname(path);
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await assertPrivateDirectory(directory, path, kind);
    // Inspect first: an existing symlink or over-permissive file is refused,
    // never mistaken for "already created".
    await inspectPrivateFile(path, kind);
    const temporary = join(directory, `.${basename(path)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(text, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await link(temporary, path);
      return true;
    } catch (error) {
      if (isErrno(error, 'EEXIST')) {
        return false;
      }
      throw error;
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  } catch (error) {
    if (error instanceof CliError) {
      throw error;
    }
    // The filesystem message is dropped: it can name the temporary file, and
    // the caller only ever needs to know that the write did not happen.
    throw new CliError(kind.writeErrorCode, `${kind.label} could not be written: ${path}`);
  }
}

/** Deletes the file without following a symlink; reports whether it existed. */
export async function removePrivateFile(path: string): Promise<boolean> {
  try {
    await unlink(path);
    return true;
  } catch (error) {
    if (isErrno(error, 'ENOENT')) {
      return false;
    }
    throw new CliError('private_file_delete_failed', `file could not be deleted: ${path}`);
  }
}

/**
 * In-place inspection shared by both directions. `undefined` means nothing is
 * stored; anything that is present must be a regular file that group and other
 * cannot read or write (POSIX modes; on Windows the home ACL is inherited).
 */
async function inspectPrivateFile(path: string, kind: PrivateFileKind): Promise<Stats | undefined> {
  const info = await lstat(path).catch((error: unknown) => {
    if (isErrno(error, 'ENOENT')) {
      return undefined;
    }
    throw invalid(kind, path, `${kind.label} could not be inspected`);
  });
  if (info === undefined) {
    return undefined;
  }
  if (info.isSymbolicLink()) {
    throw invalid(kind, path, `${kind.label} must not be a symbolic link`);
  }
  if (!info.isFile()) {
    throw invalid(kind, path, `${kind.label} must be a regular file`);
  }
  if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) {
    throw invalid(kind, path, `${kind.label} permissions must be 0600 or narrower`);
  }
  return info;
}

/** The containing directory must be real (not a symlink) and not group/other accessible. */
async function assertPrivateDirectory(directory: string, path: string, kind: PrivateFileKind): Promise<void> {
  const info = await lstat(directory).catch(() => undefined);
  if (info === undefined || !info.isDirectory()) {
    throw invalid(kind, path, 'the containing directory must be a real directory');
  }
  if (info.isSymbolicLink()) {
    throw invalid(kind, path, 'the containing directory must not be a symbolic link');
  }
  if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) {
    throw invalid(kind, path, 'the containing directory permissions must be 0700 or narrower');
  }
}

function invalid(kind: PrivateFileKind, path: string, reason: string): CliError {
  return new CliError(kind.invalidCode, `${reason}: ${path}`);
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}
