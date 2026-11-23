---
title: Connect MCP servers
description: Add HTTP MCP servers in the Admin Panel, configure stdio MCP servers in config.jsonc and understand the security boundary, plus progressive exposure, skills, hot apply and per-chat bindings.
---

# Connect MCP servers

Outbound MCP lets the bot call tools on external MCP servers. A server is configured explicitly by an admin, over stdio (a command on the host) or Streamable HTTP, and the model stays inside the servers and tools allowed there.

Every call happens inside existing tool boundaries: allowlists, read-only policies, timeouts, size limits and auditing still apply, and no configuration grants the model new authority.

## Adding and managing HTTP MCP servers in the panel

Open **Bot → MCP servers**:

![MCP servers with state, progressive exposure and skills](__DOCS_BASE__/screenshots/tools/mcp-servers.en.light.png)

The page lists each server's live state (**Ready** / **Connecting** / **Degraded** / **No live state**, with an error code), a connection summary, every tool it has advertised (including those hidden by its tool selection), and **Used by**: which Chats bind it explicitly and which inherit it.

Adding a remote **Streamable HTTP** MCP server takes five steps and applies hot with no restart:

1. Choose **Add server**.
2. Fill in the connection fields:
   - **Alias**: starts with a letter and uses up to 64 letters, digits, underscores or dashes. Tools appear to the model as `alias__tool`.
   - **URL**: the server's Streamable HTTP endpoint. Credentials and `#` fragments are rejected, and redirects are always refused.
   - **Headers** (optional): add any authentication headers (such as `Authorization`), entering a new secret (stored in `key.json`), picking an existing **Keychain** entry, or referencing an external secret.
3. Configure tools and limits:
   - **Tool selection**: choose **All tools** with a default policy (**Read-only** flag and **Timeout (s)**), or **Selected tools** to list each tool and its policy explicitly.
   - **Payload limit (bytes)** (1–1048576) and **Result limit (bytes)** (1–32768).
4. Configure presentation and skills:
   - **Exposure**: **Direct** or **Progressive** (explained below). For progressive servers, write a clear **Description** (up to 1000 characters), or save first and use **Draft with tool model** once the server is **Ready**.
   - **Skills for the model**: controls whether the model may read skills published by this server (on by default).
5. Save and wait a few seconds for the state to become **Ready** and **Advertised tools** to populate. To limit which chats can use it, open **Telegram → Chats** and set **MCP servers** on each chat.

Editing and removing:

- **Edit** lets an HTTP server change its URL, headers, tool selection, limits, policies, exposure, description and skills switch. A stdio server can only change its tool selection, limits, policies, exposure, description and skills switch; its command, arguments, environment and transport stay read-only.
- **Remove** requires unbinding first: if a Chat binds the server explicitly, the error lists those Chats. Chats without an `mcp` field inherit every server, so they simply lose this source.

## Configuring stdio MCP servers

A `stdio` MCP server spawns a local child process inside Surowan's runtime environment and talks over stdin/stdout. It cannot be created from the panel form; edit `config.jsonc` directly on the server:

1. If the MCP server needs an API key or token, create a named entry on **System → Keychain** first (for example `mcp_fs_token`) so no plaintext secret sits in `config.jsonc`.
2. Add a `transport: "stdio"` entry under `mcp.servers` in `config.jsonc`:

```jsonc
{
  "mcp": {
    "servers": [
      {
        "alias": "fs",
        "transport": "stdio",
        "command": ["npx", "-y", "@modelcontextprotocol/server-filesystem", "/data/notes"],
        "env": { "LOG_LEVEL": { "jar": "mcp_fs_log" } },
        "tools": ["read_file", "list_directory"],
        "payload_max_bytes": 65536,
        "result_max_bytes": 32768,
        "tool_policies": [
          { "name": "read_file", "read_only": true, "timeout_seconds": 30 },
          { "name": "list_directory", "read_only": true, "timeout_seconds": 15 }
        ]
      }
    ]
  }
}
```

- `command` is an argv array passed straight to `spawn` (`shell: false`): no shell runs, so pipes, redirects and globs are not interpreted.
- Every `env` value is a SecretRef (such as `{ "jar": "..." }` or `{ "env": "..." }`), merged onto a restricted base environment for the child process.
- **Docker note**: the official image ships with **Node.js 24 (including `npx`) and Python 3**, and preconfigures npm's cache on the writable `/data/.npm-cache` volume, so `npx -y <package>` MCP servers work out of the box inside the container. To expose a host directory to a stdio server, bind-mount it in `docker-compose.yml` (prefer `:ro` when read-only) and pass the container path in `command`. If a server needs a runtime not bundled in the image (such as `uvx` or a custom binary), extend the official `Dockerfile` or run Surowan directly on the host.
3. Validate the file offline with `check-config`, then apply it hot from **Settings** (or `POST /api/config/apply`) without restarting. Once applied, the stdio server appears on **MCP servers**, where you can still edit its tool selection, limits, policies, exposure, description and skills switch.

## Why stdio MCP servers cannot be configured in the panel

This restriction is an intentional security boundary, not a missing form:

1. **stdio is arbitrary command execution on the host**: `command`, `args` and `env` instruct the Surowan process to spawn any binary on the server (or inside the container) with the runtime user's privileges — including access to `/config`, `/data`, the SQLite database, `key.json` and mounted volumes.
2. **Preventing privilege escalation from the admin surface and external agents**: the `/api/mcp-servers` write endpoints serve not only browser sessions, but also `read_write` / `all` API keys, paired clients and local coding agents. Allowing arbitrary `command` writes over HTTP would give any panel session or write-scoped credential (including an external agent misled by prompt injection) direct remote code execution on the host.
3. **Separation of duties**: defining or changing a stdio server's command, arguments or environment therefore requires direct shell access to edit the `0600` `config.jsonc` file on disk. The panel and API intentionally handle only safe runtime governance (tool allowlists, policies, size limits, exposure, descriptions and the skills switch), keeping stdio connection fields read-only.

## Direct and progressive exposure

Each server chooses an **exposure**:

- **Direct** (the default): every tool is handed to the model as its own `alias__tool` tool, with its full definition on every request.
- **Progressive**: the server's tools stay out of the tool list. The model sees a single `mcp` tool whose description lists every progressive server's alias, tool count and description; it then finds a tool with `mcp` `search`, reads the full description and parameters with `help`, and calls it with `call`.

Progressive exposure suits servers with many tools: all of them together occupy one slot instead of pushing dozens of definitions onto every request. The cost is one extra lookup, and the model starts out knowing only what the **description** says, so write a good one (up to 1000 characters). Without a description the model sees only a few tool names, and the **Warnings** page reports `mcp_description_missing`.

Write the description yourself, or draft it from the tools the server advertises with **Draft with tool model**. Drafting is a **billed** tool model call whose output is only a draft: it fills the input box and is stored only when you confirm and save.

Progressive exposure grants nothing extra: `mcp` can only find and call the tools this Chat could already use (per-Chat bindings still narrow the set), and calls go through the same argument validation, read-only policies, timeouts, size limits and auditing as direct tools. The audit shows two rows: the outer `mcp` call, and the `alias__tool` that actually ran.

## Skills published by a server

A server that supports the "MCP with Skills" extension can publish Skills too — documents describing how to use its tools. Every connection discovers them and verifies each file's content, size and digest; a file that fails verification is dropped without affecting the server's tools.

The model reads these documents (under `mcp-skill://`) with `read`, and only for servers this Chat can reach. **They come from an external server**: they may explain how to use that server's tools, but they can never override tool constraints or authorization rules.

Each server has a **Skills for the model** switch, on when omitted. Turning it off hides that server's Skills from the model; changing it does not reconnect the server and takes effect on the next run.

## Background connection, degradation and recovery

Startup **never** waits for a server or fails because of one: every server connects in the background, and an unreachable or invalid instance is shown as **Degraded** and retried with backoff without disturbing other servers, startup or the current apply.

Only **Ready** servers hand their tools to the model: while a server is unreachable its tools disappear from the next run's registry and come back automatically once it recovers. During that time the **Warnings** page reports `mcp_server_unavailable` (Connecting does not warn).

## Hot application and per-Chat binding

`mcp.servers` and each Chat's `mcp` are both hot-applied, with no restart: after you apply the configuration from **Settings**, or after any panel save, added servers are connected, removed ones are closed, changed ones are replaced, and untouched ones stay connected.

Changing which tools a Chat may use (removing a binding, changing the tool list or a policy, or changing a server it reaches) **stops that Chat's running invocations, rebuilds their Context and then resumes each of them once**: the model sees the current history, is told that the operator changed the MCP configuration, and receives the names of MCP tools whose outcome is unknown, so it does not repeat side effects. Merely adding servers or widening a tool list does not interrupt running conversations. Changing only the exposure or description neither reconnects a server nor interrupts anything; it applies to the next run.

Per-Chat binding lives behind the **MCP servers** entry on each row of the **Chats** page:

- **Inherit everything** (no `mcp` field): every server, with its own settings.
- **Off** (an empty array): this Chat has no MCP tools at all.
- **Explicit binding**: pick servers and narrow their tools, optionally giving a tool its own read-only policy and timeout in this Chat.

A binding only narrows; it never changes the connection. Command, URL, environment and headers stay with the server, so two connections mean two aliases. Playground rooms never have MCP tools.

Fields are in [External MCP settings](../configuration/mcp.md) and the [`mcp` field reference](../configuration/fields-mcp.md), and the per-Chat shape is in [Telegram settings](../configuration/telegram.md) and the [`telegram` field reference](../configuration/fields-telegram.md).

## Read-only documentation versus external tools

"Extensions" has strict boundaries here; do not mix them up:

- **System Skills** are **read-only** Markdown documentation shipped with the release. The system prompt carries only the index; the model reads `system:///skills/<name>/SKILL.md` with `read` and then calls internal capabilities through `execute`. A Skill is a manual, not a permission file: it cannot bypass tool schemas, reference validation, allowlists, budgets or send rules.
- **Built-in plugins** (page fetching, web search and its seven providers, image generation, alarms, the dictionary) are compiled into the release. Configuration is the only way to enable or tune them, and they may declare dependencies and extension points, but there is no plugin marketplace.
- **Outbound MCP** is the only external tool source an admin can add, and it must be configured explicitly, then passes through allowlists, read-only policies, timeouts and size limits.
- There is currently **no** way to upload a Skill, hot-install a plugin or reach a third-party marketplace.

## Common mistakes

- Progressive exposure changes discovery, not permissions.
- "The model saw the tool name" is not "the call succeeded": check **Tool sessions** for the call and its result.

Related pages: [External MCP settings](../configuration/mcp.md), [Web search and page fetching](web-search.md), [Set boundaries per chat and topic](chats.md), [Troubleshoot startup failures and silence](troubleshooting.md).
