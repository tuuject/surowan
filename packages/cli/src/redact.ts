import type { CliIo } from './commands.ts';

/**
 * The credential must never appear in output, even if a server echoes it back.
 * Also used for files the CLI persists (the media manifest), so stdout, stderr
 * and on-disk metadata share one redaction contract.
 */
export function redactSecrets(text: string, secrets: readonly (string | undefined)[]): string {
  let redacted = text;
  for (const secret of secrets) {
    if (secret === undefined || secret.length === 0) {
      continue;
    }
    // Replace the JSON-escaped form first: inside a JSON document that is the
    // form actually written, and an escaped match cannot cut through a
    // structural quote (a raw match on a key ending in `\` can).
    const escaped = JSON.stringify(secret).slice(1, -1);
    if (escaped !== secret) {
      redacted = redacted.split(escaped).join('[redacted]');
    }
    redacted = redacted.split(secret).join('[redacted]');
  }
  return redacted;
}

/** Redact JSON string tokens without touching structural quotes, braces or numbers. */
export function redactingIo(io: CliIo, secrets: readonly (string | undefined)[], jsonOutput: boolean): CliIo {
  return {
    stdout: (text) =>
      io.stdout(
        jsonOutput
          ? text.replace(/"(?:\\.|[^"\\])*"/g, (token) =>
              JSON.stringify(redactSecrets(JSON.parse(token) as string, secrets)),
            )
          : redactSecrets(text, secrets),
      ),
    stderr: (text) => io.stderr(redactSecrets(text, secrets)),
  };
}
