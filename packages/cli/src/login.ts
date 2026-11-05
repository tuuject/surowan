import { Buffer } from 'node:buffer';
import { CliError, usageError } from './errors.ts';

/** Reads a piped API key; the only credential the CLI accepts. */
export async function readLoginKey(timeoutMs: number): Promise<string> {
  if (process.stdin.isTTY === true) {
    throw usageError('stdin_required', '--api-key-stdin requires a piped API key, not a terminal');
  }
  const timer = setTimeout(() => {
    process.stdin.destroy(new CliError('timeout', `stdin timed out after ${timeoutMs}ms; no credentials were saved`));
  }, timeoutMs);
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of process.stdin) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      total += buffer.byteLength;
      // Permit the usual trailing CRLF without increasing the 4 KiB key cap.
      if (total > 4_098) {
        process.stdin.destroy();
        throw usageError('invalid_api_key', 'API key input exceeds 4 KiB');
      }
      chunks.push(buffer);
    }
    return Buffer.concat(chunks)
      .toString('utf8')
      .replace(/\r?\n$/, '');
  } finally {
    clearTimeout(timer);
  }
}
