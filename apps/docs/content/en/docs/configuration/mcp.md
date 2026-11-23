---
title: External MCP settings
description: Outbound MCP transports, tool allow lists and policies, size limits, direct versus progressive exposure, skills, background connection and degraded state, hot application and per-chat narrowing.
---

# External MCP settings

`mcp.servers` lets Surowan connect to external servers as an MCP client and hand their tools to the model; `telegram.chats[].mcp` then narrows one server's tools down to a single group. MCP is Telegram-only: the Playground execution profile has no MCP, so a configured server never appears in a room.

These are **outbound** servers — Surowan connecting out. Surowan acting as an MCP server for someone else is a separate topic; see [Server CLI](../developer/service-cli.md) and [MCP server](../developer/mcp-server.md).

## How it takes effect

The whole `mcp` section and every chat binding are hot, and connecting **never blocks startup**:

- Each server handshakes in the background after boot. A failure only marks it `degraded` (the panel shows **Unavailable**) and reconnects on a backoff that starts at 1 second, doubles, and caps at 60 seconds. `serve` reaches the scheduler and the panel even when every endpoint black-holes.
- Once connected and discovered, the state is `ready` (the panel shows **Ready**). A `degraded` or still-connecting server offers **no tools and no skills** to a new Invocation; the first Invocation after recovery gets them back.
- While a server is unavailable the panel carries a standing `mcp_server_unavailable` warning. Writing `required` adds `mcp_required_deprecated`, and a progressive server without a `description` adds `mcp_description_missing`.

What a change does depends on which kind it is:

1. **Pure addition** (a new server, a wider binding, one more server for a chat): no context is touched; the next Invocation simply resolves the larger tool set.
2. **Narrowing or replacement** (a server leaves the configuration, a binding tightens, a server a chat uses changes any connection/tool/limit/policy field, or its env/headers secrets rotate): a cutover runs — affected conversations are fenced, running Invocations are aborted, their canonical Contexts are rebuilt, instances are swapped, and one continuation is queued for each aborted run that was still answering. A tool set is part of the Conversation Context, and continuing a context across two different tool worlds would corrupt it.
3. **Presentation only** (`exposure`, `description`, `skills`): no reconnect, no interruption; the next Invocation reads the new values. They decide how the same tools are shown, never what a chat may call.

The panel can add, edit and remove servers over HTTP. For a stdio server the connection fields (command, arguments, environment) are read-only there — they exist only in the configuration file.

## Transports

### stdio

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

- `command` is an argv array: the first item is the program, spawned directly with `shell: false`. No shell means no quoting puzzles, and also no pipes or globs.
- `env` values are SecretRefs, merged over a default environment for the child process.
- Here `payload_max_bytes` bounds the transport's read buffer for one incoming message.
- Because `command` executes an arbitrary binary on the host (or inside the container), the panel and HTTP API intentionally refuse to create or change stdio connection fields; edit `config.jsonc` directly on the server. See [Configuring stdio MCP servers](../guides/mcp.md#configuring-stdio-mcp-servers) for the walkthrough, Docker notes and security rationale.

### Streamable HTTP

```jsonc
{
  "mcp": {
    "servers": [
      {
        "alias": "issues",
        "transport": "streamable_http",
        "url": "https://mcp.example.com/mcp",
        "follow_redirects": false,
        "headers": { "Authorization": { "jar": "mcp_issues_token" } },
        "tools": "*",
        "payload_max_bytes": 32768,
        "result_max_bytes": 32768,
        "default_tool_policy": { "read_only": false, "timeout_seconds": 60 }
      }
    ]
  }
}
```

- `url` must be an HTTP(S) address without a user name, password or `#` fragment; a query string is allowed.
- `follow_redirects` must be written as `false`. It is a constant field, not a setting: any 3xx response is rejected at runtime and the server drops to `degraded` with `redirect_rejected`, which keeps a redirect from carrying the request somewhere else.
- `headers` values are SecretRefs — the right place for a token.
- Here `payload_max_bytes` bounds both the outgoing request body and the incoming response body; exceeding it sets `payload_limit` and degrades the server.

## Tool allow lists and policies

| Field | Meaning |
| --- | --- |
| `tools` | `"*"` exposes every tool the server advertises; an array exposes only the names listed. |
| `tool_policies[]` | Per-tool policy: `name`, `read_only`, `timeout_seconds` (seconds, greater than zero). |
| `default_tool_policy` | The fallback policy for the wildcard case; only `read_only` and `timeout_seconds`. It also serves as the fallback for per-chat bindings. |

Rules checked at load time, not at runtime:

- `tools: "*"` requires `default_tool_policy`. Without it no tool would have a usable read-only flag and timeout, so the configuration is refused.
- With an explicit `tools` array, **every** listed tool needs its own `tool_policies` entry. `default_tool_policy` exists for the wildcard case and does not stand in for a missing entry on an explicit list. A policy also may not name a tool outside the list.
- These fail the connection for that alias (it lands in `degraded`) instead of quietly exposing less: a duplicate tool name from the server, a configured tool the server does not advertise, an exposed name longer than 128 characters or containing anything outside `[A-Za-z0-9_-]`, and a tool that declares it must run as a task.
- The model sees a tool as `<alias>__<tool>`, for example `issues__create_issue`.

`read_only` is audit and retry semantics, not permission: a call with `false` is recorded as side-effecting and is never retried as if it were safe, while a read-only call that hits a transient transport error is retried once.

## Limits

| Limit | Value | What happens |
| --- | --- | --- |
| `payload_max_bytes` | 1–1,048,576 | See the two transports above; exceeding it degrades the server with `payload_limit`. |
| `result_max_bytes` | 1–32,768 | The tool result is truncated before the model sees it, ending in `[tool result truncated]`. |
| Tool arguments | fixed 32,768 bytes | The call is refused (`arguments_too_large`) and nothing is sent. |
| Tools per set | fixed 61, `mcp` gateway included | Applying a configuration whose per-chat set exceeds it fails. |
| Images in results | 20 MiB each | Converted to attachments; a failure leaves a note instead of sending pixels. |

Timeouts use the smaller of `timeout_seconds` and the Invocation's remaining time. Tool discovery has its own 30-second bound.

## Exposure and description

`exposure` decides how the same tools reach the model:

| Value | Behaviour |
| --- | --- |
| `direct` (default) | Every tool is a registry tool named `<alias>__<tool>`, and its full definition is sent with every request. |
| `progressive` | The tools stay out of the registry. The model sees only the single `mcp` gateway tool and discovers and calls them on demand with its `search`, `help` and `call` actions, inside the set this chat is already allowed. |

Progressive exposure suits a server with many tools: direct exposure pays for every definition on every request, and the set is capped at 61 tools. What the gateway does:

- Its description lists the alias, the `description` and the tool count. `description` is written for the model — what this server can help with — up to 1,000 characters; the panel can draft one with the tool model (**billed**) and you confirm it before saving.
- Without a `description`, the gateway shows the first 8 tool names of that server and `mcp_description_missing` is raised.
- `search` returns at most 10 matches, `help` returns one tool's description and parameter schema, and `call` goes through the same policies, timeout, result conversion and audit; `tool_calls` still records `<alias>__<tool>`.

Exposure never changes authorization: each tool of a progressive server is still bound by that server's `tools`, its policies and this chat's binding.

## Skills

`skills` decides whether the model may read the skills this server publishes:

- **Omitted means enabled**; `false` disables it. Tools keep working either way; `read` just stops offering `mcp-skill://<alias>/<skill>/<path>`.
- Discovery happens on every connect: the server must advertise the `io.modelcontextprotocol/skills` extension and provide `resources/read`, otherwise it simply has no skills and `skills_error` says why.
- Every file must match the digest and size in the manifest and stay inside the skill's own root: 32 KiB per file, 64 files per skill, 32 skills per server, 1 MiB in total. One bad skill is dropped on its own and never costs the connection its tools.
- Skill text is external data, untrusted, and cannot override tool constraints or authorization rules.

## Relation to per-chat bindings

`telegram.chats[].mcp` only **narrows**; it never duplicates connection settings:

- A chat without `mcp` inherits every server (the behaviour before bindings existed); `mcp: []` gives it none.
- A binding's `server` must name a configured alias, `tools` may only select tools that server exposes, and every selected tool must resolve a policy (the binding's own override, then the server's entry, then the server's default policy). A `tools: "*"` binding cannot be checked offline; discovery verifies it after connecting.
- Connection settings (command, URL, env, headers) stay on the server. If you need a different connection, configure another alias instead of overriding it per chat.

```jsonc
{
  "mcp": {
    "servers": [
      {
        "alias": "issues",
        "transport": "streamable_http",
        "url": "https://mcp.example.com/mcp",
        "follow_redirects": false,
        "headers": { "Authorization": { "jar": "mcp_issues_token" } },
        "tools": ["search", "create_issue"],
        "payload_max_bytes": 32768,
        "result_max_bytes": 16384,
        "default_tool_policy": { "read_only": true, "timeout_seconds": 30 },
        "tool_policies": [
          { "name": "search", "read_only": true, "timeout_seconds": 30 },
          { "name": "create_issue", "read_only": false, "timeout_seconds": 60 }
        ],
        "exposure": "progressive",
        "description": "Team issue tracking: search existing tickets by keyword, or open a ticket in a given project"
      }
    ]
  },
  "telegram": {
    "chats": [
      {
        "id": -1001234567890,
        "mcp": [
          {
            "server": "issues",
            "tools": ["search"],
            "tool_policies": [
              { "name": "search", "read_only": true, "timeout_seconds": 15 }
            ]
          }
        ]
      }
    ]
  }
}
```

This gives `issues` progressive exposure and a description, then lets `-1001234567890` reach only `search` with a tighter 15-second timeout. Every other chat that writes no `mcp` still gets both `search` and `create_issue`.

## Deprecated: `required`

`mcp.servers[].required` is still accepted by the schema but has **no effect**: startup neither waits for nor fails on MCP any more. Writing it raises `mcp_required_deprecated` and the field should be deleted. It is also excluded from the "did this server change" comparison, so adding or removing just that field never reconnects and never affects a chat.

## Interactions

- The server page, per-chat bindings and troubleshooting: [Connect MCP servers](../guides/mcp.md) and [Set boundaries per chat and topic](../guides/chats.md).
- Secret references and Keychain rotation: [Secrets and paths](secrets.md).
- The full chat field list: [Telegram settings](telegram.md).

Types and ranges: [MCP field reference](fields-mcp.md).
