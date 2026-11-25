---
title: Client CLI (surowan-utils)
description: Install @tuuject/surowan-utils, reach the Admin API with an API key or a paired client, and learn the commands, bodies, revisions and confirmation flags.
---

# Client CLI (surowan-utils)

`@tuuject/surowan-utils` is the Admin Panel's tool client; the command is `surowan-utils`. It only reaches the running panel through the Admin API — no `serve`, `check-config`, `backup` or `configure`, and its own `doctor` runs none of the server doctor's SQLite, media, Telegram, provider or MCP probes. The server commands are in [Server CLI](service-cli.md).

The design rule is "anything the panel can do, this can do", with account, credential and API-key management as the only exceptions.

## Install

```bash
npm install -g @tuuject/surowan-utils           # dist-tag latest
npm install -g @tuuject/surowan-utils@canary    # canary builds from main
surowan-utils --help
```

- Node.js ≥ 24. The published artifact is one self-contained ESM file with no runtime dependencies, so a global install with `npm`, `pnpm`, `bun` or `yarn` needs no extra resolution.
- `latest` only moves on a maintainer-pushed stable tag. Canary builds carry versions like `0.0.0-canary.<run>.<attempt>.g<sha12>`, so trying one always means naming `@canary`.
- If the package is not on the registry yet or you need an offline install, pack it from a source checkout:

```bash
pnpm install --frozen-lockfile
pnpm --filter @tuuject/surowan-utils pack --pack-destination "$PWD/dist/npm"
npm install -g ./dist/npm/tuuject-surowan-utils-0.1.0.tgz   # file name follows the real version
```

Without a global install, run `pnpm cli:build` and then `node packages/cli/dist/bin.js …`.

## Two kinds of credential

The credential file is always `~/.config/surowan-utils/credentials.json` (the same path on every platform, unrelated to the bot's `config.jsonc` or `key.json`). It is **not encrypted** and holds exactly one credential at a time:

| Kind | How it is created | Contents | Notes |
| --- | --- | --- | --- |
| API key | `surowan-utils login --endpoint <url> --api-key <key>` | `{ endpoint, apiKey }` | Permissions follow the key's mode |
| Paired client | `surowan-utils auth pair --endpoint <url> --code pwp_…` | `{ endpoint, client_id, instance_id }` | Every request is signed with a local private key |

The last writer wins: `login` replaces a client credential and `auth pair` replaces a key credential; `login` never deletes `client-key.pem`. The old `session` field is no longer read.

File rules: on POSIX the directory is `0700` and the file `0600` (narrower is accepted); Windows does no POSIX mode check and inherits the user profile's ACL. An existing file that is a symlink, not a regular file, or too permissive is refused for both reading and writing and is **not** repaired automatically. A serialised credential above 16384 bytes is refused. Writes go through a temporary file in the same directory and a `rename`, so a failure never overwrites the previous file.

### Credential resolution order

`--endpoint` / `SUROWAN_ENDPOINT` and `--api-key` / `SUROWAN_API_KEY` both resolve as **command line, then environment, then the credential file**:

- An explicitly supplied empty value (including a whitespace-only endpoint) counts as missing and **never** falls back: `missing_endpoint`, `missing_credential`, `invalid_api_key`.
- When both the endpoint and the credential come from arguments or the environment, the credential file is not read at all — a damaged, symlinked or over-permissive file cannot block that call. Reading it happens only when one of the two is missing, and then a file problem fails with `invalid_credentials`.
- A saved key belongs to the normalised endpoint it was saved with (trimmed, trailing slash added, default port dropped). A different normalised endpoint simply will not use that key; an equal one still will.
- Plaintext `http` is allowed only on loopback (`127.0.0.0/8`, `::1`, `localhost`); remote endpoints must use `https`, and URLs may not carry credentials, a query or a fragment.

### Saving an API key

```bash
# Run by the operator in a terminal; the key only travels through stdin, never argv or shell history
printf '%s' "$SECRET_KEY" | surowan-utils login --endpoint https://panel.example.com/ --api-key-stdin --json
surowan-utils login --endpoint https://panel.example.com/ --api-key "$SECRET_KEY" --json
surowan-utils login --endpoint "$SUROWAN_ENDPOINT" --json    # the key comes from SUROWAN_API_KEY
```

`login` only writes the local file and contacts no server, so "saved" does not mean "authenticated". `--api-key-stdin` reads stdin to EOF (not just the first line), accepts at most 4098 bytes, strips exactly one trailing LF/CRLF afterwards and rejects any other newline or control character; it refuses a TTY, is bounded by `--timeout-ms`, and cannot be combined with `--api-key` or `SUROWAN_API_KEY`.

### Paired clients

```bash
surowan-utils auth init --json                                   # create or reuse client-key.pem, print the public key and fingerprint
surowan-utils auth pair --endpoint https://panel.example.com/ --code pwp_… --json
surowan-utils auth status --json
surowan-utils auth permissions --json
surowan-utils auth logout --json
```

`auth pair` claims the one-time code printed by `surowan pairing create` on the server (see [Server CLI](service-cli.md)). The client generates its own Ed25519 key pair; the private key lives as PKCS#8 PEM in `~/.config/surowan-utils/client-key.pem` under the same file rules as the credential file (regular file, no symlink, `0600`, directory `0700`, atomic write) and is **never printed, never accepted from arguments or the environment, and has no export command**. The server keeps only the public key.

Every later request carries a signature binding the `instance_id`, the HTTP method, the path and query, the body digest, a Unix-seconds timestamp and a one-time nonce. The server verifies Ed25519 and SHA-256 with WebCrypto and rejects replays against its own stored records: a timestamp outside ±300 seconds gives `signature_clock_skew`, a reused nonce gives `signature_replayed` (still rejected after a restart). The full contract is in [HTTP API conventions](http/index.md).

`auth pair` refuses to run when a credential is already saved (`already_configured`) unless you pass `--force`. `auth logout` deletes only the local `credentials.json` and `client-key.pem` and does **not** revoke the server-side identity; revoke that with `surowan clients revoke <client-id>` on the server. `auth status` exits `0` with `{"status":"not_configured",…}` when nothing is configured.

## Dedicated commands

These do not go through the generic panel command table; each has its own options and output:

| Command | What it does |
| --- | --- |
| `doctor` | One `GET /api/key` to read the mode and permissions, then one `GET /api/invocations?limit=1`; no model calls, no replay, no Telegram messages |
| `commands` | Lists every panel command (`--json` adds `method`, `path`, `revision`, `confirm`, `summary`) |
| `models list` | Configured models in the active configuration that accept text input; it contacts no provider and grants no usage right |
| `config show [--source active\|file]` | Redacted configuration view; `active` reads the running snapshot, `file` reads disk |
| `prompt get global\|group --chat <id>` | Redacted prompt plus its `content_hash` |
| `invocation list` | Audit list with `--limit`, `--offset`, `--as-of`, `--state`, `--chat`, `--model`, `--search`, `--at`, `--from`, `--to` |
| `invocation get <id>` / `prompts <id>` | One run's detail, and the two prompt layers that scene would use now |
| `invocation preflight <id>` | Free check of replayability and scene; see [Invocation preflight and replay](replay.md) |
| `invocation media <id>` | Downloads the media the snapshot authorises into a fresh temporary directory, printing a manifest with `sha256` |
| `invocation replay <id>` | A real replay: billed, and it never sends to Telegram |

On success `doctor --json` prints `{"status":"ok","endpoint":…,"credential":"api_key|client_signature","mode":…,"permissions":{…},"credential_sources":{…}}` (a signed credential also reports `client_key: "file"`); only exit code `0` means both connectivity and authentication passed.

For `invocation list`, carry the first page's `as_of` back as `--as-of` and the list stays on one snapshot while new runs only appear as `new_count`; omitting it takes the newest snapshot. With `--search` or a time filter, each item also carries `matched_messages` (the newest five, previewed to 2000 characters).

`invocation media` caps each file at 20 MiB, the whole run at 100 MiB and the count at 32; `--variant preview` downloads the server-normalised preview (meaningful only for photos and stickers).

## Generic panel commands

Every panel operation is one command; the arguments, method and path come from the same endpoint table the server uses. The generated [client CLI command catalog](cli-commands.md) lists them all with method, route, permission and confirmation:

```bash
surowan-utils harness show --json
surowan-utils chat list --json
surowan-utils commands --json
```

### The body

| Option | Effect |
| --- | --- |
| `--set key=value` | Sets a string field; keys support `a.b` nesting; setting the same key twice is `invalid_set` |
| `--set-json key=<json>` | Sets any JSON value (`null`, arrays, objects, numbers, booleans) |
| `--body <json>` | Supplies the whole body document; conflicts with `--set`/`--set-json` (`conflicting_body`) |
| `--file <path>` | Reads the whole body from a file; `--file -` reads stdin to EOF (a TTY is refused), up to 1 MiB |

`prompt save` is the exception: `--file` reads **raw Markdown** into the `prompt` field, and `--set note=…` may still accompany it.

### Revisions

Writes read the current revision before sending: configuration writes read `revision` from `GET /api/providers`, prompt writes read the scope's `content_hash`. Entry-level writes (dictionary entries, memos, group memories, `recurring-alarm update`) can only be pinned by the caller, so they require `--if-match` and otherwise fail with `if_match_required` (exit code 2).

If someone else changed the file in between, the server answers `config_conflict` or `prompt_conflict` instead of overwriting. `--if-match` is also how you pin an old snapshot for a deliberate retry.

### Confirmation and preview

- A destructive or paid command without `--yes` is refused **before any request** with `confirmation_required` (exit code 2).
- `--dry-run` sends nothing and prints `{method, path, if_match, if_match_source, body}` for review; it also satisfies the confirmation gate.
- `--yes` is a mechanical gate, not authorisation: explain the target, the count and the effect before using it.

### Writing to a file

`--output <path>` writes a binary (image, media) or text (dictionary export) response to a file and prints `{status, path, bytes}`. Using it on a command that returns JSON is refused before the request with `unexpected_option`.

### Examples

```bash
# Entry gate
surowan-utils decision-gate show --json
surowan-utils decision-gate update --set-json mode=shadow --set-json threshold=0.6 --json
surowan-utils decision-gate decisions --chat -1001234567890 --limit 20 --json
surowan-utils chat decision-gate -1001234567890 --set-json mode=shadow --json

# Recurring alarms (create, update and run need --yes: once saved they call a model unattended and past the daily budget)
surowan-utils recurring-alarm list --json
surowan-utils recurring-alarm preview --set-json 'rules=["0 9 * * 1-5"]' --set time_zone=Asia/Shanghai --json
surowan-utils recurring-alarm run 3 --yes --json

# Outbound MCP servers; describe drafts a description with the Tool Model (billed)
surowan-utils mcp-server list --json
surowan-utils mcp-server create --set alias=notes --set url=https://mcp.example.com/mcp \
  --set-json 'tools=["*"]' --set-json payload_max_bytes=65536 --set-json result_max_bytes=32768 --json
surowan-utils mcp-server describe notes --yes --json

# Sticker sets
surowan-utils sticker-set list --json
surowan-utils sticker-set update work --set note='weekday stickers' --json

# Image assets; extract only returns a proposal and writes nothing, but it does call a model
surowan-utils image asset update 42 --set-json agentVisible=true --json
surowan-utils image asset extract 42 --yes --json

# A real resume of a failed run (it will send Telegram messages)
surowan-utils invocation resume 12345 --yes --json

# Look before you leap
surowan-utils chat delete -1009876543210 --dry-run --json
surowan-utils chat delete -1009876543210 --yes --json
```

`surowan-utils commands` is the authoritative list of command names; `--help` gives the grouped overview.

## Output and exit codes

- `--json`: stdout is exactly one JSON document. Human mode prints a list summary or indented JSON.
- Failure: stderr is `{"error":"<code>","message":"<message>"}`, with both the key and the private key redacted, so no secret can appear in any output.
- Exit codes: `0` success; `1` a request, server, replay or media-download failure, or an unusable credential file; `2` invalid arguments, input or credentials (including `missing_endpoint`, `missing_credential`, `invalid_api_key`, `invalid_model_override`, `confirmation_required`, `if_match_required`).
- `--timeout-ms`: 30 seconds by default, 300 for replay. Reading stdin uses the same limit on its own. An HTTP timeout aborts the request.
- Requests follow no redirects and are **never retried**. JSON response bodies have no client-side size cap; they are read in full and then parsed, still under the timeout.
- Stdin is only used by `login --api-key-stdin`, `--file -` and replay's `--global-prompt -` / `--group-prompt -` (the two prompts cannot both come from stdin).

Insufficient permission comes back as `forbidden`. Ask the operator to change the key's mode in the panel rather than looking for a bypass; the four modes `read`, `read_write`, `read_paid` and `all` mean the same as on the [MCP server](mcp-server.md).

## Boundaries

- Account, password, passkey and API-key management are not in this CLI; only the browser panel or the server CLI can do them.
- A credential field only accepts new plaintext (the server names and stores it in the Keychain); you cannot select an existing entry, and moving a connection address requires re-entering the credential in the same request. Viewing, rotating and pruning Keychain entries happens only on the panel's **Keychain** page.
- Query output can contain private messages and prompts; do not publish it verbatim.

The companion agent skill is `skills/surowan-utils` in the repository, installed with `npx skills add tuuject/surowan --skill surowan-utils`. A harness that would rather not install the CLI can use the [MCP server](mcp-server.md) with `skills/surowan-mcp` instead.
